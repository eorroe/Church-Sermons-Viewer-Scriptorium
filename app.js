const REPO_OWNER = 'eorroe';
const REPO_NAME = 'Church-Sermons-Viewer-Scriptorium';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const TREES_API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PINNED_KEY = 'scriptorium-pinned';
const PINNED_ORDER_KEY = 'scriptorium-pinned-order';
const RECENTS_KEY = 'scriptorium-recents';
const MAX_RECENTS = 20;

const REPO_TREE_CACHE_KEY = 'repo-tree';
const CHURCH_LIST_CACHE_KEY = 'church-list';
const SERMON_INDEX_CACHE_KEY = 'sermon-index';
const QUOTES_CACHE_KEY = 'quotes';

let currentPath = '';
let selectedItem = null;
let isLoading = false;
let db = null;
let currentFiles = [];
let rootSermonSearch = '';
let searchBody = false;
let currentQuote = '';
let selectedRecentPath = '';

const isOnline = () => navigator.onLine;

const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
};

const elements = {
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    mainContent: document.getElementById('main-content'),
    breadcrumb: document.getElementById('breadcrumb'),
    breadcrumbPath: document.getElementById('breadcrumb-path'),
    breadcrumbHome: document.getElementById('breadcrumb-home'),
    breadcrumbChurch: document.getElementById('breadcrumb-church'),
    breadcrumbPathSeparator: document.getElementById('breadcrumb-path-separator'),
    retryBtn: document.getElementById('retry-btn')
};

const openCacheDb = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('scriptorium-cache', 1);
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains('cache')) {
                database.createObjectStore('cache', { keyPath: 'key' });
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
};

const getCachedItem = async (key) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['cache'], 'readonly');
        const store = transaction.objectStore('cache');
        const request = store.get(key);
        request.onsuccess = () => {
            const result = request.result;
            if (!result) {
                resolve(null);
                return;
            }
            if (!isOnline()) {
                resolve(result.value);
                return;
            }
            const age = Date.now() - (result.timestamp || 0);
            if (age > CACHE_TTL_MS) {
                resolve(null);
                return;
            }
            resolve(result.value);
        };
        request.onerror = () => reject(request.error);
    });
};

const setCachedItem = async (key, value) => {
    if (!db) return;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['cache'], 'readwrite');
        const store = transaction.objectStore('cache');
        const request = store.put({ key, value, timestamp: Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
};

const isMarkdownFile = (name) => typeof name === 'string' && name.toLowerCase().endsWith('.md');

const getDisplayName = (name) => {
    if (typeof name !== 'string') return name;
    const lower = name.toLowerCase();
    if (lower.endsWith('.md')) {
        return name.slice(0, -3);
    }
    return name;
};

const fuzzyMatch = (query, text) => {
    if (!query) return true;
    const lowerQuery = query.toLowerCase();
    const lowerText = text.toLowerCase();

    if (lowerText.includes(lowerQuery)) return true;

    let queryIndex = 0;
    for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
        if (lowerText[i] === lowerQuery[queryIndex]) {
            queryIndex++;
        }
    }
    return queryIndex === lowerQuery.length;
};

const renderSearchInput = (placeholder, id) => {
    return `
        <div class="search-container">
            <div class="search-input-wrapper">
                <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input type="text" class="search-input" id="${id}" placeholder="${placeholder}" autocomplete="off">
            </div>
            <button id="${id}-body-toggle" class="search-toggle-btn hidden" data-search-id="${id}">Searching Titles Only</button>
        </div>
    `;
};

const filterFiles = (query) => {
    if (!query) return currentFiles;
    return currentFiles.filter(file => fuzzyMatch(query, getDisplayName(file.name)));
};

const searchInBodies = async (query, files) => {
    if (!query || files.length === 0) return files;
    const lowerQuery = query.toLowerCase();
    const bodies = await Promise.all(files.map(async (file) => {
        try {
            return await fetchFileContent(file.path);
        } catch {
            return '';
        }
    }));
    return files.filter((file, i) => {
        const body = (bodies[i] || '').toLowerCase();
        return body.includes(lowerQuery);
    });
};

const renderFileButtons = (files, path) => {
    return files.map(file => {
        const subpath = file.subpath ? file.subpath + '/' : '';
        const filePath = path ? `${path}/${subpath}${file.name}` : file.name;
        return `
            <button class="folder-btn fade-in" data-path="${filePath}" data-type="file">
                <span>${escapeHtml(getDisplayName(file.name))}</span>
            </button>
        `;
    }).join('');
};

const BIBLE_BOOKS = [
    'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy',
    'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel', '1 Kings', '2 Kings',
    '1 Chronicles', '2 Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job',
    'Psalms', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Isaiah',
    'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
    'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai',
    'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans',
    '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians',
    'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy',
    'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter', '1 John',
    '2 John', '3 John', 'Jude', 'Revelation'
].sort((a, b) => b.length - a.length);

const ESCAPED_BOOKS = BIBLE_BOOKS.map((book) =>
    book.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
);

const REFERENCE_PATTERN = new RegExp(
    '\\b(?:' + ESCAPED_BOOKS.join('|') + ')\\s+\\d+(?::\\d+)?(?:[\\-–—]\\d+)?\\b',
    'gi'
);

