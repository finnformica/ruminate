# Changelog

## 2026-W35

### Fixed

- Sync between devices no longer gets permanently stuck. Conflicting edits now merge automatically, your version wins for the conflicting lines, and the other device's version is saved as a visible "conflict" note so nothing is ever lost. Signing out and back in is no longer the fix, and folding blocks no longer causes cross-device conflicts at all.
- Changes pulled from another device now appear in the open note immediately, no page refresh needed. If you have unsaved edits, a small notice offers "Show latest" instead of overwriting your typing.
- When sync does fail, the sidebar now says why (network, sign-in, conflict) and clicking retries. Settings gains a "Reset local copy" that backs up any unpushed notes as conflict copies before re-cloning, so recovery can't destroy work. Page loads also stop stalling on a GitHub token refresh.

### New

- Zoom into any block with <kbd>F</kbd> (or <kbd>⌘.</kbd>, or a click on its bullet) and its subtree becomes the whole page, with a clickable breadcrumb trail showing how you got there. <kbd>⇧F</kbd> goes up one level, <kbd>⌘⇧.</kbd> exits fully, and zoom lives in the URL so the back button and deep links just work.
- Jump to any heading in the current note with <kbd>⌘P</kbd> (or type `@` in <kbd>⌘K</kbd>). Unfiltered you get the note's outline as an indented tree; typing filters to matches with their parent path shown. Arrowing previews the target behind the dialog, <kbd>Enter</kbd> jumps, <kbd>Esc</kbd> puts everything back exactly as it was. Nested and unsaved headings are included, which the old search missed.
- Press <kbd>⌘A</kbd> repeatedly to grow the selection through the outline: first the block and its visible children, then the parent and its subtree, on up to the whole page. <kbd>⌘⇧A</kbd> steps back down. Every action (indent, move, duplicate, copy, delete) works on whatever the ladder has selected.
- Duplicate a block and its subtree with <kbd>⇧⌥↑</kbd> / <kbd>⇧⌥↓</kbd>, on a single block or a whole selection.
- Press <kbd>?</kbd> anywhere you're not typing for a complete, searchable reference of every shortcut in the app, grouped by context and always in sync with what the keys actually do.
- Get around without the mouse: <kbd>g</kbd> then <kbd>d</kbd>/<kbd>n</kbd>/<kbd>t</kbd>/<kbd>s</kbd> goes to today's note, notes, tags, or settings, <kbd>/</kbd> focuses search on list pages, and <kbd>⌘[</kbd> / <kbd>⌘]</kbd> walk back and forward through your history.

### Improved

- Paste works without entering a block first. <kbd>⌘V</kbd> on a highlighted block inserts the clipboard below it, splitting lines into blocks and preserving nesting. Rich content from Notion, Google Docs, or the web converts to markdown (headings, lists, checkboxes, links, code), and copying between Ruminate notes round-trips block structure exactly. <kbd>⌘⇧V</kbd> pastes as plain text when you don't want any of that.
- Arrow keys now finish editing at a block's edge: <kbd>↑</kbd> from the first line or <kbd>↓</kbd> from the last drops you back to the rendered view with the neighbouring block highlighted, instead of carrying the raw-markdown editor along. <kbd>Esc</kbd> now also clears the highlight entirely, and arrows pick it back up.
- Move a block with <kbd>⌥↑</kbd> / <kbd>⌥↓</kbd> as well as <kbd>⌘⇧↑</kbd> / <kbd>⌘⇧↓</kbd>, matching editor muscle memory. Sibling jumping moved to <kbd>⌘⌥↑</kbd> / <kbd>⌘⌥↓</kbd>. Moving and duplicating work on multi-block selections too.
- Pasted outlines indented with tabs or four spaces keep their nesting instead of flattening.

### Fixed

- Checkboxes survive copy and paste. Copied todos used to re-paste as plain bullets with a literal `[ ]` in the text.
- Pasting content that carries block ids can no longer silently overwrite existing blocks with the same id, and pasting no longer breaks references to the block you pasted into.
- Arrow keys no longer go dead after collapsing the section your highlight was inside. They now land on the collapsed parent.
- Cutting a mouse selection that spans several blocks now copies and removes them. It used to do nothing. It only takes over when whole blocks are selected, so a partial selection never deletes more than you chose.
- The help panel no longer lists shortcuts that were removed with the old editor, and its links point at this project again.

## 2026-W34

### New

