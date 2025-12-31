# Change Log

All notable changes to the "EasySearch - Search in Files" extension will be documented in this file.

## [1.0.6] - 2025-12-30

### Added
- Context menu
- History list
- Use selection and word at cursor for initial search

## [1.0.1] - 2025-06-10

### Added
- Demo GIF showing extension functionality in README
- Visual demonstration of search workflow

### Improved
- README presentation with visual examples
- Better marketplace presentation

## [1.0.0] - 2025-06-10

### Added
- Initial release of EasySearch - Search in Files extension
- Fast file search with JetBrains-like functionality
- Intelligent file indexing system for optimal performance
- Memory-efficient batch processing (20 files at a time)
- Real-time search results with debouncing (150ms)
- Arrow key navigation through search results
- Safe handling of special characters and regex patterns
- Automatic search cancellation to prevent freezing
- Memory management with automatic cleanup every 5 minutes
- Support for multi-line text searching
- `Shift+F` keyboard shortcut for quick access
- Clean and intuitive search modal interface
- File size limits (512KB max) and index limits (5000 files max)
- Highlighted search matches in results
- Direct navigation to matching line in files

### Features
- **Performance Optimization**: File indexing, batch processing, memory cleanup
- **User Experience**: Arrow key navigation, instant results, highlighted matches
- **Reliability**: Safe character handling, search cancellation, memory limits
- **Accessibility**: Keyboard shortcuts, clear visual feedback, responsive interface

### Technical Details
- TypeScript implementation
- VS Code API compatibility (^1.74.0)
- AbortController for proper search cancellation
- Map-based file indexing with metadata
- Debounced search input handling
- WebView-based search modal interface 