### Added

- Paste a copied block into another note and it becomes the same block in both places, not a copy. Edit it in either note and the change shows in the other, and cut and paste now truly moves a block between notes rather than recreating it. Pasting within the same note still makes an ordinary copy, and pasting where the block already sits does nothing.
- Zoom into any block with <kbd>f</kbd>, or a click on its bullet, and what sits under it becomes the whole page. A clickable breadcrumb trail shows how you got there. <kbd>⇧</kbd> <kbd>f</kbd> goes up one level and <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> leaves entirely. The zoom lives in the address, so the back button and deep links work.
- Jump to any heading in the open note with <kbd>⌘</kbd> <kbd>P</kbd>. With nothing typed you get every heading in the note; typing filters them, and <kbd>↵</kbd> jumps. Nested headings, and ones you have not saved yet, are included.
- Press <kbd>⌘</kbd> <kbd>A</kbd> repeatedly to grow the selection through the outline. It takes the block and its visible children first, then the parent and everything under it, on up to the whole page, and <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>A</kbd> steps back down. Every action — indent, move, duplicate, copy, delete — works on whatever the ladder has selected.
- Press <kbd>?</kbd> anywhere you are not typing for a reference of every shortcut in the app. It is searchable, grouped by context, and always in step with what the keys actually do.
- Get around without the mouse. <kbd>g</kbd> then <kbd>d</kbd>, <kbd>n</kbd> or <kbd>s</kbd> goes to today's note, your notes or settings, <kbd>/</kbd> focuses search on list pages, and <kbd>⌘</kbd> <kbd>[</kbd> and <kbd>⌘</kbd> <kbd>]</kbd> walk back and forward through your history.
- Navigate the outline spatially with <kbd>w</kbd>, <kbd>a</kbd>, <kbd>s</kbd> and <kbd>d</kbd> on a highlighted block. <kbd>w</kbd> and <kbd>s</kbd> hop between siblings and step out a level when they run out, <kbd>a</kbd> goes to the parent, and <kbd>d</kbd> dives into the first child, expanding it if it is folded. The keys move the way the outline looks: left is out, right is in.
- Change a block's type without editing it. With a block or several highlighted, press <kbd>#</kbd> for a heading, <kbd>-</kbd> for a bullet, <kbd>[</kbd> for a to-do, <kbd>></kbd> for a quote or <kbd>1</kbd> for a numbered item, and the same key again to turn it back into plain text. The text is never touched, and on an empty block you drop straight into typing with that style.
- Fold with the arrow keys. On a highlighted block <kbd>→</kbd> expands it, or steps into the first child, and <kbd>←</kbd> collapses it, or climbs to the parent — the same convention as every file tree.
- Move around the notes list without the mouse. <kbd>↑</kbd> and <kbd>↓</kbd> highlight a row, <kbd>↵</kbd> opens it, <kbd>↓</kbd> from the search box drops into the results, and <kbd>Esc</kbd> jumps back to search.
- Duplicate a block and everything under it with <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> or <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>↓</kbd>, on a single block or a whole selection.
- Pick your accent colour in the new Appearance section of Settings. The choices are Neutral, Cyan, Green, Violet and Amber, and the one you pick recolours selection, links, checkboxes and highlights across the whole app in both light and dark. Your choice is remembered.

### Changed

