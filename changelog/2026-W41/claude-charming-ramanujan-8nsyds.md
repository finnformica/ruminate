### Added

- Rows you remove from a note shared with you wait in an **Unassigned** basket beneath it. As in your own notes, a removed row and everything under it sit there to edit, paste back or delete, and <kbd>⌘Z</kbd> puts the row back. The basket holds what you removed on this device since the page was opened; reloading the page empties it.

### Changed

- A note is shared to read, or to read and edit; there is no separate permission to delete. Editing already let someone empty every block and remove every row, so the extra switch only ever stopped them taking out a blank line — which is what <kbd>⌫</kbd> on an emptied row does. A share made with **Edit** now lets the person delete blocks too. The shared note or block itself stays the owner's to delete.

### Fixed

- Undo works again in a note shared with you. Taking back a removed row, or redoing a block you had just undone, used to be refused — "A change to a shared note was refused" — and the row came back for a moment before vanishing.
- Text in a shared note no longer flickers back after you delete it. A pull landing while you were still typing could put the owner's copy on screen for a second or two before your change caught up.
