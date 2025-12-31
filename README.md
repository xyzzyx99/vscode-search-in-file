# EasySearch - Search in Files

Fast and powerful file search extension with JetBrains-like functionality. Search text across all files in your workspace with instant results and navigation.

## Demo

 <img src="https://github.com/bayraktugrul/vscode-search-in-file/blob/main/images/demo-comp.gif?raw=true" width="650" height="400" alt="demo"/>

*See EasySearch in action: Press `Shift+F`, type your search query, navigate with arrow keys, and open files instantly!*

## Important: Change keybinding & use VS Code's Native Search Shortcut for EasySearch

By default, EasySearch uses `Shift+F` as its keyboard shortcut. However, if you prefer using VS Code's native search shortcut (`Cmd+Shift+F` on macOS, `Ctrl+Shift+F` on Windows/Linux), you can easily set this up:

1. Open Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux)
2. Type "Preferences: Open Keyboard Shortcuts (JSON)"
3. Add these entries to your `keybindings.json`:

```jsonc
{
    "key": "cmd+shift+f",
    "command": "-workbench.action.findInFiles",
    "when": "isMac"
},
{
    "key": "ctrl+shift+f",
    "command": "-workbench.action.findInFiles",
    "when": "isLinux || isWindows"
},
{
    "key": "cmd+shift+f",
    "command": "easySearch.searchInFiles",
    "when": "isMac"
},
{
    "key": "ctrl+shift+f",
    "command": "easySearch.searchInFiles",
    "when": "isLinux || isWindows"
},
{
  "key": "shift+f",
  "command": "-easySearch.searchInFiles"
}
```

4. Save the file and reload VS Code (`Cmd+Shift+P` → "Developer: Reload Window")

Now you can use default VS Code's native `Cmd+Shift+F` / `Ctrl+Shift+F` shortcut for EasySearch.

## Features

- **Lightning Fast Search**: Optimized file indexing and search algorithms for instant results
- **Smart Navigation**: Use arrow keys to navigate through search results
- **Real-time Results**: See search results as you type with intelligent debouncing
- **Performance Optimized**: 
  - Batch processing for large codebases
  - Memory-efficient file indexing with cleanup
  - Automatic search cancellation to prevent freezing
- **User-Friendly Interface**: Clean, intuitive search modal with highlighted matches
- **Keyboard Shortcuts**: Quick access with `Shift+F` shortcut (customizable to `Cmd+Shift+F` / `Ctrl+Shift+F`)
- **Multi-line Search Support**: Search across multiple lines in files
- **Safe Search**: Handles special characters and regex patterns safely

## Installation

1. Open Visual Studio Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "EasySearch - Search in Files"
4. Click Install

## Usage

### Quick Start

1. Press `Shift+F` to open the search modal (or your custom shortcut if configured)
2. Type your search query
3. Use arrow keys (↑/↓) to navigate through results
4. Press `Enter` to open the selected file
5. Press `Escape` to close the search modal

### Compilation

- npm install --save-dev @types/vscode
- yes | npx @vscode/vsce@latest package