- Your notes live in a database rather than a GitHub repository. Sign in and they are there: no repository to choose, no cloning, no commit and push. Everything is stored in a local database on your device, so the app works fully offline, and syncs to the cloud automatically — every save is pushed in the background within seconds, and opening the app or returning to its tab pulls what is new.
- Notes save themselves. Every change is written moments after you stop typing, and immediately when you switch away, refresh or close the tab, so there is no Save button, no unsaved-changes state and nothing to lose. <kbd>⌘</kbd> <kbd>S</kbd> still works as "save right now", and a quiet "Saving…" appears while a save is in flight.
- Sync works block by block rather than note by note. Editing different parts of the same note on two devices no longer makes the later save overwrite the whole note. Only edits to the very same block still resolve to the most recent save.
- Notes open with a tidy amount of detail rather than everything unfolded. Headings are always expanded, the first two levels beneath them are visible, and anything deeper starts folded. Your own folding is remembered on each device on top of that default. Fold state no longer syncs between devices, so folding on your phone never touches how a note looks on your laptop.
- **Settings → Storage** shows the live state of your data. It gives the local database's status, pending pushes to the cloud, remote row counts and a **Push full copy now** button for peace of mind. The sidebar's sync indicator reflects the same thing, reading "Syncing…" until your last save has reached the cloud.
- Headings carry a small grey `#` in the marker column. Click it to zoom in, and heading text finally lines up with bullets, to-dos and numbered items. The selection highlight has even padding, with clear space from the fold arrow.
- Paste works without entering a block first. <kbd>⌘</kbd> <kbd>V</kbd> on a highlighted block inserts the clipboard below it, splitting lines into blocks and keeping their nesting. Rich content from Notion, Google Docs or the web converts to markdown, and copying between Ruminate notes round-trips block structure exactly. <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd> pastes as plain text.
- Arrow keys finish editing at a block's edge. <kbd>↑</kbd> from the first line, or <kbd>↓</kbd> from the last, drops you back to the rendered view with the neighbouring block highlighted, rather than carrying the raw-markdown editor along. <kbd>Esc</kbd> now also clears the highlight entirely, and the arrows pick it back up.
- Move a block with <kbd>⌥</kbd> <kbd>↑</kbd> and <kbd>⌥</kbd> <kbd>↓</kbd> as well as <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↑</kbd> and <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↓</kbd>, matching editor muscle memory. Sibling jumping moved to <kbd>⌘</kbd> <kbd>⌥</kbd> with the arrows. Moving and duplicating work on multi-block selections too.
- Deleting a block selects the block that takes its place, the one below, rather than jumping upward.
- Pasted outlines indented with tabs or four spaces keep their nesting instead of flattening.

### Removed

- Everything git. The repository-selection screen, git sync, **Reset local copy**, **Open in GitHub**, merge-conflict banners and conflicted-copy notes are gone, along with the repository itself. The calendar's past days, which were reconstructed from git commits, now show a simple placeholder.
- File attachments, the git-era `/uploads` folder. Legacy attachment references in notes render as an inert placeholder.

### Fixed

- A stale device can no longer quietly revert your newer edits. When two devices' changes collide the newest edit wins, and a banner tells you a merge happened. The silent-overwrite path that reverted a restructured note is closed.
- Sync between devices no longer gets permanently stuck. Conflicting edits merge automatically and the newest version wins for the conflicting lines, with no extra conflict notes cluttering your list. Signing out and back in is no longer the fix, and folding blocks no longer causes conflicts between devices.
- When your GitHub session expires the app says so and returns you to the sign-in screen. Your notes reload as soon as you sign back in. It used to show a misleading "cannot reach the notes database" message, which is now reserved for actually being offline.
- When sync does fail, the sidebar says why — network, sign-in or conflict — and clicking retries. Settings gains a **Reset local copy** that backs up any unpushed notes as conflict copies before re-cloning, so recovery cannot destroy work. Page loads also stop stalling on a GitHub token refresh.
- Opening Ruminate in a second tab no longer shows a silently empty app. The second tab explains that your notes are open in another tab, works on a temporary copy in the meantime, and offers a one-click reload once the other tab is closed.
- Switching away from the tab right after typing no longer risks leaving that save behind. Pending changes are pushed to the cloud immediately when the tab is hidden or closed, and returning to the app pulls the latest changes right away.
- Changes pulled from another device appear in the open note immediately, with no page refresh needed. If you are mid-edit your typing is never interrupted or overwritten, and your next save settles the note.
- Checkboxes survive copy and paste. Copied to-dos used to paste back as plain bullets with a literal `[ ]` in the text.
- Pasting content that carries block ids can no longer silently overwrite existing blocks with the same id. Pasting also no longer breaks references to the block you pasted into.
- Arrow keys no longer go dead after folding the section your highlight was inside. They now land on the folded parent.
- Cutting a mouse selection that spans several blocks copies and removes them; it used to do nothing. It only takes over when whole blocks are selected, so a partial selection never deletes more than you chose.
- Undoing a freshly created block no longer flings the selection to the top of the note. It lands back on the block you were on.
