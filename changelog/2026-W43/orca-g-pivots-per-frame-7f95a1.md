### Added

- See what holds a block. Open a block's menu (or press and hold it on a phone) and choose **Show upstream**: the rows beneath it become the blocks and notes that hold it, and a small arrow shows beside its chevron. Inside those rows, **Show downstream** shows what a block holds. Press <kbd>p</kbd> on a selected block to do the same, and press it again to go back. Each pane and each view in a pane's trail keeps its own.
- Choose **Show upstream** in a note's ⋯ menu to see what holds the whole note. Press Back to return to the note.

### Changed

- A note's folds are part of its address now, as a focused view's already were. A link, a reload and Back open the note with the folds you left, on any device. A note opened again from the sidebar starts with the usual folds. Folds you made before this change come back once, the first time you open the note.
- A block you indent or outdent keeps its folds, and the folds of the blocks beneath it.

### Removed

- The **Show links** setting under Settings → Editor. **Show upstream** on a block replaces it.

### Fixed

- A breadcrumb above a focused block opened from Views goes back up, and no longer adds the view again at the end of the trail. Before, clicking the note's crumb read "Note › Block › Note".
