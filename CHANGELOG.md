# Changelog

## 2026-W36

### Changed

- Signups are open: anyone can now sign in with GitHub and get their own private notes database. The invite allowlist is switched off (it remains available if access ever needs gating again).

### New

- Search can now filter by block type, so you can pull up every unchecked checkbox in your notes with `type:todo`. It works anywhere you search and combines with everything else: `type:todo tag:work` finds open todos in work notes, `type:todo milk` narrows them by text, and values like `done`, `task`, `heading`, `list`, `quote`, and `code` filter for other kinds of blocks. See the query language docs for the full list.
- Ruminate now supports accounts. Each user who signs in gets their own private database, fully separate from everyone else's, so inviting someone no longer means sharing yours. Access is invite-only for now: sign-ins are checked against an allowlist, and anyone not on it is politely turned away. Existing notes move over automatically on first sync, and nothing changes in how you write, save, or sync.

## 2026-W35

### Changed

- Notes now save themselves. Every change is written to the database moments after you stop typing, and immediately when you switch away, refresh, or close the tab, so there is no Save button, no unsaved-changes state, and nothing to lose. <kbd>⌘S</kbd> still works as "save right now", and a quiet "Saving…" appears while a save is in flight. The "updated on another device" warning and its "Save mine anyway" choice are gone along with the local drafts they guarded: with every edit already in the database, conflicts resolve block by block to the most recent edit, and the losing version stays a click away in the note's history.
- Notes now open with a tidy amount of detail instead of everything unfolded: headings are always expanded, the first two levels beneath them are visible, and anything deeper starts collapsed. Your own folding and unfolding is remembered on each device on top of that default. Collapse state no longer syncs between devices, so folding on your phone never touches how a note looks on your laptop.
- Sync now works block by block instead of note by note. Editing different parts of the same note on two devices no longer makes the later save overwrite the whole note, only edits to the very same block still resolve to the most recent save.

- Your notes now live in a database instead of a GitHub repository. Sign in and they're just there — no repository to choose, no cloning, no commit/push cycles. Everything is stored in a local database on your device (so the app works fully offline) and syncs to the cloud automatically: every save is pushed in the background within seconds, and opening the app — or returning to its tab, or coming back online — pulls what you wrote on other devices. When the same note is edited on two devices, the most recent edit wins, block by block. GitHub remains only your sign-in.
- Settings → Storage now shows the live state of your data: local database status, pending cloud pushes, remote row counts, and a "Push full copy to D1 now" button for peace of mind. The sidebar sync indicator reflects the same thing — "Syncing…" until your last save has reached the cloud.

### Fixed

- When your GitHub session expires, the app now says so and returns you to the sign-in screen, with your notes reloading as soon as you sign back in. It used to show a misleading "can't reach the notes database" message, which is now reserved for actually being offline.
- Opening Ruminate in a second tab no longer shows a silently empty app. The second tab now explains that your notes are open in another tab, works on a temporary copy in the meantime, and offers a one-click reload once the other tab is closed.
- Switching away from the tab right after typing no longer risks leaving that save behind: pending changes are pushed to the cloud immediately when the tab is hidden or closed, and returning to the app pulls the latest changes right away.
- A stale device can no longer quietly revert your newer edits. When two devices' changes collide, the newest edit now wins, and a banner tells you a merge happened with a "View previous version" action that opens the note's history on the exact version that lost — so the silent-overwrite path that reverted a restructured note is closed, and nothing is ever lost.
- Sync between devices no longer gets permanently stuck. Conflicting edits now merge automatically, the newest version wins for the conflicting lines, and the losing version stays a click away in the note's version history — no extra "conflict" notes cluttering your list, and nothing is ever lost. Signing out and back in is no longer the fix, and folding blocks no longer causes cross-device conflicts at all.
- Changes pulled from another device now appear in the open note immediately, no page refresh needed. If you're mid-edit, your typing is never interrupted or overwritten; your next autosave settles the note.
- When sync does fail, the sidebar now says why (network, sign-in, conflict) and clicking retries. Settings gains a "Reset local copy" that backs up any unpushed notes as conflict copies before re-cloning, so recovery can't destroy work. Page loads also stop stalling on a GitHub token refresh.
- Checkboxes survive copy and paste. Copied todos used to re-paste as plain bullets with a literal `[ ]` in the text.
- Pasting content that carries block ids can no longer silently overwrite existing blocks with the same id, and pasting no longer breaks references to the block you pasted into.
- Arrow keys no longer go dead after collapsing the section your highlight was inside. They now land on the collapsed parent.
- Cutting a mouse selection that spans several blocks now copies and removes them. It used to do nothing. It only takes over when whole blocks are selected, so a partial selection never deletes more than you chose.
- Undoing a freshly created block no longer flings the selection to the top of the note — it lands back on the block you were on.
- The help panel no longer lists shortcuts that were removed with the old editor, and its links point at this project again.

