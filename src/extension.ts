import * as vscode from 'vscode';
import { SearchModal } from './searchModal';

export function activate(context: vscode.ExtensionContext) {
    const searchInFiles = vscode.commands.registerCommand('easySearch.searchInFiles', async () => {
        const editor = vscode.window.activeTextEditor;
        SearchModal.createOrShow(context, editor);
    });

    const searchInCurrentFile = vscode.commands.registerCommand('easySearch.searchInCurrentFile', async () => {
        const editor = vscode.window.activeTextEditor;
        SearchModal.createOrShow(context, editor, { currentFileOnly: true });
    });

    context.subscriptions.push(searchInFiles, searchInCurrentFile);
}

export function deactivate() {}
