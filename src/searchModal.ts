import * as vscode from 'vscode';
import * as path from 'path';
import { SearchProvider } from './searchProvider';

export class SearchModal {
    private static currentModal: SearchModal | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly searchProvider: SearchProvider;
    private disposables: vscode.Disposable[] = [];
    private currentResults: any[] = [];
    private currentSearchId: number = 0;
    private abortController: AbortController | null = null;

    private readonly context: vscode.ExtensionContext;
    private initialEditor?: vscode.TextEditor;

        private options?: { currentFileOnly?: boolean; currentFileUri?: vscode.Uri };
private static readonly HISTORY_KEY = 'easySearch.searchHistory';
    private static readonly MAX_HISTORY = 20;

    private loadHistory(): string[] {
        return this.context.globalState.get<string[]>(SearchModal.HISTORY_KEY, []);
    }

    private async saveHistory(history: string[]): Promise<void> {
        await this.context.globalState.update(
            SearchModal.HISTORY_KEY,
            history.slice(0, SearchModal.MAX_HISTORY)
        );
    }

    private async addToHistory(query: string): Promise<void> {
        const q = (query ?? '').trim();
        if (!q) return;

        const history = this.loadHistory();
        const next = [q, ...history.filter(x => x !== q)];
        await this.saveHistory(next);

        // Push update to webview so it can refresh the list immediately
        this.panel.webview.postMessage({ type: 'historyUpdated', history: next });
    }

    private getInitialQuery(): string {
    const editor = this.initialEditor ?? vscode.window.activeTextEditor;
    if (!editor) return '';

    // 1) If there's a selection, use it
    const sel = editor.selection;
    if (sel && !sel.isEmpty) {
        const selected = editor.document.getText(sel).trim();
        if (selected) return selected;
    }

    // 2) Otherwise, use the word at the cursor
    const pos = sel?.active ?? editor.selection.active;
    const wordRange = editor.document.getWordRangeAtPosition(pos);
    if (wordRange) {
        const word = editor.document.getText(wordRange).trim();
        if (word) return word;
    }

    return '';
}

public static createOrShow(context: vscode.ExtensionContext, editor?: vscode.TextEditor, options?: { currentFileOnly?: boolean }): SearchModal {
        if (SearchModal.currentModal) {
            const modal = SearchModal.currentModal;

            // Update invocation context so initialization word + scope can refresh
            modal.initialEditor = editor;
            modal.options = options ? { ...modal.options, ...options } : modal.options;

            // If current-file mode was requested, capture the current file URI
            if (options?.currentFileOnly && editor) {
                modal.options = { ...(modal.options || {}), currentFileOnly: true, currentFileUri: editor.document.uri };
            }

            const initialQuery = modal.getInitialQuery();
            const searchAllFiles = !(modal.options?.currentFileOnly);

            modal.panel.reveal();

            // Force the existing webview to update the input + rerun search immediately
            modal.panel.webview.postMessage({
                type: 'setInitialQuery',
                query: initialQuery,
                searchAllFiles
            });

            // Also focus the input
            modal.panel.webview.postMessage({ type: 'focusSearch' });

            return modal;
        }

        const panel = vscode.window.createWebviewPanel(
            'easySearchModal',
            'Find in Files',
            {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false
            },
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [context.extensionUri]
            }
        );

