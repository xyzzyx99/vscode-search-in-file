import * as vscode from 'vscode';
import { SearchResult, SearchType } from './types';
import { TextSearcher } from './textSearcher';

export class SearchProvider {
    private textSearcher: TextSearcher;
    private progressCallback?: (message: string, progress?: number) => void;

    private readonly options?: { currentFileOnly?: boolean; currentFileUri?: vscode.Uri };

    constructor(context: vscode.ExtensionContext, options?: { currentFileOnly?: boolean; currentFileUri?: vscode.Uri }) {
        this.textSearcher = new TextSearcher(context);
        this.options = options;

        // Set up progress reporting
        this.textSearcher.setProgressCallback((message: string, progress?: number) => {
            //message.query = "test";
            // message ="test";
            if (this.progressCallback) {
                this.progressCallback(message, progress);
            }
        });
    }

    public setProgressCallback(callback: (message: string, progress?: number) => void): void {
        this.progressCallback = callback;
    }

    async search(query: string, signal?: AbortSignal, options?: { currentFileOnly?: boolean; currentFileUri?: vscode.Uri }): Promise<SearchResult[]> {
        try {
            // Ensure searcher is ready before starting search
            await this.textSearcher.waitForReady();

            // If requested, search only within the current file (single document URI).
            const effectiveCurrentFileOnly = options?.currentFileOnly ?? this.options?.currentFileOnly;
            const effectiveUri = options?.currentFileUri ?? this.options?.currentFileUri;

            if (effectiveCurrentFileOnly && effectiveUri) {
                return await this.searchInSingleDocument(effectiveUri, query, signal);
            }

            return await this.textSearcher.search(query, signal);
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Search cancelled');
            }
            console.error('Search provider error:', error);
            throw error;
        }
    }

    
    private async searchInSingleDocument(
        uri: vscode.Uri,
        query: string,
        signal?: AbortSignal
    ): Promise<SearchResult[]> {
        const q = (query ?? '').trim();
        if (!q) return [];

        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const caseSensitive = this.textSearcher.getCaseSensitive();

        // Treat query as a literal substring (not regex), matching the current extension behavior.
        const needle = caseSensitive ? q : q.toLowerCase();
        const results: SearchResult[] = [];

        // Scan line-by-line so we can return ranges.
        for (let line = 0; line < doc.lineCount; line++) {
            if (signal?.aborted) {
                throw new Error('Search cancelled');
            }

            const lineText = doc.lineAt(line).text;
            const hay = caseSensitive ? lineText : lineText.toLowerCase();

            let from = 0;
            while (true) {
                const at = hay.indexOf(needle, from);
                if (at === -1) break;

                const start = new vscode.Position(line, at);
                const end = new vscode.Position(line, at + q.length);
                const range = new vscode.Range(start, end);

                // 'detail' is what SearchModal uses as the line preview.
                results.push({
                    uri,
                    range,
                    detail: lineText
                } as unknown as SearchResult);

                from = at + Math.max(1, q.length);
            }
        }

        return results;
    }

public getSearchState() {
        return this.textSearcher.getSearchState();
    }

    public async waitForReady(): Promise<void> {
        await this.textSearcher.waitForReady();
    }

    public async setCaseSensitive(caseSensitive: boolean): Promise<void> {
        await this.textSearcher.setCaseSensitive(caseSensitive);
    }

    public getCaseSensitive(): boolean {
        return this.textSearcher.getCaseSensitive();
    }

    public async setExcludePatterns(patterns: string[], enabled: boolean): Promise<void> {
        await this.textSearcher.setExcludePatterns(patterns, enabled);
    }

    public async getExcludePatterns(): Promise<{ patterns: string[], enabled: boolean }> {
        return await this.textSearcher.getExcludePatterns();
    }

    public dispose(): void {
        this.textSearcher.dispose();
    }
} 