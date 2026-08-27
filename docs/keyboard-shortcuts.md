# Keyboard shortcuts

## Global

| Action                            | Shortcut                               |
| --------------------------------- | -------------------------------------- |
| Command menu                      | <kbd>⌘</kbd> <kbd>K</kbd>              |
| Outline palette (jump to heading) | <kbd>⌘</kbd> <kbd>P</kbd>              |
| New note                          | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> |
| Save                              | <kbd>⌘</kbd> <kbd>S</kbd>              |
| Toggle sidebar                    | <kbd>⌘</kbd> <kbd>B</kbd>              |
| Toggle help panel                 | <kbd>⌘</kbd> <kbd>/</kbd>              |

### Outline palette

<kbd>⌘</kbd> <kbd>P</kbd> opens the command palette in **outline mode**: it
lists the open note's headings (indented by nesting), typing fuzzy-filters
them (matching the heading and its ancestor path, shown as `Parent › Sub`),
and <kbd>↵</kbd> jumps to the heading's block. Arrowing through the list
**previews** — the block is highlighted and scrolled into view live behind the
dialog — and <kbd>Esc</kbd> restores the selection and scroll position exactly
as they were.

Typing `@` as the first character of the normal <kbd>⌘</kbd> <kbd>K</kbd>
palette also switches to outline mode (the VS Code prefix grammar);
<kbd>⌫</kbd> on an empty query switches back. When outline mode was opened
with <kbd>⌘</kbd> <kbd>P</kbd> directly, <kbd>⌫</kbd> on an empty query stays
put.

## Block editor

The editor has two modes, like Notion: **select** (a block is highlighted) and
**edit** (a textarea is focused inside a block). The bindings below are defined
declaratively in `src/blocks/keymap.ts` and dispatched through the command layer
(`src/blocks/commands.ts`) — see `docs/block-editor-architecture.md`.

### Select mode (a block is highlighted)

| Action                                  | Shortcut                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Edit the block                          | <kbd>↵</kbd>                                                               |
| New block below (and edit it)           | <kbd>⌘</kbd> <kbd>↵</kbd> / <kbd>⇧</kbd> <kbd>↵</kbd>                      |
| Move highlight up / down                | <kbd>↑</kbd> / <kbd>↓</kbd>                                                |
| Deselect (nothing highlighted)          | <kbd>Esc</kbd>                                                             |
| Jump across siblings (same level)       | <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                      |
| Jump to top / bottom of the level       | <kbd>⌘</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                   |
| Indent / outdent                        | <kbd>⇥</kbd> / <kbd>⇧</kbd> <kbd>⇥</kbd>                                   |
| Move block (with its subtree)           | <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> (or <kbd>⌘⇧</kbd> <kbd>↑/↓</kbd>) |
| Duplicate block above / below           | <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                      |
| Extend selection to more blocks         | <kbd>⇧</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                   |
| Grow selection by structure (ladder)    | <kbd>⌘</kbd> <kbd>A</kbd>                                                  |
| Shrink it back one rung                 | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>A</kbd>                                     |
| Delete block(s)                         | <kbd>⌫</kbd> / <kbd>⌦</kbd>                                                |
| Copy / cut selection                    | <kbd>⌘</kbd> <kbd>C</kbd> / <kbd>⌘</kbd> <kbd>X</kbd>                      |
| Paste after the selection               | <kbd>⌘</kbd> <kbd>V</kbd>                                                  |
| Paste as one plain block                | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd>                                     |
| Collapse / expand (if nested)           | <kbd>Space</kbd>                                                           |
| Toggle checkbox (todo blocks)           | <kbd>x</kbd>                                                               |
| Zoom into the block (see Zoom below)    | <kbd>F</kbd> (or <kbd>⌘</kbd> <kbd>.</kbd>)                                |
| Zoom out one level                      | <kbd>⇧</kbd> <kbd>F</kbd>                                                  |
| Exit zoom entirely                      | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd>                                     |
| Focus the note title (from first block) | <kbd>↑</kbd>                                                               |

