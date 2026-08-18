const REPO_OWNER = 'eorroe';
const REPO_NAME = 'Church-Sermons-Viewer-Scriptorium';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const TREES_API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const REPO_TREE_CACHE_KEY = 'repo-tree';
const CHURCH_LIST_CACHE_KEY = 'church-list';
const SERMON_INDEX_CACHE_KEY = 'sermon-index';

let currentPath = '';
let selectedItem = null;
let isLoading = false;
let db = null;
let currentFiles = [];
let rootSermonSearch = '';

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
        </div>
    `;
};

const filterFiles = (query) => {
    if (!query) return currentFiles;
    return currentFiles.filter(file => fuzzyMatch(query, getDisplayName(file.name)));
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
    hideError();
    showLoading();
    renderBreadcrumb(path);

    const filterHint = document.getElementById('filter-hint');
    if (filterHint) filterHint.classList.add('hidden');

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
    renderBreadcrumb(currentPath);

    try {
        const content = await fetchFileContent(path);
        hideLoading();
        elements.mainContent.innerHTML = renderMarkdown(content);
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
        await loadSermons(path);
    } else if (type === 'file') {
        await loadMarkdownFile(path);
    }
};

const handleRetry = () => {
    if (currentPath) {
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
        <button id="dev-delete-localstorage" class="dev-btn dev-btn-danger">CLEAR AND DELETE ALL LOCAL STORAGE</button>
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
};

const init = async () => {
    try {
        db = await openCacheDb();
    } catch (error) {
        console.error('Failed to open cache database:', error);
    }

    elements.mainContent.addEventListener('click', handleItemClick);
    elements.mainContent.addEventListener('click', (e) => {
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

    elements.mainContent.addEventListener('input', (e) => {
        if (e.target.id === 'root-sermon-search') {
            rootSermonSearch = e.target.value;
            const query = rootSermonSearch || '';
            const disabled = getDisabledChurches();
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

            const churchContainer = document.getElementById('church-list-container');
            const sermonContainer = document.getElementById('sermon-list-container');
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
        } else if (e.target.id === 'sermon-search') {
            const filtered = filterFiles(e.target.value);
            const container = document.getElementById('sermon-list-container');
            if (container) {
                container.innerHTML = renderFileButtons(filtered, currentPath);
            }
        }
    });

    initDevMode();

    loadRootDirectories();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
    init().catch(console.error);
}
