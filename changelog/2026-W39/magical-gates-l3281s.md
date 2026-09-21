### Added

- A bar for the selected blocks. Select more than one block and a bar rises at the bottom of the window with the count, **Indent**, **Outdent** and **Remove**, and an **Actions** menu with everything the keys can do to a selection — turn into, duplicate, move up or down, copy, cut and remove — each acting on every selected block. It greys what the selection cannot take, and sinks away when the selection collapses back to one block.
- Select blocks with the mouse. Sweeping across rows selects every row the sweep touched, and <kbd>⇧</kbd>-click extends the selection to the clicked row — the same selection <kbd>⇧</kbd> <kbd>↑/↓</kbd> makes, so <kbd>⇥</kbd>, delete, copy and the rest act on all of it.

### Fixed

- Indenting several selected blocks now moves them together. Before, blocks selected by sweeping the mouse across them indented only the first; and when the first selected block had nothing above it to nest under, the rest nested under it instead of staying put.