With more than one block selected, <kbd>⇥</kbd> / <kbd>⇧⇥</kbd>, delete,
copy / cut / paste, move (<kbd>⌥↑/↓</kbd> or <kbd>⌘⇧↑/↓</kbd> — only when the
selected blocks share a parent), and duplicate (<kbd>⇧⌥↑/↓</kbd>) act on the
whole selection; <kbd>Esc</kbd> collapses back to one.

#### Selection ladder

Repeated <kbd>⌘</kbd> <kbd>A</kbd> grows the selection one structural rung at a
time:

1. **Editing a block**: the first press is the textarea's native select-all;
   pressing again (with the text already fully selected) exits edit mode and
   continues on the block.
2. **A highlighted block**: the block plus all its visible descendants (a leaf
   or fully-collapsed block skips straight to the next rung, so the press
   always visibly does something).
3. **Next press**: the parent's visible subtree — the parent block and
   everything visible under it.
4. Repeat up each ancestor, until
5. **the whole page** (every visible block).

<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>A</kbd> steps back down one rung. Escape — or
any other selection change (arrows, a click, a structural edit) — resets the
ladder. Starting from a <kbd>⇧</kbd> <kbd>↑/↓</kbd> range, <kbd>⌘</kbd>
<kbd>A</kbd> grows to the deepest subtree that contains the whole range. All
multi-block actions (indent, delete, copy / cut, move, duplicate, paste-after)
work on ladder selections. Like <kbd>⌘</kbd> <kbd>C</kbd> / <kbd>⌘</kbd>
<kbd>X</kbd>, these two bindings are handled imperatively in the editor
component rather than through the keymap table.

Pasting in select mode parses the clipboard as markdown and inserts the blocks
after the last selected block. <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd> instead
inserts a single paragraph block with newlines collapsed to spaces (blocks are
one line in the serialized format). With nothing selected (after
<kbd>Esc</kbd>), <kbd>↓</kbd> / <kbd>↑</kbd> re-select the first / last block.

### Edit mode (typing in a block)

| Action                                  | Shortcut                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Stop editing (back to highlight)        | <kbd>Esc</kbd>                                                             |
| New block below (bullet by default)     | <kbd>↵</kbd>                                                               |
| Split into a new block of the same type | <kbd>⇧</kbd> <kbd>↵</kbd>                                                  |
| New block below, ignoring the caret     | <kbd>⌘</kbd> <kbd>↵</kbd>                                                  |
| Indent / outdent                        | <kbd>⇥</kbd> / <kbd>⇧</kbd> <kbd>⇥</kbd>                                   |
| Move block (with its subtree)           | <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> (or <kbd>⌘⇧</kbd> <kbd>↑/↓</kbd>) |
| Duplicate block (keep editing the copy) | <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                      |
| Jump across siblings (same level)       | <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                      |
| Jump to top / bottom of the level       | <kbd>⌘</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                   |
| Exit edit, select block above / below   | <kbd>↑</kbd> / <kbd>↓</kbd> at the first / last line                       |
| Paste as plain text (newlines → spaces) | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd>                                     |
| Select all text, then grow by structure | <kbd>⌘</kbd> <kbd>A</kbd> (repeat — see the selection ladder)              |
| Zoom into the block / exit zoom         | <kbd>⌘</kbd> <kbd>.</kbd> / <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd>         |
| Strip the block's marker → merge up     | <kbd>⌫</kbd> at line start                                                 |

Enter from a heading nests the new block underneath it. Enter on an empty list
item exits the list.

An arrow leaving the edited block **commits the edit and switches to select
mode**: <kbd>↑</kbd> on the first visual line highlights the block above
(<kbd>↑</kbd> on the very first block focuses the note title); <kbd>↓</kbd> on
the last visual line highlights the block below (on the very last block it
highlights the block itself). <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd> collapses
newlines to single spaces because a block is one line in the serialized format.

