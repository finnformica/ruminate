### Changed

- Folds made in a filtered or sorted note are remembered. Put the same filter and sort on again and the rows you folded are still folded; a different narrowing opens fully, as it always has, and the note's own folds stay untouched underneath. They used to be forgotten the moment the filter or sort changed.

### Fixed

- A filtered or sorted note now edits like the note itself. Press <kbd>↵</kbd> for a new row, indent, move or remove rows while a filter or sort is on, and the change lands in the note where you made it — a row added under a to-do follows that to-do in the note, ahead of anything the filter was hiding. Rows the filter hides are never touched, and a sort never rewrites the note's own order. Until now only a row's text, type and properties could be changed while narrowed; anything else was silently dropped.
