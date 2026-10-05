### Changed

- A marker key on an empty highlighted block changes its type and leaves it highlighted. <kbd>-</kbd>, <kbd>#</kbd>, <kbd>[</kbd> and the rest now treat an empty block like any other: the type changes and the highlight stays, and <kbd>↵</kbd> opens it. They used to open the empty block for editing as well.

### Fixed

- Removing a highlighted block leaves the block that takes its place highlighted. Press <kbd>⌫</kbd> or <kbd>⌦</kbd> on a highlighted row and the row that slides into its place is highlighted, exactly as it is after a delete from the right-click menu or the selection bar; it was briefly opened for editing instead. Removing a row while typing in it, from a phone's edit bar, still carries the typing on in the row that takes its place: whatever you were doing, you are still doing it.
- Backspace at the start of an empty first block carries on editing the block that takes its place. There is nothing above the first block to merge into, so the caret stays where it was, at the start of the row now sitting there; it used to highlight that row instead.