- Your GitHub sign-in now stays connected. Access tokens are refreshed silently in the background, so sync no longer breaks every few hours and forces you to sign out and back in. When re-authentication genuinely is needed (after a long time away, or if you revoke access), the sidebar shows a clear, clickable **Sign in soon** / **Signed out** status instead of a generic "Sync error". The long-lived refresh token is kept in a secure, server-only cookie and never exposed to the page.
- Past days in the calendar now show what you actually wrote that day, reconstructed from your Git history. It's a read-only view that merges every note you touched, with that day's note first — while today stays fully editable as before. Commit times are shown in your current timezone, and daily notes stay pinned to their date wherever in the world you open them.
- Hovering a note in the sidebar now reveals a three-dots actions menu — pin, copy, rename, open in GitHub, or delete any note without opening it first. It's the same menu the open note uses, so the actions match everywhere.
- Select several blocks at once with <kbd>⇧↑</kbd> / <kbd>⇧↓</kbd>, then indent, delete, copy, or cut them together.
- Richer keyboard navigation of the outline: <kbd>⌥↑/↓</kbd> jumps across siblings at the same level (skipping their children), and <kbd>⌘↑/↓</kbd> jumps to the top/bottom of the current level. The note title is reachable too — <kbd>↑</kbd> from the first block selects it, <kbd>↓</kbd> drops back in.

### Changed

- Daily notes now use the same block/outline editor as the rest of your notes, and past days render their history as blocks too — one consistent editing and reading experience across the app.
- The block editor is now the only editor in the app — weekly notes and inline property editing moved onto it too, so editing works the same everywhere.
- Note previews render properly again — no more raw block metadata in the cards.
- The Notes view now defaults to a list.
- Headings are now sized by how deeply they're nested in the outline (down to a bold, underlined body-size floor) rather than by how many `#`s you type, with a little breathing room above them.
- The editor feels more like an outliner: <kbd>Enter</kbd> starts a bullet by default (and nests under a heading), <kbd>⇧Enter</kbd> is a plain line break, <kbd>Space</kbd> never scrolls the page, <kbd>Tab</kbd>/<kbd>⇧Tab</kbd> and <kbd>⌫</kbd> work on a highlighted block without entering it, and there's always a blank block waiting at the bottom.
- Reorder a block and its subtree with <kbd>⌘⇧↑</kbd> / <kbd>⌘⇧↓</kbd>.
- Undo and redo now survive saving a note.
- The app icon is now a monospace `#`.

### Fixed

- A highlighted block now reliably responds to the keyboard — arrow keys move the highlight instead of scrolling the page, whichever block you're on.
- Copying a note or block produces clean markdown again (no stray `id::` lines or block metadata), through a single copy path everywhere.
- Undo now re-highlights a block it brought back, so a delete + undo lands you back on it.
- <kbd>⇧Enter</kbd> now splits into a new block of the same type (a heading stays a heading), and <kbd>⌘Enter</kbd> makes a new block below from anywhere — including a new root block from the note title.
- A new block made below a highlighted heading or checkbox now keeps that type (a heading stays a heading, a checkbox stays a checkbox) instead of becoming a bullet.
- The keyboard keeps working after you click elsewhere on the page — the highlighted block stays live instead of silently losing focus.
- The highlighted block now scrolls itself back into the middle of the screen as it moves off, instead of drifting out of view.
- <kbd>⌘⇧↑/↓</kbd> now moves the highlighted block again (it had started extending the selection instead).
- <kbd>⌘C</kbd> copies a single highlighted block again.
- While editing the note title, <kbd>↓</kbd> now drops into the first block below.
- Stepping the highlight through the outline now glides — it eases the block into the middle of the view and only when needed, instead of yanking to centre on tall headings.
- Every copy action (<kbd>⌘C</kbd>, a multi-block selection, "Copy markdown" in the menu and command palette) now goes through one path, so the result is always clean markdown — blank lines between paragraphs, real task-list checkboxes, and never a stray `id::` line.
- Pressing <kbd>↓</kbd> while renaming the note title now drops into the first block already editing (caret ready), matching how <kbd>↓</kbd> moves between blocks.
- Deleting the note you're currently viewing now takes you back to the notes list.
- <kbd>⇥</kbd> / <kbd>⇧⇥</kbd> while editing a block now keep the cursor where it is instead of jumping it to the end of the line.
- The sidebar note actions menu now sits beside the note name (which truncates to make room) instead of overlapping it.

### Removed

- Vim mode has been removed along with the old CodeMirror-based editor. (In-editor wikilink/date autocomplete, cursor-position template insertion, and drag-to-attach were part of that editor and are tracked to be rebuilt on the block editor.)

## 2026-W08

### Improved

- Move tasks to any note, not just Today/Tomorrow/Next week. The "Move to" menu now lets you search across your notes, use natural dates ("friday", "next month", "in 2 weeks"), or create a new note on the fly.

## 2026-W06

### New

- Notes with an IMDb `url` now display movie and TV poster art, similar to how notes with an `isbn` show book covers.

### Improved

- Cheatsheet dialog replaced with a help panel (⌘/) that stays open while you work, so you can reference shortcuts or markdown syntax without interrupting what you're doing.
- Hovering a footnote reference now shows a preview of the footnote content, so you can read it without jumping to the bottom of the page.
- "Read" and "Write" renamed to "View" and "Edit" in the note page mode switcher for clarity.

### Fixed

- Quotes in shared note titles now display correctly in link previews (e.g. when sharing a note on Discord or Twitter).
