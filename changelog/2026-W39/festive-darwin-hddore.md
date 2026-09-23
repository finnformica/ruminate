### Changed

- The selection bar's removal item is named as the block menu names it. It reads **Unlink** in a note's outline, where the blocks stay held elsewhere or in Unassigned, and **Delete** where removing the row is the delete; in a note the bar also offers the menu's **Delete**, which removes the selected blocks from every place they appear.
- <kbd>x</kbd> on a selection toggles every to-do in it.
- <kbd>Esc</kbd> on a selection first collapses it to the highlighted block, then deselects — the same key on the selection bar's clear button.

### Fixed

- The block menu now acts on every selected block. Opened on a row of a selection, its **Copy**, **Duplicate**, **Move up** / **Move down**, **Unlink** and **Delete** take the whole selection and say how many blocks that is (**Delete 3 blocks**). Before, they acted on the one row under the pointer while the rest of the selection stayed highlighted, which looked like nothing had happened.
