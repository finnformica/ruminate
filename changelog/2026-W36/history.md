### Added

- Ruminate supports accounts. Each person who signs in gets their own private database, fully separate from everyone else's, so inviting someone no longer means sharing yours. Existing notes move over automatically on first sync, and nothing changes in how you write, save or sync.
- Search can filter by block type, so `type:todo` pulls up every unchecked box in your notes. It works anywhere you search and combines with everything else: `type:todo milk` narrows by text, and values like `done`, `heading`, `list`, `quote` and `code` filter for other kinds of block. See docs/query-language.md for the full list.

### Changed

- Renaming a note is now instant, and cannot break anything. A note's name used to be its identity — its filename, its address, and the thing every link pointed at — so renaming rewrote the note under a new name and abandoned the old one. Every note now has its own permanent identity and the name is one of its properties, so links, bookmarks and browser history keep working.
- Note names are free text. A name can hold a colon, a question mark, brackets or a slash, and two notes may share a name without one overwriting the other. Names used to be restricted to characters that were legal in a filename, and had to be unique. Daily and weekly notes are unchanged, since for those the date is the name and never changes.
- Search results are the matching blocks, not the notes they live in. A heading nested three levels down, a single unchecked to-do, a quoted line: each is its own row, drawn the way it looks in the editor and labelled with its note and the path above it. Any result with something inside it can be expanded in place, so you can read down into a section without leaving the results.
- Search says how many results there are. The count gives the number of matching blocks and how many notes they are spread across, in both the <kbd>⌘</kbd> <kbd>K</kbd> palette and the results view. Blocks you reveal by expanding a result are context rather than matches, so the count stays a straight answer to your query.
- <kbd>↵</kbd> on the query in <kbd>⌘</kbd> <kbd>K</kbd> opens the full results view for it. That view is an ordinary address (`/?query=type:todo`), so any filter can be bookmarked or shared and the back button works as you would expect. A query that names only notes still lists notes.
- Folds are only remembered once you make one. A note you have merely read is no longer written to this device's storage, and opens as the default says each time. The first block you fold or unfold in a note makes its folds yours, and those are kept as before. A device keeps folds for the 500 most recently folded notes.
- Folding no longer changes under you as a note grows. A note still opens tidy the first time you see it on a device, with headings expanded and two levels visible, but that is a starting point rather than a rule that keeps reapplying: blocks added afterwards stay open, and nothing you unfolded quietly closes again. Folds you already have are kept as they are.
- Old checkbox and list spellings behave as real checkboxes and lists. Blocks written as `[] buy milk`, `[X] done`, `* item` or `2) item` used to stay plain text, invisible to `type:todo` and unstyled; they are now recognised and tidied to their canonical form, both as you type and, once, for everything already in your notes. Genuinely ambiguous lines are left exactly as written.
- Deleting a block or a note no longer erases it. Deleted content is marked as deleted and kept in your database: it disappears from every note, search and count exactly as before, and syncs away on your other devices, but the words are still there. Nothing in the app surfaces them yet. This is the groundwork for undoing a delete later.
- **Settings → Storage** says "cloud" rather than naming the internal database, and the manual action reads **Push full copy to the cloud now**.
- The Settings footer credits the app correctly. It reads "Made by Finn Formica", with "Built on Lumen by Cole Bemis & contributors" beneath it, linking to Ruminate's author, the upstream project and its author. The upstream author's personal signature mark, which this fork had been showing as Ruminate's own sign-off, is gone.

### Removed

- Wikilinks are gone. The `[[id]]` link syntax, `![[id]]` note embeds, backlinks (the count on previews, the section on notes, and the delete-confirmation prompt) and the `link:` and `backlink:` search qualifiers have all been removed. Existing notes are untouched: any `[[…]]` in your text simply reads as plain text. Block references and everything else are unaffected.

### Fixed

- A device holding an out-of-date local copy of your notes rebuilds it from scratch rather than trying to update it in place. The old behaviour could leave a device disagreeing with the cloud about which notes existed, and briefly emptied the note list.
- Syncing reads far less data. Saving a note, and checking for changes from your other devices, used to re-read your entire set of notes every time; both now read only what actually changed, which is thousands of times less work, with no change in how sync behaves.
- Renaming a note no longer leaves its old link dead. A note's address does not change when you rename it, so there is no old link to break. The old link used to open an empty editor that could quietly mint a duplicate note under the dead name.
- Refreshing a note no longer shows a blank editor. The page used to open in edit mode with nothing in it while the local database was still starting up, and only showed your writing after navigating away and back.
- Pasting onto a selected block puts the content inside it rather than next to it. A pasted section arrives folded, so you see the block you pasted rather than its whole tree unpacked into the page, and the block you pasted onto is opened so the paste is visible.
- A sign-in that is not enabled now says so plainly. An invite-only refusal or a blocked account used to look like it worked while silently failing to sync; a notice now explains that notes you write stay on this device and will sync automatically if you are admitted. Writing locally remains fully available.
