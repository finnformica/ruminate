### Added

- Typing a bracket or a quote over selected text wraps it instead of replacing it. Select a phrase and press <kbd>(</kbd> and it is in parentheses; `[`, `{`, `<`, a quote, a backtick, `*`, `_` and `~` do the same, a bracket closing with its partner. Unlike <kbd>⌘</kbd> <kbd>B</kbd> and its family these only ever add, so wrapping twice gives you two pairs. With nothing selected the character types as it always did.
- A Ruminate link now shows a picture when you paste it into a message. The app's own address and an invite link each unfurl as a card saying what they are. Nothing is said about any other address: a note's link still unfurls as nothing but its own name.

### Changed

- The fold arrow and a to-do's box no longer end the edit you are in. Reaching for either while typing used to close the block and lose your place; now the caret stays exactly where it was and you carry on.
- **Copy markdown** follows the view. Zoomed into a block, it copies that block and everything beneath it — what is on screen — where it used to copy the whole note behind it.

### Fixed

- <kbd>↵</kbd> then <kbd>⇥</kbd> no longer folds the block you just nested into. Making a new line and indenting it closed the line above the moment it became a parent, taking the row you were typing in with it. The block you nest under now stays open, and stays open next time you come back.
- Blank rows no longer collect in **Unassigned**. An empty line with something indented under it was kept when you removed it, so the basket showed a blank row with what you actually wanted rescued hidden beneath it. The empty line goes now and what it held stands there instead.