        SearchModal.currentModal = new SearchModal(panel, context, editor, options);
        return SearchModal.currentModal;
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, editor?: vscode.TextEditor, options?: { currentFileOnly?: boolean }) {
        this.panel = panel;
        this.context = context;
        this.initialEditor = editor;
        this.options = options ? { ...options } : undefined;
        if (this.options?.currentFileOnly && editor) {
            this.options.currentFileUri = editor.document.uri;
        }
        this.searchProvider = new SearchProvider(context, this.options);

        this.searchProvider.setProgressCallback((message: string, progress?: number) => {
            this.panel.webview.postMessage({
                type: 'searchProgress',
                message: message,
                progress: progress
            });
        });

        this.panel.webview.html = this.getWebviewContent();
        
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'initializeSearch':
                        await this.initializeSearch();
                        break;
                    case 'search':
                        await this.performSearch(message.query, message.excludePatterns, message.searchAllFiles);
                        break;
                    case 'commitHistory':
                        await this.addToHistory(message.query);
                        break;
                    case 'toggleCaseSensitive':
                        await this.toggleCaseSensitive();
                        break;
                    case 'selectFile':
                        await this.showFilePreview(message.filePath, message.lineNumber, message.query);
                        break;
                    case 'openFile':
                        await this.openFile(message.filePath, message.lineNumber);
                        break;
                    case 'close':
                        this.panel.dispose();
                        break;
                    case 'saveExcludePatterns':
                        await this.saveExcludePatterns(message.patterns, message.enabled);
                        break;
                }
            },
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async initializeSearch(): Promise<void> {
        try {
            await this.searchProvider.waitForReady();
            this.panel.webview.postMessage({
                type: 'searchInitialized',
                caseSensitive: this.searchProvider.getCaseSensitive()
            });
            
            // Load exclude patterns
            const excludeData = await this.searchProvider.getExcludePatterns();
            this.panel.webview.postMessage({
                type: 'excludePatternsLoaded',
                data: excludeData
            });

            // Load history + initialize query in the webview
            const history = this.loadHistory();
            const initialQuery = this.getInitialQuery();
            this.panel.webview.postMessage({
                type: 'historyLoaded',
                history,
                initialQuery,
                initialSearchAllFiles: !(this.options?.currentFileOnly)
            });
        } catch (error) {
            console.error('Search initialization error:', error);
            this.panel.webview.postMessage({
                type: 'searchInitializationError',
                error: error instanceof Error ? error.message : 'Failed to initialize search'
            });
        }
    }

    private async saveExcludePatterns(patterns: string[], enabled: boolean): Promise<void> {
        try {
            await this.searchProvider.setExcludePatterns(patterns, enabled);
        } catch (error) {
            console.error('Failed to save exclude patterns:', error);
        }
    }

    private async toggleCaseSensitive(): Promise<void> {
        try {
            const currentState = this.searchProvider.getCaseSensitive();
            const newState = !currentState;
            await this.searchProvider.setCaseSensitive(newState);
            
            this.panel.webview.postMessage({
                type: 'caseSensitiveChanged',
                caseSensitive: newState
            });
        } catch (error) {
            console.error('Failed to toggle case sensitivity:', error);
        }
    }

    private async performSearch(query: string, excludePatterns: string[] = [], searchAllFiles?: boolean): Promise<void> {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
        const searchId = ++this.currentSearchId;
        this.abortController = new AbortController();
        
        if (query.length < 2) {
            this.currentResults = [];
            this.panel.webview.postMessage({
                type: 'searchResults',
                results: [],
                query: query,
                searchId: searchId
            });
            this.panel.webview.postMessage({
                type: 'clearPreview'
            });
            return;
        }

        try {
            const effectiveSearchAllFiles = (searchAllFiles !== undefined)
                ? !!searchAllFiles
                : !(this.options?.currentFileOnly);

            const results = await this.searchProvider.search(query, this.abortController.signal, {
                currentFileOnly: !effectiveSearchAllFiles,
                currentFileUri: this.options?.currentFileUri ?? this.initialEditor?.document.uri
            });
            if (searchId !== this.currentSearchId) {
                return;
            }
            
            this.currentResults = results.map(r => ({
                filePath: r.uri?.fsPath || '',
                fileName: r.uri ? path.basename(r.uri.fsPath) : '',
                relativePath: r.uri ? vscode.workspace.asRelativePath(r.uri) : '',
                lineNumber: r.range ? r.range.start.line + 1 : 1,
                lineText: r.detail || '',
                range: r.range
            }));

            this.panel.webview.postMessage({
                type: 'searchResults',
                results: this.currentResults,
                query: query,
                searchId: searchId
            });

            if (this.currentResults.length > 0) {
                await this.showFilePreview(
                    this.currentResults[0].filePath,
                    this.currentResults[0].lineNumber,
                    query
                );
            } else {
                this.panel.webview.postMessage({
                    type: 'clearPreview'
                });
            }
        } catch (error) {
            console.error('Search error:', error);
            
            if (searchId === this.currentSearchId) {
                this.panel.webview.postMessage({
                    type: 'searchError',
                    error: error instanceof Error ? error.message : 'Search failed',
                    query: query,
                    searchId: searchId
                });
                // Clear preview on error
                this.panel.webview.postMessage({
                    type: 'clearPreview'
                });
            }
        }
    }

    private async showFilePreview(filePath: string, lineNumber: number, query: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();

            this.panel.webview.postMessage({
                type: 'filePreview',
                content: content,
                filePath: filePath,
                fileName: path.basename(filePath),
                lineNumber: lineNumber,
                query: query
            });
        } catch (error) {
            console.error('Preview error:', error);
        }
    }

    private async openFile(filePath: string, lineNumber: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, { 
                preview: false,
                preserveFocus: false 
            });
            const range = new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
    }

    private getWebviewContent(): string {
        const scriptContent = `
            const vscode = acquireVsCodeApi();
            const searchInput = document.querySelector('.search-input');
            const resultsContainer = document.querySelector('.results-container');
            const previewHeader = document.querySelector('.preview-header');
            const previewContent = document.querySelector('.preview-content');
            const resultsCount = document.querySelector('.results-count');
            const searchAllFilesToggle = document.getElementById('searchAllFilesToggle');
            const historyDropdown = document.getElementById('historyDropdown');
            
            let searchTimeout;
            let focusTimeouts = [];
            let currentResults = [];
            let currentResultsCount = 0;
                        let lastCommittedQuery = '';
                        let commitTimer = null;
            
                        function commitHistoryIfNeeded() {
                            const q = (searchInput && searchInput.value ? searchInput.value : '').trim();
                            if (q.length < 2) return;
                            if (currentResultsCount <= 0) return;
                            if (q === lastCommittedQuery) return;
                            lastCommittedQuery = q;
                            vscode.postMessage({ type: 'commitHistory', query: q });
                        }
            
                        function scheduleCommitHistory() {
                            if (commitTimer) clearTimeout(commitTimer);
                            commitTimer = setTimeout(() => {
                                commitHistoryIfNeeded();
                            }, 200);
                        }
            let selectedIndex = 0;
            let currentSearchId = 0;
            let searchAllFiles = true;
            let isSearching = false;
            let searchInitialized = false;
            let caseSensitive = false;
            let lastQuery = '';
            let history = [];
            let initialQuery = '';
            let excludePatterns = [];
            let excludeEnabled = false;

            if (searchAllFilesToggle) {
                searchAllFilesToggle.addEventListener('change', () => {
                    searchAllFiles = !!searchAllFilesToggle.checked;
                    const q = (searchInput.value || '').trim();
                    if (q.length >= 2 && searchInitialized) {
                        clearTimeout(searchTimeout);
                        searchTimeout = setTimeout(() => performNewSearch(), 50);
                    }
                });
            }
            
            const caseSensitiveBtn = document.querySelector('.case-sensitive-btn');
            const excludeInput = document.querySelector('.exclude-input');
            const excludeToggleBtn = document.querySelector('.exclude-toggle-btn');
            
            showProgress('Initializing search index...');
            vscode.postMessage({ type: 'initializeSearch' });

            // Commit search query to history only after user interacts with results/preview.
            if (resultsContainer) {
                resultsContainer.addEventListener('scroll', () => {
                    scheduleCommitHistory();
                }, { passive: true });
                resultsContainer.addEventListener('mousedown', () => {
                    commitHistoryIfNeeded();
                });
            }
            if (previewContent) {
                previewContent.addEventListener('scroll', () => {
                    scheduleCommitHistory();
                }, { passive: true });
                previewContent.addEventListener('mousedown', () => {
                    commitHistoryIfNeeded();
                });
            }
            function focusSearchInput() {
                searchInput.focus();
                searchInput.select();
            }
            
            focusSearchInput();
            focusTimeouts.push(setTimeout(focusSearchInput, 50));
            
            caseSensitiveBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'toggleCaseSensitive' });
            });
            
            excludeToggleBtn.addEventListener('click', () => {
                excludeEnabled = !excludeEnabled;
                updateExcludeButton();
                saveExcludePatterns();
                if (lastQuery.length >= 2) {
                    performNewSearch();
                }
            });
            
            excludeInput.addEventListener('input', (e) => {
                const patterns = e.target.value.split(',').map(p => p.trim()).filter(p => p.length > 0);
                excludePatterns = patterns;
                saveExcludePatterns();
                if (lastQuery.length >= 2 && excludeEnabled) {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => {
                        performNewSearch();
                    }, 300);
                }
            });
            

            
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const query = e.target.value;
                lastQuery = query;
                
                currentResults = [];
                selectedIndex = 0;
                
                if (query.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">Start typing to search...</div></div>';
                    updateResultsCount(0);
                    vscode.postMessage({ type: 'clearPreview' });
                    return;
                } else if (query.length < 2) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">Type at least 2 characters...</div></div>';
                    updateResultsCount(0);
                    vscode.postMessage({ type: 'clearPreview' });
                    return;
                } else {
                    resultsContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Searching...</div></div>';
                    updateResultsCount(0);
                }
                
                searchTimeout = setTimeout(() => {
                    if (!isSearching && searchInitialized && query.length >= 2) {
                        isSearching = true;
                        currentSearchId++;
                        vscode.postMessage({
                            type: 'search',
                            query: query,
                            searchId: currentSearchId,
                            searchAllFiles: !!searchAllFiles,
                            excludePatterns: excludeEnabled ? excludePatterns : []
                        });
                    } else if (!searchInitialized && query.length >= 2) {
                         resultsContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Preparing search index...</div></div>';
                    }
                }, 150);
            });
            
             document.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (e.key === 'ArrowDown') {
                        navigateResults(1);
                    } else if (e.key === 'ArrowUp') {
                        navigateResults(-1);
                    }
                }
            }, true);
            
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (e.shiftKey || e.ctrlKey || e.metaKey) {
                        // Allow new line with Shift+Enter, Ctrl+Enter, or Cmd+Enter
                        return;
                    }
                    e.preventDefault();
                    if (currentResults[selectedIndex]) {
                        openCurrentFile();
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'close' });
                }
            });
            
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'close' });
                }
            });
            
            function handleBackdropClick(event) {
                vscode.postMessage({ type: 'close' });
            }
            
            function navigateResults(direction) {
                if (currentResults.length === 0) return;
                
                selectedIndex = Math.max(0, Math.min(currentResults.length - 1, selectedIndex + direction));
                updateSelection();
                selectFile(currentResults[selectedIndex]);
            }
            
            function updateSelection() {
                document.querySelectorAll('.result-item').forEach((item, index) => {
                    item.classList.toggle('selected', index === selectedIndex);
                });
                
                const selectedItem = document.querySelector('.result-item.selected');
                if (selectedItem) {
                    selectedItem.scrollIntoView({
                        behavior: 'auto',
                        block: 'nearest',
                        inline: 'nearest'
                    });
                }
            }
            
            function updateResultsCount(count) {
                currentResultsCount = count;
                if (resultsCount) {
                    resultsCount.textContent = count > 0 ? \`\${count} result\${count === 1 ? '' : 's'}\` : '';
                }
            }
            
            function selectFile(result) {
                commitHistoryIfNeeded();
                vscode.postMessage({
                    type: 'selectFile',
                    filePath: result.filePath,
                    lineNumber: result.lineNumber,
                    query: searchInput.value
                });
            }
            
            function openCurrentFile() {
                commitHistoryIfNeeded();
                if (currentResults[selectedIndex]) {
                    vscode.postMessage({
                        type: 'openFile',
                        filePath: currentResults[selectedIndex].filePath,
                        lineNumber: currentResults[selectedIndex].lineNumber
                    });
                }
            }
            
            window.addEventListener('message', (event) => {
                const message = event.data;
                
                if (message.type === 'searchResults') {
                    if ((!message.searchId || message.searchId >= currentSearchId) && lastQuery.length >= 2) {
                        currentResults = message.results;
                        selectedIndex = 0;
                        renderResults(message.results, message.query);
                        updateResultsCount(message.results.length);
                        isSearching = false;
                    }
                } else if (message.type === 'searchError') {
                    if ((!message.searchId || message.searchId >= currentSearchId) && lastQuery.length >= 2) {
                        renderError(message.error);
                        isSearching = false;
                    }
                } else if (message.type === 'searchProgress') {
                    if (lastQuery.length >= 2 && (isSearching || !searchInitialized)) {
                        showProgress(message.message, message.progress);
                    }
                } else if (message.type === 'searchInitialized') {
                    searchInitialized = true;
                    caseSensitive = message.caseSensitive;
                    updateCaseSensitiveButton();
                    if (lastQuery.length === 0) {
                        resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">Start typing to search...</div></div>';
                    }
                    focusSearchInput();
                } else if (message.type === 'caseSensitiveChanged') {
                    caseSensitive = message.caseSensitive;
                    updateCaseSensitiveButton();
                    if (lastQuery.length >= 2 && searchInitialized) {
                        resultsContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Searching...</div></div>';
                        updateResultsCount(0);
                        isSearching = true;
                        currentSearchId++;
                        vscode.postMessage({
                            type: 'search',
                            query: lastQuery,
                            searchId: currentSearchId,
                            searchAllFiles: !!searchAllFiles,
                            excludePatterns: excludeEnabled ? excludePatterns : []
                        });
                    }
                } else if (message.type === 'searchInitializationError') {
                    searchInitialized = false;
                    renderError(message.error || 'Failed to initialize search');
                } else if (message.type === 'filePreview') {
                    renderPreview(message);
                } else if (message.type === 'clearPreview') {
                    clearPreview();
                } else if (message.type === 'focusSearch') {
                    focusSearchInput();
                } else if (message.type === 'setInitialQuery') {
                    const q = (message.query || '');
                    setQueryInInput(q);

                    // Update scope checkbox if provided
                    if (typeof message.searchAllFiles === 'boolean') {
                        searchAllFiles = !!message.searchAllFiles;
                        if (searchAllFilesToggle) {
                            searchAllFilesToggle.checked = !!searchAllFiles;
                        }
                    }

                    // Trigger same path as user typing so results refresh immediately
                    try { searchInput.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                    try { renderHistory(searchInput.value || ''); } catch (e) {}
                } else if (message.type === 'historyLoaded') {
                    history = message.history || [];
                    initialQuery = message.initialQuery || '';
                    if (typeof message.initialSearchAllFiles === 'boolean') {
                        searchAllFiles = message.initialSearchAllFiles;
                        if (searchAllFilesToggle) {
                            searchAllFilesToggle.checked = !!searchAllFiles;
                        }
                    }
                    if (initialQuery && !searchInput.value) {
                        setQueryInInput(initialQuery);
                        // Select all so it's easy to overwrite
                        try { searchInput.select(); } catch (e) {}
                    }

                    // Force the UI to refresh immediately (otherwise it may only update after the user types).
                    try { searchInput.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                    try { renderHistory(searchInput.value || ''); } catch (e) {}
                } else if (message.type === 'historyUpdated') {
                    history = message.history || [];

                    // If the dropdown is open / the box is focused, refresh it.
                    try { renderHistory(searchInput.value || ''); } catch (e) {}
                } else if (message.type === 'excludePatternsLoaded') {
                    loadExcludePatterns(message.data);
                }
            });

            function escapeHtml(s) {
                return (s ?? '').replace(/[&<>"']/g, c => ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;'
                }[c]));
            }

            function renderHistory(filterText = '') {
                if (!historyDropdown) return;

                const ft = (filterText || '').toLowerCase();
                const items = (history || []).filter(q => (q || '').toLowerCase().includes(ft)).slice(0, 20);

                if (!items.length) {
                    historyDropdown.classList.add('hidden');
                    historyDropdown.innerHTML = '';
                    return;
                }

                historyDropdown.innerHTML = items.map(q =>
                    '<div class="history-item" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</div>'
                ).join('');

                historyDropdown.classList.remove('hidden');
            }

            function hideHistory() {
                if (!historyDropdown) return;
                historyDropdown.classList.add('hidden');
            }

            function setQueryInInput(q) {
                const query = (q ?? '').toString();
                searchInput.value = query;
                lastQuery = query;
            }

            if (historyDropdown) {
                historyDropdown.addEventListener('mousedown', (e) => {
                    const item = e.target.closest('.history-item');
                    if (!item) return;
                    const q = item.getAttribute('data-q') || '';
                    setQueryInInput(q);
                    // Trigger the same path as typing so results refresh immediately
                    try { searchInput.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                    hideHistory();

                    // Put cursor at end (feels natural)
                    requestAnimationFrame(() => {
                        searchInput.focus();
                        searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
                    });
                });
            }

            searchInput.addEventListener('focus', () => {
                renderHistory(searchInput.value);
            });

            searchInput.addEventListener('input', () => {
                renderHistory(searchInput.value);
            });

            document.addEventListener('mousedown', (e) => {
                if (!historyDropdown) return;
                if (e.target === searchInput) return;
                if (historyDropdown.contains(e.target)) return;
                hideHistory();
            });


            

            
            function updateCaseSensitiveButton() {
                if (caseSensitive) {
                    caseSensitiveBtn.classList.add('active');
                } else {
                    caseSensitiveBtn.classList.remove('active');
                }
            }
            
            function updateExcludeButton() {
                const eyeOpen = excludeToggleBtn.querySelector('.eye-open');
                const eyeClosed = excludeToggleBtn.querySelector('.eye-closed');
                
                if (excludeEnabled) {
                    excludeToggleBtn.classList.add('active');
                    if (eyeOpen) eyeOpen.style.display = 'block';
                    if (eyeClosed) eyeClosed.style.display = 'none';
                } else {
                    excludeToggleBtn.classList.remove('active');
                    if (eyeOpen) eyeOpen.style.display = 'none';
                    if (eyeClosed) eyeClosed.style.display = 'block';
                }
            }
            
            function saveExcludePatterns() {
                vscode.postMessage({
                    type: 'saveExcludePatterns',
                    patterns: excludePatterns,
                    enabled: excludeEnabled
                });
            }
            
            function loadExcludePatterns(data) {
                excludePatterns = data.patterns || [];
                excludeEnabled = data.enabled || false;
                excludeInput.value = excludePatterns.join(', ');
                updateExcludeButton();
            }
            
            function performNewSearch() {
                hideHistory();
                if (!isSearching && searchInitialized && lastQuery.length >= 2) {
                    resultsContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Searching...</div></div>';
                    updateResultsCount(0);
                    isSearching = true;
                    currentSearchId++;
                    vscode.postMessage({
                        type: 'search',
                        query: lastQuery,
                        searchId: currentSearchId,
                            searchAllFiles: !!searchAllFiles,
                        excludePatterns: excludeEnabled ? excludePatterns : []
                    });
                }
            }
            
            function showProgress(message, progress) {
                const progressHtml = progress !== undefined ? 
                    \`<div class="progress-bar">
                        <div class="progress-fill" style="width: \${progress}%"></div>
                    </div>\` : '';
                
                resultsContainer.innerHTML = \`<div class="loading-state">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">\${message}</div>
                    \${progressHtml}
                </div>\`;
                updateResultsCount(0);
            }
            
            function renderError(errorMessage) {
                resultsContainer.innerHTML = \`<div class="empty-state">
                    <div class="empty-text">Search Error</div>
                    <div class="empty-subtext">\${errorMessage}</div>
                </div>\`;
                updateResultsCount(0);
            }
            
            function renderResults(results, query) {
                if (results.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">No results found</div><div class="empty-subtext">Try a different search term</div></div>';
                    return;
                }
                
                                 const html = results.map((result, index) => {
                    
                     const isGoTestFile = result.fileName.endsWith('.go') && result.fileName.toLowerCase().includes('test');
                     const testFileClass = isGoTestFile ? 'go-test-file' : '';
                     
                     return \`<div class="result-item \${index === 0 ? 'selected' : ''} \${testFileClass}" onclick="selectResult(\${index})" ondblclick="openResult(\${index})">
                         <div class="result-content">
                             <div class="result-line">\${highlightText(result.lineText.trim(), query)}</div>
                         </div>
                         <div class="result-file-info">
                             <div class="result-file">\${result.fileName}:\${result.lineNumber}</div>
                         </div>
                     </div>\`;
                 }).join('');
                
                resultsContainer.innerHTML = html;
            }
            
            function selectResult(index) {
                selectedIndex = index;
                updateSelection();
                selectFile(currentResults[index]);
            }
            
            function openResult(index) {
                if (currentResults[index]) {
                    vscode.postMessage({
                        type: 'openFile',
                        filePath: currentResults[index].filePath,
                        lineNumber: currentResults[index].lineNumber
                    });
                }
            } 
            
                        function clearPreview() {
                previewHeader.innerHTML = \`
                    <div class="preview-file-info">
                        <div class="preview-file-name">Select a file to preview</div>
                    </div>
                \`;
                previewContent.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-text">No preview available</div>
                        <div class="empty-subtext">Click on a search result to preview</div>
                    </div>
                \`;
            }
            
            function renderPreview(data) {
                previewHeader.innerHTML = \`
                    <div class="preview-file-info">
                        <div class="preview-file-name">
                            \${data.fileName}
                        </div>
                        <div class="preview-file-path">\${vscode.workspace?.asRelativePath(data.filePath) || data.filePath}</div>
                    </div>
                \`;
                
                const lines = data.content.split('\\n');
                const html = lines.map((line, index) => {
                    const lineNumber = index + 1;
                    const isHighlight = lineNumber === data.lineNumber;
                    const highlightedLine = highlightText(line, data.query);
                    
                    return \`<div class="code-line \${isHighlight ? 'highlight' : ''}" data-line="\${lineNumber}">
                        <span class="line-number">\${lineNumber}</span>
                        <span class="line-content">\${highlightedLine}</span>
                    </div>\`;
                }).join('');
                
                previewContent.innerHTML = html;
                
                const highlightLine = previewContent.querySelector('.highlight');
                if (highlightLine) {
                    highlightLine.scrollIntoView({ behavior: 'auto', block: 'center' });
                }
            }
            
            function highlightText(text, query) {
                if (!query || query.length < 2) return escapeHtml(text);
                
                const escapedText = escapeHtml(text);
                const escapedQuery = escapeHtml(query);
                
                const searchText = caseSensitive ? escapedText : escapedText.toLowerCase();
                const searchQuery = caseSensitive ? escapedQuery : escapedQuery.toLowerCase();
                
                let result = '';
                let currentIndex = 0;
                let foundIndex = searchText.indexOf(searchQuery, currentIndex);
                
                while (foundIndex !== -1) {
                    result += escapedText.substring(currentIndex, foundIndex);
                    const matchText = escapedText.substring(foundIndex, foundIndex + escapedQuery.length);
                    result += '<span class="search-highlight">' + matchText + '</span>';
                    
                    currentIndex = foundIndex + escapedQuery.length;
                    foundIndex = searchText.indexOf(searchQuery, currentIndex);
                }
                
                result += escapedText.substring(currentIndex);
                
                return result;
            }
            
            function escapeHtml(text) {
                if (typeof text !== 'string') return '';
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            
            function cleanup() {
                if (searchTimeout) {
                    clearTimeout(searchTimeout);
                }
                focusTimeouts.forEach(timeout => clearTimeout(timeout));
                focusTimeouts = [];
                currentResults = [];
            }
            
            window.addEventListener('beforeunload', cleanup);
            
            window.selectResult = selectResult;
            window.openResult = openResult;
        `;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Find in Files</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
                    background: rgba(0, 0, 0, 0.3);
                    color: var(--vscode-editor-foreground);
                    height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    overflow: hidden;
                    animation: fadeIn 0.2s ease-out;
                }
                
                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        background: transparent;
                    }
                    to {
                        opacity: 1;
                        background: rgba(0, 0, 0, 0.3);
                    }
                }
                
                @keyframes slideIn {
                    from {
                        transform: scale(0.9) translateY(-20px);
                        opacity: 0;
                    }
                    to {
                        transform: scale(1) translateY(0);
                        opacity: 1;
                    }
                }
                
                .floating-window {
                    width: 1100px;
                    height: 800px;
                    max-width: 95vw;
                    max-height: 90vh;
                    background: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 12px;
                    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    position: relative;
                    animation: slideIn 0.3s ease-out;
                }
                
                .search-container {
                    padding: 12px;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: relative;
                }
                
                .search-wrapper {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                
                .search-input-container {
                    position: relative;
                    flex: 1;
                    display: flex;
                    align-items: center;
                }

                .history-dropdown {
                    position: absolute;
                    top: calc(100% + 6px);
                    left: 0;
                    right: 0;
                    max-height: 220px;
                    overflow: auto;
                    border: 1px solid var(--vscode-editorWidget-border);
                    background: var(--vscode-editorWidget-background);
                    border-radius: 6px;
                    z-index: 1000;
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
                }

                .history-dropdown.hidden {
                    display: none;
                }

                .history-item {
                    padding: 8px 10px;
                    cursor: pointer;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .history-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }

                
                .search-controls {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    flex-shrink: 0;
                }
                
                .exclude-wrapper {
                    margin-top: 8px;
                    border-top: 1px solid var(--vscode-panel-border);
                    padding-top: 8px;
                }
                
                .exclude-input-container {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                .exclude-input {
                    flex: 1;
                    padding: 4px 8px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    font-size: 12px;
                    font-weight: 400;
                    transition: all 0.2s ease;
                    height: 24px;
                }
                
                .exclude-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                
                .exclude-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                    opacity: 0.6;
                }
                
                .exclude-toggle-btn {
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    background: var(--vscode-toolbar-hoverBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 3px;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    opacity: 0.7;
                }
                
                .exclude-toggle-btn:hover {
                    background: var(--vscode-list-hoverBackground);
                    border-color: var(--vscode-textLink-foreground);
                    opacity: 0.9;
                }
                
                .exclude-toggle-btn.active {
                    background: var(--vscode-textLink-foreground);
                    border-color: var(--vscode-textLink-foreground);
                    color: var(--vscode-button-foreground);
                    opacity: 1;
                }
                
                .exclude-toggle-btn:not(.active) {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-disabledForeground);
                    opacity: 0.6;
                }
                
                .exclude-toggle-btn:not(.active):hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                    opacity: 0.8;
                }
                
                .case-sensitive-btn {
                    position: absolute;
                    right: 8px;
                    top: 50%;
                    transform: translateY(-50%);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 28px;
                    height: 28px;
                    background: var(--vscode-toolbar-hoverBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    opacity: 0.7;
                    z-index: 10;
                }
                
                .case-sensitive-btn:hover {
                    background: var(--vscode-list-hoverBackground);
                    border-color: var(--vscode-textLink-foreground);
                    opacity: 0.9;
                    transform: translateY(-50%);
                }
                
                .case-sensitive-btn.active {
                    background: var(--vscode-textLink-foreground);
                    border-color: var(--vscode-textLink-foreground);
                    color: var(--vscode-button-foreground);
                    opacity: 1;
                    transform: translateY(-50%);
                }
                
                .case-sensitive-btn.active:hover {
                    background: var(--vscode-textLink-activeForeground);
                    border-color: var(--vscode-textLink-activeForeground);
                    transform: translateY(-50%);
                }
                

                
                .tooltip {
                    position: absolute;
                    top: 120%;
                    left: 50%;
                    transform: translateX(-50%);
                    background: var(--vscode-editorHoverWidget-background);
                    color: var(--vscode-editorHoverWidget-foreground);
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 500;
                    white-space: nowrap;
                    opacity: 0;
                    visibility: hidden;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    pointer-events: none;
                    z-index: 1000;
                    border: 1px solid var(--vscode-editorHoverWidget-border);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                }
                
                .tooltip::before {
                    content: '';
                    position: absolute;
                    bottom: 100%;
                    left: 50%;
                    transform: translateX(-50%);
                    border: 4px solid transparent;
                    border-bottom-color: var(--vscode-editorHoverWidget-background);
                }
                
                .case-sensitive-btn:hover .tooltip,
                .exclude-toggle-btn:hover .tooltip {
                    opacity: 1;
                    visibility: visible;
                    transform: translateX(-50%) translateY(2px);
                }
                
                .search-input {
                    width: 100%;
                    padding: 4px 40px 4px 12px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    font-size: 13px;
                    font-weight: 400;
                    transition: all 0.2s ease;
                    resize: vertical;
                    height: 32px;
                    min-height: 32px;
                    max-height: 80px;
                    overflow-y: auto;
                    font-family: inherit;
                    line-height: 1.3;
                }
                
                .search-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                
                .search-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                    opacity: 0.7;
                }
                
                .results-count {
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                    font-weight: 500;
                    white-space: nowrap;
                    opacity: 0.8;
                }
                
                .content-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    min-height: 0;
                }
                
                .results-container {
                    flex: 0 0 45%;
                    overflow-y: auto;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    min-height: 0;
                    background: var(--vscode-sideBar-background);
                }
                
                .result-item {
                    padding: 6px 12px;
                    cursor: pointer;
                    border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    user-select: none;
                    transition: all 0.15s ease;
                    position: relative;
                    min-height: 28px;
                }
                
                .result-item:hover {
                    background: var(--vscode-list-hoverBackground);
                    transform: translateX(2px);
                }
                
                .result-item.selected {
                    background: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    box-shadow: inset 0 0 10px rgba(0, 122, 255, 0.1);
                }
                
                .result-item.go-test-file {
                    background: rgba(76, 175, 80, 0.1);
                    border-left: 2px solid rgba(76, 175, 80, 0.3);
                }
                
                .result-item.go-test-file:hover {
                    background: rgba(76, 175, 80, 0.15);
                    border-left: 2px solid rgba(76, 175, 80, 0.5);
                }
                
                .result-item.go-test-file.selected {
                    background: rgba(76, 175, 80, 0.2);
                    border-left: 3px solid #4CAF50;
                    box-shadow: inset 0 0 10px rgba(76, 175, 80, 0.2);
                }
                
                .result-content {
                    flex: 1;
                    min-width: 0;
                    margin-right: 12px;
                }
                
                .result-line {
                    font-size: 11px;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace;
                    color: var(--vscode-editor-foreground);
                    line-height: 1.3;
                    word-break: break-word;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                
                .result-file-info {
                    flex-shrink: 0;
                    text-align: right;
                }
                
                .result-file {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 500;
                    opacity: 0.9;
                }
                
                .preview-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    min-height: 0;
                    background: var(--vscode-editor-background);
                }
                
                .preview-header {
                    padding: 12px 16px;
                    background: var(--vscode-editorGroupHeader-tabsBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-size: 13px;
                }
                
                .preview-file-info {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                
                .preview-file-name {
                    font-weight: 600;
                    color: var(--vscode-textLink-foreground);
                }
                
                .preview-file-path {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    opacity: 0.8;
                }
                
                .preview-content {
                    flex: 1;
                    overflow: auto;
                    padding: 0;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace;
                    font-size: 13px;
                    line-height: 1.5;
                    background: var(--vscode-editor-background);
                }
                
                .code-line {
                    display: flex;
                    min-height: 20px;
                    padding: 0 16px;
                    align-items: flex-start;
                    transition: background-color 0.15s ease;
                }
                
                .code-line:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                
                .code-line.highlight {
                    background: var(--vscode-editor-lineHighlightBackground);
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    box-shadow: inset 0 0 10px rgba(0, 122, 255, 0.1);
                }
                
                .line-number {
                    color: var(--vscode-editorLineNumber-foreground);
                    min-width: 60px;
                    text-align: right;
                    padding-right: 16px;
                    user-select: none;
                    flex-shrink: 0;
                    font-weight: 400;
                    opacity: 0.7;
                }
                
                .line-content {
                    flex: 1;
                    white-space: pre;
                    overflow-x: auto;
                    padding-top: 1px;
                }
                
                .search-highlight {
                    background: var(--vscode-editor-findMatchHighlightBackground);
                    color: var(--vscode-editor-findMatchForeground);
                    border-radius: 2px;
                    padding: 1px 2px;
                    font-weight: 500;
                }
                
                .empty-state, .loading-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    padding: 20px;
                    text-align: center;
                    gap: 8px;
                }
                
                .empty-text {
                    color: var(--vscode-descriptionForeground);
                    font-size: 13px;
                    font-weight: 500;
                }
                
                .empty-subtext {
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                    opacity: 0.7;
                }
                
                .loading-spinner {
                    width: 32px;
                    height: 32px;
                    border: 3px solid var(--vscode-panel-border);
                    border-top: 3px solid var(--vscode-textLink-foreground);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin-bottom: 8px;
                }
                
                .loading-text {
                    color: var(--vscode-descriptionForeground);
                    font-size: 14px;
                    font-weight: 500;
                }
                
                .progress-bar {
                    width: 200px;
                    height: 4px;
                    background: var(--vscode-panel-border);
                    border-radius: 2px;
                    overflow: hidden;
                    margin-top: 12px;
                }
                
                .progress-fill {
                    height: 100%;
                    background: var(--vscode-textLink-foreground);
                    transition: width 0.3s ease;
                    border-radius: 2px;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                
                ::-webkit-scrollbar {
                    width: 8px;
                    height: 8px;
                }
                
                ::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }
                
                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 4px;
                }
                
                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }
                
                @media (max-width: 768px) {
                    .search-container {
                        padding: 12px;
                    }
                    
                    .search-input {
                        padding: 10px 10px 10px 36px;
                        font-size: 16px;
                    }
                    
                    .results-container {
                        flex: 0 0 50%;
                    }
                    
                    .result-item {
                        padding: 10px 12px;
                    }
                }
            </style>
        </head>
        <body onclick="handleBackdropClick(event)">
            <div class="floating-window" onclick="event.stopPropagation()">
                <div class="search-container">
                    <div class="search-wrapper">
                        <div class="search-input-container">
                            <textarea class="search-input" placeholder="Search in files... (Shift+Enter for new line, Enter to open, Esc to close)" autofocus tabindex="0" rows="1"></textarea>
                            <div class="history-dropdown hidden" id="historyDropdown"></div>
                            <button class="case-sensitive-btn" type="button">
                                <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M8.854 11.702h-1.18L7.4 10.4H4.6l-.274 1.302H3.146L5.734 5.2h1.132l2.588 6.502zM7.1 9.402L6.014 6.4h-.028L4.9 9.402H7.1z"/>
                                    <path d="M12.314 11.702h-.992l-.274-.302c-.284.268-.68.402-1.188.402-.396 0-.734-.114-1.014-.342-.28-.228-.42-.532-.42-.912 0-.424.168-.754.504-1.004C9.264 9.284 9.714 9.16 10.3 9.16h1.014v-.158c0-.256-.07-.448-.21-.576-.14-.128-.35-.192-.63-.192-.224 0-.406.048-.546.144-.14.096-.21.228-.21.396h-.994c0-.268.094-.504.282-.708.188-.204.434-.358.738-.462.304-.104.628-.156.972-.156.608 0 1.092.148 1.452.444.36.296.54.724.54 1.284v2.688zm-1.008-.84v-.588H10.3c-.308 0-.532.06-.672.18-.14.12-.21.274-.21.462 0 .168.054.302.162.402.108.1.258.15.45.15.216 0 .402-.068.558-.204.156-.136.234-.31.234-.522z"/>
                                </svg>
                                <div class="tooltip">Case Sensitive</div>
                            </button>
                        </div>
                        <div class="search-controls">
                            <label class="scope-label">
                                <input type="checkbox" id="searchAllFilesToggle" />
                                <span>Search in All Files</span>
                            </label>
                            <div class="results-count"></div>
                        </div>
                    </div>
                    <div class="exclude-wrapper">
                        <div class="exclude-input-container">
                            <input class="exclude-input" placeholder="Exclude paths (e.g., node_modules, *.test.js, dist/)" type="text">
                            <button class="exclude-toggle-btn" type="button">
                                <svg class="eye-open" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/>
                                    <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>
                                </svg>
                                <svg class="eye-closed" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="display: none;">
                                    <path d="m10.79 12.912-1.614-1.615a3.5 3.5 0 0 1-4.474-4.474l-2.06-2.06C.938 6.278 0 8 0 8s3 5.5 8 5.5a7.029 7.029 0 0 0 2.79-.588zM5.21 3.088A7.028 7.028 0 0 1 8 2.5c5 0 8 5.5 8 5.5s-.939 1.721-2.641 3.238l-2.062-2.062a3.5 3.5 0 0 0-4.474-4.474L5.21 3.089z"/>
                                    <path d="M5.525 7.646a2.5 2.5 0 0 0 2.829 2.829l-2.83-2.829zm4.95.708-2.829-2.83a2.5 2.5 0 0 1 2.829 2.829zm3.171 6-12-12 .708-.708 12 12-.708.708z"/>
                                </svg>
                                <div class="tooltip">Enable/Disable Exclude Patterns</div>
                            </button>
                        </div>
                    </div>
                </div>
                
                <div class="content-container">
                    <div class="results-container">
                        <div class="empty-state">
                            <div class="empty-text">Start typing to search...</div>
                        </div>
                    </div>
                    
                    <div class="preview-container">
                        <div class="preview-header">
                            <div class="preview-file-info">
                                <div class="preview-file-name">Select a file to preview</div>
                            </div>
                        </div>
                        <div class="preview-content">
                            <div class="empty-state">
                                <div class="empty-text">No preview available</div>
                                <div class="empty-subtext">Click on a search result to preview</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                ${scriptContent}
            </script>
        </body>
        </html>`;
    }

    public dispose(): void {
       if (this.searchProvider) {
            this.searchProvider.dispose();
        }
        
        // Abort any ongoing search
        if (this.abortController) {
            this.abortController.abort();
        }
        SearchModal.currentModal = undefined;
        
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
        
    }
} 