### Zoom (focus mode)

Zoom makes one block's subtree the whole editor view — the block renders as an
editable title at the top, its children below it, with a breadcrumb tracing the
full path (`Note title › ancestor › … › zoomed block`; every crumb is
clickable, the note-title crumb exits fully). The zoom lives in the URL
(`?block=…`), so the browser back button undoes it.

| Action                        | Trigger                                             |
| ----------------------------- | --------------------------------------------------- |
| Zoom into the selected block  | <kbd>F</kbd> (select mode)                          |
| Zoom out one level            | <kbd>⇧</kbd> <kbd>F</kbd> (select mode)             |
| Zoom into the current block   | <kbd>⌘</kbd> <kbd>.</kbd> (both modes)              |
| Exit zoom entirely            | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> (both modes) |
| Zoom into a list item         | click its bullet / number                           |
| Zoom into any other block     | hover the gutter, click the magnifier               |
| Navigate to a shallower level | click its breadcrumb crumb                          |

Rules while zoomed:

- Zooming **in** selects the first child (not the title); zooming **out** lands
  on the block you zoomed out from.
- <kbd>↵</kbd> / <kbd>⌘</kbd> <kbd>↵</kbd> on the title create its **first
  child** (title + body), never a sibling outside the view.
- The title can't be deleted, moved, duplicated, indented, outdented, or
  collapsed from inside its own view; outdenting a top-level block of the view
  (which would eject it) is a no-op, and <kbd>↑</kbd> at the title stays put
  rather than exiting to the note title.
- The <kbd>⌘</kbd> <kbd>A</kbd> ladder's "page" rung is the zoomed subtree.
- If the zoomed block disappears (an undo, a stale link), the editor exits the
  zoom gracefully and cleans the URL.

### Note title

| Action                    | Shortcut                                              |
| ------------------------- | ----------------------------------------------------- |
| Select the title          | <kbd>↑</kbd> from the first block                     |
| Edit it                   | <kbd>↵</kbd> (or click)                               |
| New root block below      | <kbd>⌘</kbd> <kbd>↵</kbd> / <kbd>⇧</kbd> <kbd>↵</kbd> |
| Drop back into the editor | <kbd>↓</kbd>                                          |
| Commit rename             | <kbd>↵</kbd>                                          |
| Cancel rename             | <kbd>Esc</kbd>                                        |

### Document

| Action | Shortcut                                                           |
| ------ | ------------------------------------------------------------------ |
| Undo   | <kbd>⌘</kbd> <kbd>Z</kbd>                                          |
| Redo   | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Z</kbd> / <kbd>⌘</kbd> <kbd>Y</kbd> |

Undo/redo operate on the whole document (a single keystroke can walk back a
change that spanned several blocks) and survive a save.

### Moving through tree structures — the conventions

- **Traverse** one block at a time: plain <kbd>↑</kbd> / <kbd>↓</kbd>.
- **Skip across a level** (e.g. header→header, past their children):
  <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>.
- **Jump to the top / bottom of the current level** (walking up levels rather
  than to the page top): <kbd>⌘</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>.
- **Reorder** a block and its subtree: <kbd>⌥</kbd> <kbd>↑/↓</kbd> or
  <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↑/↓</kbd> (the Notion convention).
- **Duplicate** a block and its subtree: <kbd>⇧</kbd> <kbd>⌥</kbd>
  <kbd>↑/↓</kbd> (the VS Code convention — down lands on the lower copy, up on
  the upper).
- **Change depth**: <kbd>⇥</kbd> / <kbd>⇧</kbd> <kbd>⇥</kbd>.
- **Select a run of blocks**: <kbd>⇧</kbd> <kbd>↑/↓</kbd>, then act on them.