### New

- Paste a copied block into another note and it becomes the same block in both places, not a copy. Edit it in either note and the change shows up in the other, and cut + paste now truly moves a block between notes instead of recreating it. Pasting within the same note still makes an ordinary copy, pasting where the block already sits does nothing (it's already there), and pasting outside Ruminate is completely unchanged.
- Every note now has version history. Open History from the note's <kbd>···</kbd> menu (or "View note history" in <kbd>⌘K</kbd>) to browse each saved version — including edits merged in from another device, which are labeled — preview any of them exactly as it looked, copy it as markdown, or restore it. Restoring is forward-only: the old content is saved as the newest version, so history is never rewritten and nothing is ever lost.
- Zoom into any block with <kbd>F</kbd> (or <kbd>⌘.</kbd>, or a click on its bullet) and its subtree becomes the whole page, with a clickable breadcrumb trail showing how you got there. <kbd>⇧F</kbd> goes up one level, <kbd>⌘⇧.</kbd> exits fully, and zoom lives in the URL so the back button and deep links just work.
- Jump to any heading in the current note with <kbd>⌘P</kbd> (or type `@` in <kbd>⌘K</kbd>). Unfiltered you get the note's outline as an indented tree; typing filters to matches with their parent path shown. Arrowing previews the target behind the dialog, <kbd>Enter</kbd> jumps, <kbd>Esc</kbd> puts everything back exactly as it was. Nested and unsaved headings are included, which the old search missed.
- Press <kbd>⌘A</kbd> repeatedly to grow the selection through the outline: first the block and its visible children, then the parent and its subtree, on up to the whole page. <kbd>⌘⇧A</kbd> steps back down. Every action (indent, move, duplicate, copy, delete) works on whatever the ladder has selected.
- Duplicate a block and its subtree with <kbd>⇧⌥↑</kbd> / <kbd>⇧⌥↓</kbd>, on a single block or a whole selection.
- Press <kbd>?</kbd> anywhere you're not typing for a complete, searchable reference of every shortcut in the app, grouped by context and always in sync with what the keys actually do.
- Get around without the mouse: <kbd>g</kbd> then <kbd>d</kbd>/<kbd>n</kbd>/<kbd>t</kbd>/<kbd>s</kbd> goes to today's note, notes, tags, or settings, <kbd>/</kbd> focuses search on list pages, and <kbd>⌘[</kbd> / <kbd>⌘]</kbd> walk back and forward through your history.
- Navigate the outline spatially with <kbd>w</kbd>/<kbd>a</kbd>/<kbd>s</kbd>/<kbd>d</kbd> on a highlighted block: <kbd>w</kbd>/<kbd>s</kbd> hop between siblings and step out a level when they run out, <kbd>a</kbd> goes to the parent, <kbd>d</kbd> dives into the first child (expanding it if collapsed). The keys move the way the outline looks — left is out, right is in, up and down stay on a level.
- Change a block's type without editing it: with a block (or several) highlighted, press <kbd>#</kbd> for heading, <kbd>-</kbd> for bullet, <kbd>[</kbd> for todo, <kbd>></kbd> for quote, or <kbd>1</kbd> for a numbered item. Press the same key again to turn it back into plain text. Content is never touched, and on an empty block you drop straight into typing with that style.
- Pick your accent color in the new Appearance section of Settings: Neutral (the original gray), Cyan, Green, Violet, or Amber. It recolors selection, links, checkboxes, and highlights across the whole app in both light and dark, and your choice is remembered.
- Fold with the arrow keys: on a highlighted block, <kbd>→</kbd> expands it (or steps into the first child) and <kbd>←</kbd> collapses it (or climbs to the parent) — the same convention as every file tree.
- Move around the notes and tags lists without the mouse: <kbd>↑</kbd>/<kbd>↓</kbd> highlight a row, <kbd>Enter</kbd> opens it, <kbd>↓</kbd> from the search box drops into the results, and <kbd>Esc</kbd> jumps back to search.

### Improved

- Selection got the treatment it deserved: a light, luminous accent wash (tuned live against Notion side-by-side) with a subtle tint on the selected text, instead of the old solid color band — clearer in dark mode, calmer everywhere, and hover, inactive, and selected states now sit on a clean visual ladder that can never overlap. Empty blocks show a quiet "Ruminate…" prompt.
- It's now obvious when the editor is actually listening: the selection dims to a quiet gray whenever keyboard focus is elsewhere (and lights back up in your accent color when it returns), the sidebar tints the note you're currently in, and an empty block's placeholder teaches the type-change keys. Selection is also a solid color now (clearer in dark mode), blocks got softer corners and a roomier highlight without extra spacing, hovering a block shows a subtle gray, and selecting several blocks reads as one continuous surface. App notices (sync merges, storage warnings, remote edits) now share one consistent look.
- Headings now carry a small grey <kbd>#</kbd> in the marker column (click it to zoom in), so section text finally lines up with bullets, todos, and numbered items. The selection highlight has symmetric padding with clear space from the collapse toggle.
- Deleting a block now selects the block that takes its place (the one below), instead of jumping upward.
- The editor got a visual polish pass: corrected line-heights (a bug meant the intended ones never applied), a clear accent-tinted selection with softer corners and breathing room around the text, every marker aligned to one column so text starts at the same place across bullets, todos, and numbered items, custom checkboxes, quieter quote and code styling, and subtle hover and press feedback on the outline controls. Motion respects your reduced-motion setting, and the rules are written down in a design principles doc.
- Paste works without entering a block first. <kbd>⌘V</kbd> on a highlighted block inserts the clipboard below it, splitting lines into blocks and preserving nesting. Rich content from Notion, Google Docs, or the web converts to markdown (headings, lists, checkboxes, links, code), and copying between Ruminate notes round-trips block structure exactly. <kbd>⌘⇧V</kbd> pastes as plain text when you don't want any of that.
- Arrow keys now finish editing at a block's edge: <kbd>↑</kbd> from the first line or <kbd>↓</kbd> from the last drops you back to the rendered view with the neighbouring block highlighted, instead of carrying the raw-markdown editor along. <kbd>Esc</kbd> now also clears the highlight entirely, and arrows pick it back up.
- Move a block with <kbd>⌥↑</kbd> / <kbd>⌥↓</kbd> as well as <kbd>⌘⇧↑</kbd> / <kbd>⌘⇧↓</kbd>, matching editor muscle memory. Sibling jumping moved to <kbd>⌘⌥↑</kbd> / <kbd>⌘⌥↓</kbd>. Moving and duplicating work on multi-block selections too.
- Pasted outlines indented with tabs or four spaces keep their nesting instead of flattening.

### Removed

- Everything git: the repository-selection screen, git sync, "Reset local copy", "Open in GitHub", merge-conflict banners and conflicted-copy notes are gone along with the repository itself.
- Note version history and the calendar's past-day roll-ups. Both were reconstructed from git commits, which no longer exist; past days now show a simple placeholder. A database-backed history layer is planned to bring these back.
- File attachments (the git-era `/uploads` folder). Legacy attachment references in notes render as an inert placeholder.
- The unused e-paper theme has been removed. It was never reachable from the app and was quietly accumulating visual bugs.

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
