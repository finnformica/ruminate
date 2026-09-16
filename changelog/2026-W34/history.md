### Added

- Your GitHub sign-in stays connected. Access tokens are refreshed silently in the background, so sync no longer breaks every few hours and forces you to sign out and back in. When signing in again genuinely is needed, the sidebar shows a clear, clickable **Sign in soon** or **Signed out** status rather than a generic sync error.
- Hovering a note in the sidebar reveals a **⋯** actions menu. Pin, copy, rename or delete any note without opening it first. It is the same menu the open note uses, so the actions match everywhere.
- The sidebar has a **Calendar** link, reached with <kbd>g</kbd> then <kbd>d</kbd>, which opens today's daily note.
- Select several blocks at once with <kbd>⇧</kbd> <kbd>↑</kbd> and <kbd>⇧</kbd> <kbd>↓</kbd>, then indent, delete, copy or cut them together.
- Richer keyboard navigation of the outline. <kbd>⌥</kbd> with the arrows jumps across siblings at the same level, skipping their children, and <kbd>⌘</kbd> with the arrows jumps to the top or bottom of the current level. The note title is reachable too: <kbd>↑</kbd> from the first block selects it, and <kbd>↓</kbd> drops back in.

### Changed

- Daily notes use the same outline editor as the rest of your notes. Weekly notes and inline property editing moved onto it in the same pass, so reading and writing work the same way wherever you are in the app.
- The block editor is the only editor in the app. The old text editor is gone from every surface that still used it.
- The editor feels more like an outliner. <kbd>↵</kbd> starts a bullet by default and nests under a heading, <kbd>⇧</kbd> <kbd>↵</kbd> is a plain line break, <kbd>space</kbd> never scrolls the page, <kbd>Tab</kbd> and <kbd>⌫</kbd> work on a highlighted block without entering it, and there is always a blank block waiting at the bottom.
- Headings are sized by how deeply they are nested in the outline, not by how many hashes you type. The sizes run down to a bold, underlined floor at body size, with a little breathing room above them.
- Reorder a block and everything under it with <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↑</kbd> and <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↓</kbd>.
- Undo and redo survive saving a note.
- The app icon is a monospace `#`.

### Removed

- Vim mode, along with the old text-editor engine it belonged to. Cursor-position template insertion and drag-to-attach were part of that editor and went with it.

### Fixed

- A highlighted block reliably responds to the keyboard. The arrow keys move the highlight rather than scrolling the page, whichever block you are on.
- The keyboard keeps working after you click elsewhere on the page. The highlighted block stays live instead of silently losing focus.
- Every copy action goes through one path, so the result is always clean markdown. That covers <kbd>⌘</kbd> <kbd>C</kbd>, a multi-block selection, **Copy markdown** in the menu and the command palette: blank lines fall between paragraphs, checkboxes are real task-list boxes, and no stray metadata line is ever written.
- Note previews render properly again, with no raw block metadata in the cards.
- Undo re-highlights a block it brought back, so a delete followed by an undo lands you back on it.
- <kbd>⇧</kbd> <kbd>↵</kbd> splits into a new block of the same type, so a heading stays a heading. <kbd>⌘</kbd> <kbd>↵</kbd> makes a new block below from anywhere, including a new root block from the note title.
- A new block made below a highlighted heading or checkbox keeps that type rather than becoming a bullet.
- The highlighted block scrolls itself back into the middle of the screen as it moves off, rather than drifting out of view.
- Stepping the highlight through the outline glides. It eases the block into the middle of the view, and only when needed, rather than yanking to centre on tall headings.
- <kbd>⌘</kbd> <kbd>⇧</kbd> with the arrows moves the highlighted block again. It had started extending the selection instead.
- <kbd>⌘</kbd> <kbd>C</kbd> copies a single highlighted block again.
- While editing the note title, <kbd>↓</kbd> drops into the first block below, already editing with the caret ready, matching how <kbd>↓</kbd> moves between blocks.
- <kbd>Tab</kbd> and <kbd>⇧</kbd> <kbd>Tab</kbd> while editing a block keep the cursor where it is rather than jumping it to the end of the line.
- Deleting the note you are viewing takes you back to the notes list.
- Daily notes stay pinned to their date wherever in the world you open them. A note's day is worked out in your own timezone, so travelling no longer shifts which note a date opens.