const buildBibleRefUrl = (reference) => {
    const cleaned = reference.replace(/^[.,;:!?'")\]]+|[.,;:!?'")\]]+$/g, '').trim();
    const normalized = cleaned.replace(/[–—]/g, '-');
    const match = normalized.match(/^(.+?)\s+(\d+)(?::(\d+))?(?:-(\d+))?$/);
    if (!match) {
        console.log('buildBibleRefUrl failed to parse:', { reference, cleaned, normalized });
        return null;
    }

    const [, book, chapter, verseStart, verseEnd] = match;
    const bookSlug = book.trim().replace(/\s+/g, '-');
    const chapterNum = chapter;

    if (verseStart && verseEnd) {
        const search = book.trim().replace(/\s+/g, '_') + '_' + chapterNum + ':' + verseStart + '-' + verseEnd;
        return 'https://www.bibleref.com/biblepassage/?search=' + encodeURIComponent(search);
    }

    if (verseStart) {
        return 'https://www.bibleref.com/' + encodeURIComponent(bookSlug) + '/' + chapterNum + '/' + encodeURIComponent(bookSlug + '-' + chapterNum + '-' + verseStart) + '.html';
    }

    if (verseEnd) {
        const search = book.trim().replace(/\s+/g, '_') + '_' + chapterNum + '-' + verseEnd;
        return 'https://www.bibleref.com/biblepassage/?search=' + encodeURIComponent(search);
    }

    return 'https://www.bibleref.com/' + encodeURIComponent(bookSlug) + '/' + chapterNum + '/' + encodeURIComponent(bookSlug + '-chapter-' + chapterNum) + '.html';
};

const linkifyBiblicalReferences = (text) => {
    return text.replace(REFERENCE_PATTERN, (match) => {
        const url = buildBibleRefUrl(match);
        if (url) {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="bibleref-link">' + match + '</a>';
        }
        return match;
    });
};

const getFolderIcon = () => {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
};

const getDragHandleIcon = () => {
    return `<svg class="drag-handle" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="6" r="2"/><circle cx="15" cy="6" r="2"/>
        <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
        <circle cx="9" cy="18" r="2"/><circle cx="15" cy="18" r="2"/>
    </svg>`;
};

const getFilterIcon = () => {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;
};

const getDisabledChurches = () => {
    try {
        const stored = localStorage.getItem('disabledChurches');
        if (stored) {
            return new Set(JSON.parse(stored));
        }
    } catch (e) {
        console.error('Failed to read disabled churches:', e);
    }
    return null;
};

const saveDisabledChurches = (disabledSet) => {
    try {
        if (disabledSet === null || disabledSet.size === 0) {
            localStorage.removeItem('disabledChurches');
        } else {
            localStorage.setItem('disabledChurches', JSON.stringify([...disabledSet]));
        }
    } catch (e) {
        console.error('Failed to save disabled churches:', e);
    }
};

const getPinnedSermons = () => {
    try {
        const stored = localStorage.getItem(PINNED_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to read pinned sermons:', e);
        return [];
    }
};

const savePinnedSermons = (sermons) => {
    try {
        localStorage.setItem(PINNED_KEY, JSON.stringify(sermons));
    } catch (e) {
        console.error('Failed to save pinned sermons:', e);
    }
};

const getPinnedOrder = () => {
    try {
        const stored = localStorage.getItem(PINNED_ORDER_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to read pinned order:', e);
        return [];
    }
};

const savePinnedOrder = (order) => {
    try {
        localStorage.setItem(PINNED_ORDER_KEY, JSON.stringify(order));
    } catch (e) {
        console.error('Failed to save pinned order:', e);
    }
};

const isPinned = (sermonPath) => {
    const pinned = getPinnedSermons();
    return pinned.some(s => s.path === sermonPath);
};

const addPinnedSermon = (sermon) => {
    const pinned = getPinnedSermons();
    if (!pinned.some(s => s.path === sermon.path)) {
        pinned.push(sermon);
        savePinnedSermons(pinned);
        const order = getPinnedOrder();
        if (!order.includes(sermon.path)) {
            order.push(sermon.path);
            savePinnedOrder(order);
        }
    }
};

const removePinnedSermon = (sermonPath) => {
    let pinned = getPinnedSermons();
    pinned = pinned.filter(s => s.path !== sermonPath);
    savePinnedSermons(pinned);
    let order = getPinnedOrder();
    order = order.filter(p => p !== sermonPath);
    savePinnedOrder(order);
};

const getRecents = () => {
    try {
        const stored = localStorage.getItem(RECENTS_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to read recents:', e);
        return [];
    }
};

const saveRecents = (recents) => {
    try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    } catch (e) {
        console.error('Failed to save recents:', e);
    }
};

const addRecent = (sermon) => {
    let recents = getRecents();
    recents = recents.filter(r => r.path !== sermon.path);
    recents.unshift(sermon);
    if (recents.length > MAX_RECENTS) {
        recents = recents.slice(0, MAX_RECENTS);
    }
    saveRecents(recents);
};

const removeRecent = (sermonPath) => {
    let recents = getRecents();
    recents = recents.filter(r => r.path !== sermonPath);
    saveRecents(recents);
};

const isChurchDisabled = (churchName) => {
    const disabled = getDisabledChurches();
    return disabled === null ? false : disabled.has(churchName);
};

const showLoading = () => {
    elements.loading.classList.remove('hidden');
    elements.error.classList.add('hidden');
    elements.mainContent.innerHTML = '';
};

const hideLoading = () => {
    elements.loading.classList.add('hidden');
};

const showError = (message) => {
    elements.loading.classList.add('hidden');
    elements.error.classList.remove('hidden');
    elements.error.querySelector('p').textContent = message;
};

const hideError = () => {
    elements.error.classList.add('hidden');
};

const hideFilterHint = () => {
    const filterHint = document.getElementById('filter-hint');
    if (filterHint) filterHint.classList.add('hidden');
};

const enterSubView = (path) => {
    currentPath = path;
    renderBreadcrumb(path);
    hideFilterHint();
};

const renderBreadcrumb = (path) => {
    if (path) {
        elements.breadcrumb.classList.remove('hidden');

        const segments = path.split('/');
        const churchName = segments[0];
        const restOfPath = segments.slice(1).join('/');

        elements.breadcrumbChurch.textContent = churchName;
        elements.breadcrumbChurch.classList.remove('hidden');

        if (restOfPath) {
            elements.breadcrumbPathSeparator.classList.remove('hidden');
            elements.breadcrumbPath.textContent = '/ ' + restOfPath;
        } else {
            elements.breadcrumbPathSeparator.classList.add('hidden');
            elements.breadcrumbPath.textContent = '';
        }
    } else {
        elements.breadcrumb.classList.add('hidden');
    }
};

const renderFolders = (folders, path) => {
    if (folders.length === 0) return '';

    const disabled = getDisabledChurches();
    const filteredFolders = folders.filter(folder => {
        if (disabled === null) return true;
        return !disabled.has(folder.name);
    });

    const folderHtml = filteredFolders.map(folder => {
        const folderPath = path ? `${path}/${folder.name}` : folder.name;
        return `
            <button class="folder-btn fade-in" data-path="${folderPath}" data-type="folder">
                ${getFolderIcon()}
                <span>${escapeHtml(folder.name)}</span>
            </button>
        `;
    }).join('');

    const query = rootSermonSearch || '';
    const baseFiltered = query ? filterFiles(query) : currentFiles;
    const filteredFiles = disabled === null ? baseFiltered : baseFiltered.filter(file => {
        const church = file.church || (file.subpath ? file.subpath.split('/')[0] : '');
        return !disabled.has(church);
    });
    const sermonHtml = filteredFiles.map(file => {
        const prefix = file.church ? `${file.church}/` : '';
        const subpathPart = file.subpath ? `${file.subpath}/` : '';
        const filePath = `${prefix}${subpathPart}${file.name}`;
        const churchLabel = file.church || (file.subpath ? file.subpath.split('/')[0] : '');
        return `
            <button class="folder-btn fade-in" data-path="${escapeHtml(filePath)}" data-type="file">
                <span>${escapeHtml(getDisplayName(file.name))}${churchLabel ? ' <span style="opacity:0.6;font-size:0.85em">(' + escapeHtml(churchLabel) + ')</span>' : ''}</span>
            </button>
        `;
    }).join('');

    const showSermons = query.trim().length > 0;

    return `
        <div class="mb-8">
            <div class="flex justify-between items-center mb-4 border-b border-[#c5a059]/30 pb-2">
                <div class="flex items-center gap-2">
                    <button id="filter-churches-btn" class="filter-btn" title="Filter Churches / Sources">
                        ${getFilterIcon()}
                        <span class="filter-btn-text">Filter Sources</span>
                    </button>
                    <h2 class="font-['Cinzel'] text-xl text-[#7e2217]">Select Church / Source</h2>
                </div>
                <button id="check-new-church-btn" class="check-new-btn">Check For New Church</button>
            </div>
            ${renderSearchInput('Search all sermons...', 'root-sermon-search')}
            <div id="church-list-container" class="church-list flex flex-col gap-2 ${showSermons ? 'hidden' : ''}">
                ${folderHtml || '<p class="text-[#7e2217] italic">No churches match your filter.</p>'}
            </div>
            <div id="sermon-list-container" class="church-list flex flex-col gap-2 ${showSermons ? '' : 'hidden'}">
                ${sermonHtml || '<p class="text-[#7e2217] italic">No matching sermons found.</p>'}
            </div>
        </div>
    `;
};

const renderFiles = (files, path) => {
    const markdownFiles = files.filter((file) => isMarkdownFile(file.name));
    currentFiles = markdownFiles;

    if (markdownFiles.length === 0) {
        return `
            <div class="empty-state">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <h2>No Sermons Found</h2>
                <p>This directory contains no markdown files.</p>
            </div>
        `;
    }

    const fileHtml = markdownFiles.map(file => {
        const subpath = file.subpath ? file.subpath + '/' : '';
        const filePath = path ? `${path}/${subpath}${file.name}` : file.name;
        return `
            <button class="folder-btn fade-in" data-path="${filePath}" data-type="file">
                <span>${escapeHtml(getDisplayName(file.name))}</span>
            </button>
        `;
    }).join('');

    return `
        <div class="mb-8">
            <div class="flex justify-between items-center mb-4 border-b border-[#c5a059]/30 pb-2">
                <h2 class="font-['Cinzel'] text-xl text-[#7e2217]">Select Sermon</h2>
                <button id="check-new-sermons-btn" class="check-new-btn">Check For New Sermons</button>
            </div>
            ${renderSearchInput('Search sermons...', 'sermon-search')}
            <div id="sermon-list-container" class="church-list flex flex-col gap-2">
                ${fileHtml}
            </div>
        </div>
    `;
};

const renderMarkdown = (content) => {
    let html = marked.parse(content, { breaks: true, gfm: true });
    html = html.replace(/<a\s+([^>]*?)>/gi, (match, attrs) => {
        if (/\btarget=/.test(attrs)) return match;
        return `<a ${attrs} target="_blank" rel="noopener noreferrer">`;
    });
    const linkedHtml = linkifyBiblicalReferences(html);
    return `
        <div class="markdown-body fade-in">
            ${linkedHtml}
        </div>
    `;
};

const renderEmptyState = (message) => {
    return `
        <div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <h2>Scriptorium</h2>
            <p>${message}</p>
        </div>
    `;
};

const renderPinnedPanel = (forceRender = true) => {
    const pinnedList = document.getElementById('pinned-list');
    const pinnedEmpty = document.getElementById('pinned-empty');
    if (!pinnedList) return;

    const pinned = getPinnedSermons();

    if (pinned.length === 0) {
        pinnedList.innerHTML = '<p id="pinned-empty" class="text-sm text-[#7e2217]/50 italic text-center py-4">No pinned sermons yet</p>';
        return;
    }

    pinnedList.innerHTML = pinned.map(sermon => {
        const title = getDisplayName(sermon.name);
        return `
            <div class="pinned-item" data-path="${escapeHtml(sermon.path)}" draggable="true">
                <div class="drag-handle" title="Drag to reorder">
                    <div class="drag-handle-dot">
                        <span></span><span></span>
                        <span></span><span></span>
                        <span></span><span></span>
                    </div>
                </div>
                <span class="pinned-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                <button class="unpin-btn" data-path="${escapeHtml(sermon.path)}" title="Unpin">&times;</button>
            </div>
        `;
    }).join('');

    if (forceRender) {
        initPinnedDragAndDrop();
    }
};

const renderRecentsPanel = (forceRender = true) => {
    const recentsList = document.getElementById('recents-list');
    const recentsEmpty = document.getElementById('recents-empty');
    const moveToTopBtn = document.getElementById('move-to-top-btn');
    if (!recentsList) return;

    const recents = getRecents();
    
    if (recents.length === 0) {
        recentsList.innerHTML = '<p id="recents-empty" class="text-sm text-[#7e2217]/50 italic text-center py-4">No recent sermons yet</p>';
        if (moveToTopBtn) moveToTopBtn.classList.add('hidden');
        return;
    }
    
    if (moveToTopBtn) {
        moveToTopBtn.classList.remove('hidden');
    }
    
    recentsList.innerHTML = recents.map(sermon => {
        const title = getDisplayName(sermon.name);
        const isSelected = sermon.path === selectedRecentPath;
        return `
            <div class="recent-item${isSelected ? ' selected' : ''}" data-path="${escapeHtml(sermon.path)}">
                <span class="recent-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                <button class="remove-recent-btn" data-path="${escapeHtml(sermon.path)}" title="Remove">&times;</button>
            </div>
        `;
    }).join('');
    
    if (moveToTopBtn && selectedRecentPath) {
        const selectedIndex = recents.findIndex(r => r.path === selectedRecentPath);
        if (selectedIndex <= 0) {
            moveToTopBtn.classList.add('hidden');
        } else {
            moveToTopBtn.classList.remove('hidden');
        }
    }
};

const switchSidebarTab = (tabName) => {
    const recentsPanel = document.getElementById('recents-panel');
    const pinnedPanel = document.getElementById('pinned-panel');
    const tabRecents = document.getElementById('tab-recents');
    const tabPinned = document.getElementById('tab-pinned');
    
    if (tabName === 'recents') {
        recentsPanel?.classList.add('active');
        pinnedPanel?.classList.remove('active');
        tabRecents?.classList.add('active');
        tabRecents?.classList.remove('text-[#7e2217]/60');
        tabPinned?.classList.remove('active');
        tabPinned?.classList.add('text-[#7e2217]/60');
    } else if (tabName === 'pinned') {
        recentsPanel?.classList.remove('active');
        pinnedPanel?.classList.add('active');
        tabPinned?.classList.add('active');
        tabPinned?.classList.remove('text-[#7e2217]/60');
        tabRecents?.classList.remove('active');
        tabRecents?.classList.add('text-[#7e2217]/60');
    }
};

const switchMobileTab = (tabName) => {
    const sidebar = document.getElementById('sidebar');
    const contentContainer = document.getElementById('content-container');
    const mobileTabSources = document.getElementById('mobile-tab-sources');
    const mobileTabRecents = document.getElementById('mobile-tab-recents');
    const mobileTabPinned = document.getElementById('mobile-tab-pinned');
    const recentsPanel = document.getElementById('recents-panel');
    const pinnedPanel = document.getElementById('pinned-panel');

    if (tabName === 'sources') {
        sidebar?.classList.add('hidden');
        contentContainer?.classList.remove('hidden');
        mobileTabSources?.classList.add('active');
        mobileTabSources?.classList.remove('text-[#7e2217]/60');
        mobileTabRecents?.classList.remove('active');
        mobileTabRecents?.classList.add('text-[#7e2217]/60');
        mobileTabPinned?.classList.remove('active');
        mobileTabPinned?.classList.add('text-[#7e2217]/60');
    } else if (tabName === 'recents') {
        sidebar?.classList.remove('hidden');
        contentContainer?.classList.add('hidden');
        switchSidebarTab('recents');
        mobileTabRecents?.classList.add('active');
        mobileTabRecents?.classList.remove('text-[#7e2217]/60');
        mobileTabSources?.classList.remove('active');
        mobileTabSources?.classList.add('text-[#7e2217]/60');
        mobileTabPinned?.classList.remove('active');
        mobileTabPinned?.classList.add('text-[#7e2217]/60');
    } else if (tabName === 'pinned') {
        sidebar?.classList.remove('hidden');
        contentContainer?.classList.add('hidden');
        switchSidebarTab('pinned');
        mobileTabPinned?.classList.add('active');
        mobileTabPinned?.classList.remove('text-[#7e2217]/60');
        mobileTabSources?.classList.remove('active');
        mobileTabSources?.classList.add('text-[#7e2217]/60');
        mobileTabRecents?.classList.remove('active');
        mobileTabRecents?.classList.add('text-[#7e2217]/60');
    }
};

const initPinnedDragAndDrop = () => {
    const pinnedList = document.getElementById('pinned-list');
    if (!pinnedList) return;

    let draggedItem = null;
    let touchStartY = 0;
    let touchStartX = 0;
    let touchClone = null;
    let isDragging = false;

    pinnedList.querySelectorAll('.pinned-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            draggedItem = null;
            updateOrderFromList(pinnedList);
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!draggedItem) return;
            const afterElement = getDragAfterElement(pinnedList, e.clientY);
            if (afterElement) {
                pinnedList.insertBefore(draggedItem, afterElement);
            } else {
                pinnedList.appendChild(draggedItem);
            }
        });

        item.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartY = touch.clientY;
            touchStartX = touch.clientX;
            draggedItem = item;
            isDragging = false;

            setTimeout(() => {
                if (isDragging) return;
                item.classList.add('dragging');
                touchClone = item.cloneNode(true);
                touchClone.style.position = 'fixed';
                touchClone.style.width = item.offsetWidth + 'px';
                touchClone.style.left = item.getBoundingClientRect().left + 'px';
                touchClone.style.top = touch.clientY - 20 + 'px';
                touchClone.style.zIndex = '9999';
                touchClone.style.opacity = '0.8';
                touchClone.style.pointerEvents = 'none';
                touchClone.classList.add('dragging');
                document.body.appendChild(touchClone);
            }, 150);
        }, { passive: true });

        item.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const dy = Math.abs(touch.clientY - touchStartY);
            const dx = Math.abs(touch.clientX - touchStartX);

            if (!isDragging && (dy > 10 || dx > 10)) {
                isDragging = true;
                if (touchClone) {
                    touchClone.style.top = touch.clientY - 20 + 'px';
                }
            }

            if (isDragging && touchClone) {
                e.preventDefault();
                touchClone.style.top = touch.clientY - 20 + 'px';

                const afterElement = getDragAfterElement(pinnedList, touch.clientY);
                if (afterElement) {
                    pinnedList.insertBefore(draggedItem, afterElement);
                } else {
                    pinnedList.appendChild(draggedItem);
                }
            }
        }, { passive: false });

        item.addEventListener('touchend', () => {
            if (touchClone) {
                touchClone.remove();
                touchClone = null;
            }
            if (draggedItem) {
                draggedItem.classList.remove('dragging');
                updateOrderFromList(pinnedList);
                draggedItem = null;
            }
            isDragging = false;
        });

        item.addEventListener('touchcancel', () => {
            if (touchClone) {
                touchClone.remove();
                touchClone = null;
            }
            if (draggedItem) {
                draggedItem.classList.remove('dragging');
                updateOrderFromList(pinnedList);
                draggedItem = null;
            }
            isDragging = false;
        });
    });
};

const getDragAfterElement = (container, y) => {
    const draggableElements = [...container.querySelectorAll('.pinned-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
};

const updateOrderFromList = (container) => {
    const paths = [...container.querySelectorAll('.pinned-item')].map(item => item.dataset.path);
    savePinnedOrder(paths);
};

const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

const updateSelectedState = (clickedElement) => {
    if (selectedItem && selectedItem !== clickedElement) {
        selectedItem.classList.remove('selected');
    }
    selectedItem = clickedElement;
    if (selectedItem) {
        selectedItem.classList.add('selected');
    }
    
    document.querySelectorAll('.recent-item').forEach(item => {
        item.classList.remove('selected');
    });
    if (clickedElement && clickedElement.dataset && clickedElement.dataset.path) {
        const recentItem = document.querySelector(`.recent-item[data-path="${clickedElement.dataset.path}"]`);
        if (recentItem) {
            recentItem.classList.add('selected');
        }
    }
};

const fetchFileContent = async (path, skipCache = false) => {
    const cacheKey = `file:${path}`;
    if (!skipCache) {
        const cached = await getCachedItem(cacheKey);
        if (cached) {
            return cached;
        }
    }

    const url = `${RAW_BASE}/${encodeURIComponent(path)}?t=${Date.now()}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch file content: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    await setCachedItem(cacheKey, text);
    return text;
};

const buildRepoCache = async (treeData) => {
    const items = treeData.tree || [];
    const churches = [];
    const sermons = [];

    for (const item of items) {
        if (item.type === 'tree') {
            const firstSlash = item.path.indexOf('/');
            if (firstSlash === -1) {
                churches.push({
                    name: item.path,
                    path: item.path,
                    sha: item.sha,
                    size: 0,
                    type: 'dir'
                });
            }
        } else if (item.type === 'blob' && isMarkdownFile(item.path)) {
            const firstSlash = item.path.indexOf('/');
            if (firstSlash === -1) continue;

            const churchPath = item.path.slice(0, firstSlash);
            const relativePath = item.path;
            const lastSlash = relativePath.lastIndexOf('/');
            const subpath = lastSlash === -1 ? '' : relativePath.slice(churchPath.length + 1, lastSlash);
            const name = lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);

            sermons.push({
                name,
                path: relativePath,
                subpath,
                church: churchPath,
                sha: item.sha,
                size: item.size,
                type: 'file'
            });
        }
    }

    await setCachedItem(REPO_TREE_CACHE_KEY, treeData);
    await setCachedItem(CHURCH_LIST_CACHE_KEY, churches);
    await setCachedItem(SERMON_INDEX_CACHE_KEY, sermons);
};

const fetchRepoTree = async (skipCache = false) => {
    if (!skipCache) {
        const cachedTree = await getCachedItem(REPO_TREE_CACHE_KEY);
        if (cachedTree) return cachedTree;
    }

    if (!navigator.onLine) {
        throw new Error('You are currently offline. Please check your internet connection.');
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    const url = `${TREES_API_BASE}/main?recursive=1&t=${Date.now()}`;
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/vnd.github+json'
        }
    });

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.truncated) {
        console.warn('Repo tree was truncated by GitHub. Some files may not be available.');
    }

    await buildRepoCache(data);
    return data;
};

const getCachedChurchList = async (skipCache = false) => {
    if (!skipCache) {
        const cached = await getCachedItem(CHURCH_LIST_CACHE_KEY);
        if (cached) return cached;
    }

    const tree = await fetchRepoTree(skipCache);
    if (!tree) return [];

    const cached2 = await getCachedItem(CHURCH_LIST_CACHE_KEY);
    return cached2 || [];
};

const getCachedSermonIndex = async (skipCache = false) => {
    if (!skipCache) {
        const cached = await getCachedItem(SERMON_INDEX_CACHE_KEY);
        if (cached) return cached;
    }

    const tree = await fetchRepoTree(skipCache);
    if (!tree) return [];

    const cached2 = await getCachedItem(SERMON_INDEX_CACHE_KEY);
    return cached2 || [];
};

const loadRootDirectories = async (skipCache = false) => {
    if (isLoading) return;
    isLoading = true;

    currentPath = '';
    selectedItem = null;
    rootSermonSearch = '';
    searchBody = false;
    hideError();
    showLoading();
    renderBreadcrumb('');

    try {
        const churches = await getCachedChurchList(skipCache);
        const allSermons = await getCachedSermonIndex(skipCache);
        currentFiles = allSermons;

        if (churches.length === 0) {
            hideLoading();
            elements.mainContent.innerHTML = renderEmptyState(
                'The repository is empty. Add markdown files to get started.'
            );
            const filterHint = document.getElementById('filter-hint');
            if (filterHint) filterHint.classList.remove('hidden');
            return;
        }

        let html = '';
        if (churches.length > 0) {
            html += renderFolders(churches, '');
        }

        hideLoading();
        elements.mainContent.innerHTML = html;
        const filterHint = document.getElementById('filter-hint');
        if (filterHint) filterHint.classList.remove('hidden');
        showQuote();
        renderPinnedPanel(false);
        renderRecentsPanel(false);
    } catch (error) {
        hideLoading();
        showError(error.message);
    } finally {
        isLoading = false;
    }
};

const loadSermons = async (path, skipCache = false) => {
    if (isLoading) return;
    isLoading = true;

    currentPath = path;
    selectedItem = null;
    searchBody = false;
    hideError();
    showLoading();

    try {
        const allSermons = await getCachedSermonIndex(skipCache);
        const prefix = `${path}/`;
        const files = allSermons.filter(sermon => sermon.path.startsWith(prefix));

        hideLoading();

        if (files.length === 0) {
            elements.mainContent.innerHTML = renderEmptyState(
                'This church has no sermons yet.'
            );
            return;
        }

        currentFiles = files;
        elements.mainContent.innerHTML = renderFiles(files, path);
        showQuote();
        renderPinnedPanel(false);
        renderRecentsPanel(false);
    } catch (error) {
        hideLoading();
        showError(error.message);
    } finally {
        isLoading = false;
    }
};

const loadMarkdownFile = async (path) => {
    if (isLoading) return;
    isLoading = true;

    selectedItem = null;
    hideError();
    showLoading();

    try {
        const content = await fetchFileContent(path);
        hideLoading();
        elements.mainContent.innerHTML = renderMarkdown(content);
        hideQuote();
    } catch (error) {
        hideLoading();
        showError(`Failed to load file: ${error.message}`);
    } finally {
        isLoading = false;
    }
};

const handleItemClick = async (event) => {
    const button = event.target.closest('button');
    if (!button) return;

    const type = button.dataset.type;
    const path = button.dataset.path;

    if (!path) return;

    updateSelectedState(button);

    if (type === 'folder') {
        enterSubView(path);
        await loadSermons(path);
    } else if (type === 'file') {
        const segments = path.split('/');
        const churchPath = segments[0];
        enterSubView(churchPath);
        const sermon = currentFiles.find(f => f.path === path) || { path, name: path.split('/').pop() || path };
        addRecent(sermon);
        await loadMarkdownFile(path);
    }
};

const handleRetry = () => {
    if (currentPath) {
        enterSubView(currentPath);
        loadSermons(currentPath);
    } else {
        loadRootDirectories();
    }
};

const handleHomeClick = () => {
    loadRootDirectories();
};

const handleChurchClick = () => {
    const segments = currentPath.split('/');
    const churchPath = segments[0];
    enterSubView(churchPath);
    loadSermons(churchPath);
};

const handleCheckNewChurch = async () => {
    if (isLoading) return;
    const btn = document.getElementById('check-new-church-btn');
    if (!btn) return;

    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Checking...';

    try {
        await loadRootDirectories(true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.textContent = 'Check For New Church';
        }
    }
};

const handleCheckNewSermons = async () => {
    if (isLoading || !currentPath) return;
    const btn = document.getElementById('check-new-sermons-btn');
    if (!btn) return;

    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Checking...';

    try {
        await loadSermons(currentPath, true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.textContent = 'Check For New Sermons';
        }
    }
};

const openFilterPopup = async () => {
    const popup = document.getElementById('church-filter-popup');
    if (!popup) return;
    await renderFilterPopup();
    popup.classList.remove('hidden');
};

const closeFilterPopup = () => {
    const popup = document.getElementById('church-filter-popup');
    if (popup) {
        popup.classList.add('hidden');
    }
};

const enableAllChurches = async () => {
    saveDisabledChurches(new Set());
    await renderFilterPopup();
    if (currentPath === '') {
        loadRootDirectories();
    } else {
        loadSermons(currentPath);
    }
};

const disableAllChurches = async () => {
    const churches = await getCachedChurchList();
    const allNames = new Set(churches.map(c => c.name));
    saveDisabledChurches(allNames);
    await renderFilterPopup();
    loadRootDirectories();
};

const renderFilterPopup = async () => {
    const listContainer = document.getElementById('church-filter-list');
    if (!listContainer) return;

    const churches = await getCachedChurchList();

    const disabled = getDisabledChurches();

    listContainer.innerHTML = `
        <div class="filter-action-btns">
            <button id="enable-all-btn" class="filter-action-btn">Enable All</button>
            <button id="disable-all-btn" class="filter-action-btn">Disable All</button>
        </div>
    ` + churches.map(church => {
        const isDisabled = disabled === null ? false : disabled.has(church.name);
        return `
            <div class="church-filter-item">
                <span class="church-filter-name">${escapeHtml(church.name)}</span>
                <label class="toggle-switch">
                    <input type="checkbox" ${isDisabled ? '' : 'checked'} data-church="${escapeHtml(church.name)}">
                    <span class="toggle-slider"></span>
                </label>
            </div>
        `;
    }).join('') || '<p class="text-[#7e2217] italic">No churches found.</p>';
};

const handleFilterToggle = async (churchName, checked) => {
    let disabled = getDisabledChurches();

    if (disabled === null) {
        disabled = new Set();
    }

    if (checked) {
        disabled.delete(churchName);
    } else {
        disabled.add(churchName);
    }

    saveDisabledChurches(disabled);

    if (currentPath === '') {
        loadRootDirectories();
    } else {
        const segments = currentPath.split('/');
        if (segments[0] && isChurchDisabled(segments[0])) {
            loadRootDirectories();
        }
    }
};

const createDevPanel = () => {
    const main = document.querySelector('main');
    if (!main) return null;

    main.style.display = 'flex';

    const panel = document.createElement('div');
    panel.id = 'dev-panel';
    panel.className = 'dev-panel';

    panel.innerHTML = `
        <h3 class="font-['Cinzel'] text-xl text-[#7e2217] mb-4">Developer Options:</h3>
        <button id="dev-delete-idb" class="dev-btn dev-btn-danger mb-2">CLEAR AND DELETE ALL CACHED DATA</button>
        <button id="dev-delete-localstorage" class="dev-btn dev-btn-danger mb-2">CLEAR AND DELETE ALL LOCAL STORAGE</button>
        <button id="dev-clear-sw-cache" class="dev-btn dev-btn-danger">CLEAR SERVICE WORKER CACHE</button>
        <div id="dev-status"></div>
    `;

    main.appendChild(panel);
    return panel;
};

const deleteAllIndexedDb = async () => {
    return new Promise((resolve, reject) => {
        if (db) {
            db.close();
            db = null;
        }
        const request = indexedDB.deleteDatabase('scriptorium-cache');
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
};

const deleteAllLocalStorage = () => {
    return new Promise((resolve, reject) => {
        try {
            localStorage.clear();
            resolve();
        } catch (e) {
            reject(e);
        }
    });
};

const clearServiceWorkerCache = async () => {
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
            await registration.unregister();
        }
    }

    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => caches.delete(name)));

    window.location.reload();
};

const setDevStatus = (message, isSuccess) => {
    const statusEl = document.getElementById('dev-status');
    if (!statusEl) return;
    statusEl.innerHTML = `<p class="font-['Cinzel'] text-sm mt-2 ${isSuccess ? 'text-green-700' : 'text-red-700'}">${escapeHtml(message)}</p>`;
};

const showDevConfirmPopup = (title, message, onConfirm) => {
    const overlay = document.createElement('div');
    overlay.id = 'dev-confirm-popup';
    overlay.className = 'popup-overlay';

    overlay.innerHTML = `
        <div class="popup-content">
            <div class="popup-header">
                <h3 class="font-['Cinzel'] text-xl text-[#7e2217]">${escapeHtml(title)}</h3>
                <button class="popup-close" id="dev-confirm-close">&times;</button>
            </div>
            <div class="church-filter-list">
                <p class="font-['Crimson_Pro'] text-[#7e2217] mb-4">${escapeHtml(message)}</p>
                <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button id="dev-confirm-cancel" class="px-4 py-2 bg-[#c5a059] text-white font-['Cinzel'] hover:bg-[#c5a059]/80 transition-colors">Cancel</button>
                    <button id="dev-confirm-ok" class="px-4 py-2 bg-red-700 text-white font-['Cinzel'] hover:bg-red-800 transition-colors">Confirm</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    overlay.addEventListener('click', (e) => {
        if (e.target.id === 'dev-confirm-popup') close();
    });

    document.getElementById('dev-confirm-close')?.addEventListener('click', close);
    document.getElementById('dev-confirm-cancel')?.addEventListener('click', close);

    document.getElementById('dev-confirm-ok')?.addEventListener('click', async () => {
        close();
        await onConfirm();
    });
};

const initDevMode = async () => {
    const hash = window.location.hash;
    if (!hash || hash.toLowerCase() !== '#dev') return;

    const panel = createDevPanel();
    if (!panel) return;

    document.getElementById('dev-delete-idb')?.addEventListener('click', async () => {
        await showDevConfirmPopup('Delete All Cached Data', 'This will completely delete the IndexedDB database. This action cannot be undone.', async () => {
            try {
                await deleteAllIndexedDb();
                setDevStatus('IndexedDB database deleted successfully.', true);
            } catch (error) {
                console.error('Failed to delete IndexedDB:', error);
                setDevStatus('Failed to delete IndexedDB: ' + error.message, false);
            }
        });
    });

    document.getElementById('dev-delete-localstorage')?.addEventListener('click', async () => {
        await showDevConfirmPopup('Clear and Delete localStorage', 'This will completely clear all localStorage data. This action cannot be undone.', async () => {
            try {
                await deleteAllLocalStorage();
                setDevStatus('localStorage cleared successfully.', true);
            } catch (error) {
                console.error('Failed to clear localStorage:', error);
                setDevStatus('Failed to clear localStorage: ' + error.message, false);
            }
        });
    });

    document.getElementById('dev-clear-sw-cache')?.addEventListener('click', async () => {
        await showDevConfirmPopup('Clear Service Worker Cache', 'This will unregister all service workers and delete all cached assets. The app will reload and fetch fresh from the server.', async () => {
            try {
                await clearServiceWorkerCache();
                setDevStatus('Service Worker cache cleared. Reloading...', true);
            } catch (error) {
                console.error('Failed to clear SW cache:', error);
                setDevStatus('Failed to clear SW cache: ' + error.message, false);
            }
        });
    });
};

const runSearch = async (searchId, query) => {
    if (searchId === 'root-sermon-search') {
        const disabled = getDisabledChurches();
        let baseFiltered = query ? filterFiles(query) : currentFiles;

        if (searchBody && query.trim().length > 0) {
            const bodyMatches = await searchInBodies(query, currentFiles);
            const merged = new Map();
            baseFiltered.forEach(f => merged.set(f.path, f));
            bodyMatches.forEach(f => merged.set(f.path, f));
            baseFiltered = [...merged.values()];
        }

        const filteredFiles = disabled === null ? baseFiltered : baseFiltered.filter(file => {
            const church = file.church || (file.subpath ? file.subpath.split('/')[0] : '');
            return !disabled.has(church);
        });
        const sermonHtml = filteredFiles.map(file => {
            const prefix = file.church ? `${file.church}/` : '';
            const subpathPart = file.subpath ? `${file.subpath}/` : '';
            const filePath = `${prefix}${subpathPart}${file.name}`;
            const churchLabel = file.church || (file.subpath ? file.subpath.split('/')[0] : '');
            return `
                <button class="folder-btn fade-in" data-path="${escapeHtml(filePath)}" data-type="file">
                    <span>${escapeHtml(getDisplayName(file.name))}${churchLabel ? ' <span style="opacity:0.6;font-size:0.85em">(' + escapeHtml(churchLabel) + ')</span>' : ''}</span>
                </button>
            `;
        }).join('');

        const churchContainer = document.getElementById('church-list-container');
        const sermonContainer = document.getElementById('sermon-list-container');
        const toggle = document.getElementById('root-sermon-search-body-toggle');
        if (toggle) {
            toggle.classList.toggle('hidden', query.trim().length === 0);
        }
        if (churchContainer && sermonContainer) {
            if (query.trim().length > 0) {
                sermonContainer.innerHTML = sermonHtml || '<p class="text-[#7e2217] italic">No matching sermons found.</p>';
                sermonContainer.classList.remove('hidden');
                churchContainer.classList.add('hidden');
            } else {
                sermonContainer.classList.add('hidden');
                churchContainer.classList.remove('hidden');
            }
        }
    } else if (searchId === 'sermon-search') {
        let filtered = query ? filterFiles(query) : currentFiles;

        if (searchBody && query.trim().length > 0) {
            const bodyMatches = await searchInBodies(query, currentFiles);
            const merged = new Map();
            filtered.forEach(f => merged.set(f.path, f));
            bodyMatches.forEach(f => merged.set(f.path, f));
            filtered = [...merged.values()];
        }

        const container = document.getElementById('sermon-list-container');
        if (container) {
            container.innerHTML = renderFileButtons(filtered, currentPath);
        }

        const toggle = document.getElementById('sermon-search-body-toggle');
        if (toggle) {
            toggle.classList.toggle('hidden', query.trim().length === 0);
        }
    }
};

const renderRandomQuote = async () => {
    const quoteEl = document.getElementById('random-quote');
    if (!quoteEl) return;

    try {
        let text = await getCachedItem(QUOTES_CACHE_KEY);
        if (!text) {
            const response = await fetch('https://raw.githubusercontent.com/eorroe/Church-Sermons-Viewer-Scriptorium/refs/heads/main/quotes.txt?t=' + Date.now());
            if (!response.ok) throw new Error('Failed to load quotes');
            text = await response.text();
            await setCachedItem(QUOTES_CACHE_KEY, text);
        }
        const quotes = text.split('\n\n').map(q => q.trim()).filter(q => q.length > 0);
        if (quotes.length > 0) {
            currentQuote = quotes[Math.floor(Math.random() * quotes.length)];
            const quoteHtml = escapeHtml(currentQuote).replace(/\n/g, '<br>');
            const linked = linkifyBiblicalReferences(quoteHtml);
            quoteEl.innerHTML = linked;
            quoteEl.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Failed to load quotes:', error);
        quoteEl.classList.add('hidden');
    }
};

const showQuote = () => {
    const quoteEl = document.getElementById('random-quote');
    if (quoteEl && currentQuote) {
        quoteEl.classList.remove('hidden');
    }
};

const hideQuote = () => {
    const quoteEl = document.getElementById('random-quote');
    if (quoteEl) quoteEl.classList.add('hidden');
};

const init = async () => {
    try {
        db = await openCacheDb();
    } catch (error) {
        console.error('Failed to open cache database:', error);
    }

    elements.mainContent.addEventListener('click', handleItemClick);
    elements.mainContent.addEventListener('click', (e) => {
        const toggleBtn = e.target.closest('.search-toggle-btn');
        if (toggleBtn) {
            e.stopPropagation();
            searchBody = !searchBody;
            toggleBtn.textContent = searchBody ? 'Searching Titles + Body' : 'Searching Titles Only';
            const searchId = toggleBtn.dataset.searchId;
            const searchInput = document.getElementById(searchId);
            if (searchInput && searchInput.value.trim().length > 0) {
                const query = searchInput.value;
                if (searchId === 'root-sermon-search') {
                    rootSermonSearch = query;
                }
                runSearch(searchId, query);
            }
            return;
        }

        const checkBtn = e.target.closest('#check-new-church-btn, #check-new-sermons-btn');
        if (checkBtn) {
            e.stopPropagation();
            if (checkBtn.id === 'check-new-church-btn') {
                handleCheckNewChurch();
            } else if (checkBtn.id === 'check-new-sermons-btn') {
                handleCheckNewSermons();
            }
            return;
        }

        const filterBtn = e.target.closest('#filter-churches-btn');
        if (filterBtn) {
            e.stopPropagation();
            openFilterPopup();
        }
    });
    elements.retryBtn.addEventListener('click', handleRetry);
    elements.breadcrumbHome.addEventListener('click', handleHomeClick);
    elements.breadcrumbChurch.addEventListener('click', handleChurchClick);

    document.getElementById('close-filter-popup')?.addEventListener('click', closeFilterPopup);
    document.getElementById('church-filter-popup')?.addEventListener('click', (e) => {
        if (e.target.id === 'church-filter-popup') {
            closeFilterPopup();
        } else if (e.target.id === 'enable-all-btn') {
            enableAllChurches();
        } else if (e.target.id === 'disable-all-btn') {
            disableAllChurches();
        }
    });
    document.getElementById('church-filter-list')?.addEventListener('change', (e) => {
        const input = e.target.closest('input[data-church]');
        if (input) {
            handleFilterToggle(input.dataset.church, input.checked);
        }
    });

    elements.mainContent.addEventListener('input', debounce(async (e) => {
        if (e.target.id === 'root-sermon-search') {
            rootSermonSearch = e.target.value;
            await runSearch('root-sermon-search', rootSermonSearch || '');
        } else if (e.target.id === 'sermon-search') {
            await runSearch('sermon-search', e.target.value);
        }
    }, 300));

    renderRandomQuote();

    initDevMode();

    document.getElementById('tab-recents')?.addEventListener('click', () => switchSidebarTab('recents'));
    document.getElementById('tab-pinned')?.addEventListener('click', () => switchSidebarTab('pinned'));

    document.getElementById('mobile-tab-sources')?.addEventListener('click', () => switchMobileTab('sources'));
    document.getElementById('mobile-tab-recents')?.addEventListener('click', () => switchMobileTab('recents'));
    document.getElementById('mobile-tab-pinned')?.addEventListener('click', () => switchMobileTab('pinned'));

    switchSidebarTab('recents');

    document.getElementById('main-content')?.addEventListener('contextmenu', (e) => {
        const sermonBtn = e.target.closest('button[data-type="file"]');
        if (sermonBtn) {
            e.preventDefault();
            const path = sermonBtn.dataset.path;
            const name = sermonBtn.querySelector('span')?.textContent || path;
            const sermon = { path, name, church: path.split('/')[0] || '' };
            if (isPinned(path)) {
                removePinnedSermon(path);
            } else {
                addPinnedSermon(sermon);
            }
            renderPinnedPanel();
        }
    });

    let holdTimer = null;
    const handlePinToggle = (sermonBtn) => {
        const path = sermonBtn.dataset.path;
        const name = sermonBtn.querySelector('span')?.textContent || path;
        const sermon = { path, name, church: path.split('/')[0] || '' };
        if (isPinned(path)) {
            removePinnedSermon(path);
        } else {
            addPinnedSermon(sermon);
        }
        renderPinnedPanel();
    };

    document.getElementById('main-content')?.addEventListener('mousedown', (e) => {
        const sermonBtn = e.target.closest('button[data-type="file"]');
        if (sermonBtn && e.button === 0) {
            holdTimer = setTimeout(() => {
                handlePinToggle(sermonBtn);
            }, 500);
        }
    });

    document.getElementById('main-content')?.addEventListener('touchstart', (e) => {
        const sermonBtn = e.target.closest('button[data-type="file"]');
        if (sermonBtn) {
            holdTimer = setTimeout(() => {
                handlePinToggle(sermonBtn);
            }, 500);
        }
    }, { passive: true });

    const clearHoldTimer = () => {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
    };

    document.addEventListener('mouseup', clearHoldTimer);
    document.addEventListener('touchend', clearHoldTimer);
    document.addEventListener('touchcancel', clearHoldTimer);

    document.getElementById('pinned-list')?.addEventListener('click', (e) => {
    const unpinBtn = e.target.closest('.unpin-btn');
    if (unpinBtn) {
        e.stopPropagation();
        const path = unpinBtn.dataset.path;
        const pinnedItem = unpinBtn.closest('.pinned-item');
        const title = pinnedItem?.querySelector('.pinned-title')?.textContent || 'this sermon';
        showDevConfirmPopup('Unpin Sermon', `Are you sure you want to unpin "${title}"?`, async () => {
            removePinnedSermon(path);
            renderPinnedPanel();
        });
        return;
    }

        const pinnedItem = e.target.closest('.pinned-item');
        if (pinnedItem) {
            const path = pinnedItem.dataset.path;
            const segments = path.split('/');
            const churchPath = segments[0];
            enterSubView(churchPath);
            loadSermons(churchPath).then(() => {
                const fileBtn = document.querySelector(`button[data-path="${path}"]`);
                if (fileBtn) {
                    updateSelectedState(fileBtn);
                    loadMarkdownFile(path);
                }
            });
            switchMobileTab('sources');
        }
    });

    document.getElementById('recents-list')?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.remove-recent-btn');
    if (removeBtn) {
        e.stopPropagation();
        const path = removeBtn.dataset.path;
        const recentItem = removeBtn.closest('.recent-item');
        const title = recentItem?.querySelector('.recent-title')?.textContent || 'this sermon';
        showDevConfirmPopup('Remove Recent', `Are you sure you want to remove "${title}"?`, async () => {
            if (selectedRecentPath === path) {
                selectedRecentPath = '';
            }
            removeRecent(path);
            renderRecentsPanel();
        });
        return;
    }

        const recentItem = e.target.closest('.recent-item');
        if (recentItem) {
            const path = recentItem.dataset.path;
            selectedRecentPath = path;
            const segments = path.split('/');
            const churchPath = segments[0];
            enterSubView(churchPath);
            loadSermons(churchPath).then(() => {
                const fileBtn = document.querySelector(`button[data-path="${path}"]`);
                if (fileBtn) {
                    updateSelectedState(fileBtn);
                    loadMarkdownFile(path);
                }
                renderRecentsPanel();
                switchMobileTab('sources');
            });
        }
    });

    document.getElementById('move-to-top-btn')?.addEventListener('click', () => {
        if (!selectedRecentPath) return;
        const recents = getRecents();
        const sermon = recents.find(r => r.path === selectedRecentPath);
        if (sermon && recents.length > 1) {
            addRecent(sermon);
            selectedRecentPath = sermon.path;
            renderRecentsPanel();
        }
    });

    loadRootDirectories();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
    init().catch(console.error);
}
