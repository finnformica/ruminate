# Keyboard shortcuts

Every binding below is declared in the app's **shortcut registry**
(`src/shortcuts/registry.ts`) — the same table the in-app reference renders
from. Press <kbd>?</kbd> anywhere (outside a text field) to open that
reference, complete with a filter box.

## Global

| Action                          | Shortcut                               |
| ------------------------------- | -------------------------------------- |
| Command menu                    | <kbd>⌘</kbd> <kbd>K</kbd>              |
| Search the open note's headings | <kbd>⌘</kbd> <kbd>P</kbd>              |
| New note                        | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> |
| Save                            | <kbd>⌘</kbd> <kbd>S</kbd>              |
| Toggle sidebar                  | <kbd>⌘</kbd> <kbd>B</kbd>              |
| Toggle help panel               | <kbd>⌘</kbd> <kbd>/</kbd>              |
| Update Ruminate                 | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> |
| Shortcut reference              | <kbd>?</kbd>                           |

<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> takes a waiting update — the same thing as the
sidebar's **Update Ruminate** item, which is only on screen when there is one.
With nothing waiting the key does nothing. Pending edits are written to the
store before the page reloads, so a mistyped chord cannot carry them off with
the old copy.

## Navigation

`g` pressed outside any text field arms a short (~1.5s) chord window; the next
key navigates. The chords work from the block editor's select mode too.

| Action                                | Shortcut                                              |
| ------------------------------------- | ----------------------------------------------------- |
| Go to today's daily note              | <kbd>g</kbd> then <kbd>d</kbd>                        |
| Go to the Views list                  | <kbd>g</kbd> then <kbd>v</kbd>                        |
| Go to settings                        | <kbd>g</kbd> then <kbd>s</kbd>                        |
| Go to the changelog                   | <kbd>g</kbd> then <kbd>c</kbd>                        |
| Go to the Admin settings (admin only) | <kbd>g</kbd> then <kbd>a</kbd>                        |
| Focus the search (Views page)         | <kbd>/</kbd>                                          |
| `i`                                   | Focus the editor, restoring the last selected block   |
| Back / forward (browser history)      | <kbd>⌘</kbd> <kbd>[</kbd> / <kbd>⌘</kbd> <kbd>]</kbd> |

### Headings

<kbd>⌘</kbd> <kbd>P</kbd> opens the same <kbd>⌘</kbd> <kbd>K</kbd> palette
with two filters already set — `type:heading` and `in:` the open note (or
the block you have focused on) — so the results are that note's headings in
document order, and typing narrows them. <kbd>↵</kbd> on a highlighted
heading opens the note focused on it. There is no separate outline mode:
take the pills off and it is the ordinary search.

## The Views page and search results

The Views page (`/`) and the full results view (`/?query=…`) are the block
editor over a set of roots — the views, or the matched blocks — so the keys
are the editor's own (see "Block editor" above): the arrows and <kbd>w</kbd> /
<kbd>s</kbd> / <kbd>a</kbd> / <kbd>d</kbd> move the highlight, <kbd>space</kbd>
/ <kbd>→</kbd> / <kbd>←</kbd> fold and unfold, <kbd>f</kbd> focuses — which,
here, opens the note at that block. Opening a row loads only that row's
blocks; a child opens the next level the same way.

The Views page is browsed: <kbd>↵</kbd> (or a click) opens the highlighted
row, and nothing writes. A right-click on a row offers what a browsed row
can do — **Open**, **Copy**, **Copy link to block**, **Add to Views** — and
none of the editing the note's own menu carries. A filtered view **edits in place**: <kbd>↵</kbd>
edits the row as it would in its note, the change lands in the note, and the
only thing refused is adding a block beside a result or removing one from the
list — open the note for that.

| Action                                  | Shortcut     |
| --------------------------------------- | ------------ |
| In the search box: highlight first row  | <kbd>↓</kbd> |
| From the first row: back to the search  | <kbd>↑</kbd> |
| Views page: open the highlighted row    | <kbd>↵</kbd> |
| Filtered view: edit the highlighted row | <kbd>↵</kbd> |
| Open the note at this block             | <kbd>f</kbd> |

The tags page keeps its own Linear-style list keys (<kbd>↑</kbd> / <kbd>↓</kbd>,
<kbd>↵</kbd>, <kbd>Esc</kbd> back to search).

## ⌘K results

The palette's results — the matching **blocks** at any depth and the notes
whose title matched, ranked together by score; or, with nothing typed, the
**Recent** places — the five most used lately, notes and blocks focused on
alike, ranked by frecency (how often, weighted by how recently: each place's
score halves every week, and a visit adds one). A place is visited when it
is opened — from the Views page, the palette or a link, or by focusing on a
block in the editor — edited, or a block in it folded or unfolded, on this
device (at most fifty places, a timestamp and a score each, under one
browser-storage key that overwrites itself; touches within half an hour of
the last are the same visit), and a note is visited, too, when it is edited
on another device (the graph's timestamp); selecting, focusing or arrowing
through a note never counts (`src/utils/recents.ts`). The Views page lists
the same Recent above its Views. With the
**Views** — the notes and the block views, in the sidebar's order
(docs/metadata.md), each block opening its note focused on it — beneath; a
place used lately is under both. Both give way
to results the moment you type — are the same block editor, browsed, under
the same count line as the Views page. The
palette's one item of its own — a date, when the query reads as one —
comes first and takes cmdk's <kbd>↑</kbd> / <kbd>↓</kbd>; nothing is
highlighted until you arrow, so <kbd>↵</kbd> straight after typing is the
query's and opens the full results view. <kbd>↓</kbd> from the query (past
the date item, if there is one) hands the keyboard to the rows, whose keys
are then the editor's (fold with <kbd>space</kbd> / <kbd>→</kbd> /
<kbd>←</kbd>, walk with <kbd>w</kbd> <kbd>s</kbd> <kbd>a</kbd> <kbd>d</kbd>,
open with <kbd>↵</kbd> or <kbd>f</kbd>). With nothing typed, Recent and
Views are walked as one list: <kbd>↓</kbd> past the last recent row lands on
the first view row, <kbd>↑</kbd> walks back the same way. <kbd>↑</kbd>
from the very first row, or <kbd>Esc</kbd>, returns to the query. Typing
never moves the keyboard: the rows change under the query, and the query
keeps it.

| Action                                     | Shortcut                                 |
| ------------------------------------------ | ---------------------------------------- |
| Move between the palette's items           | <kbd>↑</kbd> / <kbd>↓</kbd>              |
| Past the last item: into the result rows   | <kbd>↓</kbd>                             |
| From the first row: back to the query      | <kbd>↑</kbd> / <kbd>Esc</kbd>            |
| Open the highlighted result (note + focus) | <kbd>↵</kbd>                             |
| See all results for the query              | <kbd>↵</kbd> with no item highlighted    |
| Pick the highlighted item                  | <kbd>↵</kbd>                             |
| Create a note titled with the query        | <kbd>⌘</kbd> <kbd>↵</kbd>, or the footer |

Opening a row loads only that row's blocks; a child opens the next level the
same way.
and opens the full results view, whose `?query=` URL is bookmarkable and
works with back/forward.

## Block editor

The editor has two modes, like Notion: **select** (a block is highlighted) and
**edit** (a textarea is focused inside a block). The bindings below are defined
declaratively in `src/blocks/keymap.ts` and dispatched through the command layer
(`src/blocks/commands.ts`) — see `docs/block-editor-architecture.md`.

### Select mode (a block is highlighted)

| Action                                   | Shortcut                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Edit the block                           | <kbd>↵</kbd>                                                               |
| New block below (and edit it)            | <kbd>⌘</kbd> <kbd>↵</kbd> / <kbd>⇧</kbd> <kbd>↵</kbd>                      |
| Move highlight up / down                 | <kbd>↑</kbd> / <kbd>↓</kbd>                                                |
| Deselect (nothing highlighted)           | <kbd>Esc</kbd>                                                             |
| Jump across siblings (same level)        | <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                      |
| Jump to top / bottom of the level        | <kbd>⌘</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                   |
| Tree navigation: previous / next sibling | <kbd>w</kbd> / <kbd>s</kbd>                                                |
| Tree navigation: parent / first child    | <kbd>a</kbd> / <kbd>d</kbd>                                                |
| Fold: expand, then step into first child | <kbd>→</kbd>                                                               |
| Fold: collapse, else step out to parent  | <kbd>←</kbd>                                                               |
| Indent / outdent                         | <kbd>⇥</kbd> / <kbd>⇧</kbd> <kbd>⇥</kbd>                                   |
| Move block (with its subtree)            | <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> (or <kbd>⌘⇧</kbd> <kbd>↑/↓</kbd>) |
| Duplicate block above / below            | <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                      |
| Extend selection to more blocks          | <kbd>⇧</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                   |
| Grow selection by structure (ladder)     | <kbd>⌘</kbd> <kbd>A</kbd>                                                  |
| Shrink it back one rung                  | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>A</kbd>                                     |
| Remove block(s) from here                | <kbd>⌫</kbd> / <kbd>⌦</kbd>                                                |
| Copy / cut selection                     | <kbd>⌘</kbd> <kbd>C</kbd> / <kbd>⌘</kbd> <kbd>X</kbd>                      |
| Paste after the selection                | <kbd>⌘</kbd> <kbd>V</kbd>                                                  |
| Paste as one plain block                 | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd>                                     |
| Collapse / expand (if nested)            | <kbd>Space</kbd>                                                           |
| Toggle checkbox (todo blocks)            | <kbd>x</kbd>                                                               |
| Turn into: heading / bullet / todo       | <kbd>#</kbd> / <kbd>-</kbd> / <kbd>[</kbd>                                 |
| Turn into: quote / numbered item         | <kbd>></kbd> / <kbd>1</kbd>                                                |
| Turn into: code block                    | <kbd>`</kbd>                                                               |
| Focus on the block (see Focus below)     | <kbd>F</kbd> (or <kbd>⌘</kbd> <kbd>.</kbd>)                                |
| Step back one level                      | <kbd>⇧</kbd> <kbd>F</kbd>                                                  |
| Leave focus entirely                     | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd>                                     |
| Focus the note title (from first block)  | <kbd>↑</kbd>                                                               |

**Tree navigation** maps the tree spatially onto <kbd>w</kbd> <kbd>a</kbd>
<kbd>s</kbd> <kbd>d</kbd>: <kbd>a</kbd> / <kbd>d</kbd> change depth (parent /
first child), <kbd>w</kbd> / <kbd>s</kbd> walk siblings at the same level
(skipping descendants) and **break out of the level at its ends**:
<kbd>w</kbd> at the first sibling steps out to the parent, and <kbd>s</kbd> at
the last sibling continues at the next block one level out (climbing until an
ancestor has a next sibling). Only the true start / end of the tree no-ops.
<kbd>d</kbd> on a collapsed block expands it and selects its first child in
one press; while focused the traversal never leaves the focused subtree, and
<kbd>a</kbd> on the title steps back one level ("up the tree" keeps holding
across the focus boundary — <kbd>w</kbd> on the title stays put). (`g` chords
still work: an armed chord's second key wins over these bindings.)

<kbd>←</kbd> / <kbd>→</kbd> **fold** the way file trees do: <kbd>→</kbd> on a
collapsed block expands it (staying put), and pressed again steps into the
first child; <kbd>←</kbd> on an expanded block collapses it (staying put), and
on a collapsed block or a leaf steps out to the parent. A root-level collapsed
block or leaf no-ops. While focused, <kbd>←</kbd> on a direct child selects the
title, and on the title itself it's a no-op — stepping back stays <kbd>a</kbd>'s
job, and the fold walk never leaves the focused subtree. In edit mode
<kbd>←</kbd> / <kbd>→</kbd> stay ordinary caret keys.

**Turn into**: select mode never types text, so the markdown marker keys are
structural — each _toggles_ the highlighted block's type: <kbd>#</kbd>
heading, <kbd>-</kbd> bullet, <kbd>[</kbd> todo, <kbd>></kbd> quote,
<kbd>1</kbd> numbered item, <kbd>`</kbd> code block. A block already of that type strips back to a
paragraph; anything else swaps just the leading marker — content and children
are never touched, and each press is one undo step. On an _empty_ block the
marker applies and editing opens, so you start typing that type immediately.
(<kbd>x</kbd> still toggles a todo's checkbox; <kbd>[</kbd> changes what the
block _is_.)

With more than one block selected, <kbd>⇥</kbd> / <kbd>⇧⇥</kbd>, delete,
copy / cut / paste, move (<kbd>⌥↑/↓</kbd> or <kbd>⌘⇧↑/↓</kbd> — only when the
selected blocks share a parent), duplicate (<kbd>⇧⌥↑/↓</kbd>), the
turn-into marker keys and <kbd>x</kbd> act on the whole selection;
<kbd>Esc</kbd> collapses back to one. These are not separate bulk actions:
each key runs the same command it runs on one block, over every selected
block at once (`src/blocks/commands.ts`), so a single block is simply a
selection of one. The right-click menu is the same: opened on a row of the
selection, its Copy, Duplicate, the moves, Unlink and Delete take the whole
selection and say how many blocks that is (**Delete 3 blocks**); opened on
a row outside it, that row alone.

A mouse selects a run of blocks too: sweeping across rows selects every row the
sweep touched (the anchor stays at the end the sweep began, so <kbd>⇧</kbd>
<kbd>↑/↓</kbd> grows it from the other), and <kbd>⇧</kbd>-click extends the
selection to the clicked row. Indent moves the selection as one: when a
selected block has nothing above it to nest under, nothing moves — rather than
the rest nesting under it.

While more than one block is selected, a bar rises at the bottom of the window
with the count, a way out, and an **Actions** menu holding every action above
(turn into, duplicate, indent, outdent, move, copy, cut, unlink — and, in a
note, the block menu's Delete), each acting on the whole selection through the
same commands the keys run. An item greys where the action would do nothing,
and the bar sinks away when the selection collapses.

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
<kbd>X</kbd> and <kbd>⇧</kbd> <kbd>↑/↓</kbd>, these two bindings are handled
imperatively in the editor component rather than through the keymap table:
they change what is selected, where the keymap's commands change what the
selection is.

Copying writes both plain markdown and a rich-text (HTML) flavor that carries
the exact block tree, so blocks copied from Ruminate paste back into Ruminate
(same note or another) with their structure, types, and nesting intact.
Pasting in select mode prefers that embedded payload, then converts rich text
from other apps (Google Docs, Notion, web pages — headings, lists, task lists,
links, bold/italic/code) to markdown blocks, and otherwise parses the plain
text as markdown; tab- and 4-space-indented outlines nest correctly. The
blocks land after the last selected block. <kbd>⌘</kbd> <kbd>⇧</kbd>
<kbd>V</kbd> instead ignores the rich flavor and inserts a single paragraph
block with newlines collapsed to spaces (blocks are one line in the serialized
format). With nothing selected (after <kbd>Esc</kbd>), <kbd>↓</kbd> /
<kbd>↑</kbd> re-select the first / last block.

### Edit mode (typing in a block)

| Action                                            | Shortcut                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Stop editing (back to highlight)                  | <kbd>Esc</kbd>                                                                                                                         |
| New block below (bullet by default)               | <kbd>↵</kbd>                                                                                                                           |
| Split into a new block of the same type           | <kbd>⇧</kbd> <kbd>↵</kbd>                                                                                                              |
| New block below, ignoring the caret               | <kbd>⌘</kbd> <kbd>↵</kbd>                                                                                                              |
| Indent / outdent                                  | <kbd>⇥</kbd> / <kbd>⇧</kbd> <kbd>⇥</kbd>                                                                                               |
| Move block (with its subtree)                     | <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> (or <kbd>⌘⇧</kbd> <kbd>↑/↓</kbd>)                                                             |
| Duplicate block (keep editing the copy)           | <kbd>⇧</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                                                                  |
| Bold / italic / code around the selection         | <kbd>⌘</kbd> <kbd>B</kbd> / <kbd>⌘</kbd> <kbd>I</kbd> / <kbd>⌘</kbd> <kbd>E</kbd> (again to take it off)                               |
| Strikethrough / maths / link around the selection | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>X</kbd> / <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>M</kbd> / <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd>               |
| Wrap the selection in the character typed         | <kbd>`</kbd> <kbd>"</kbd> <kbd>'</kbd> <kbd>(</kbd> <kbd>[</kbd> <kbd>{</kbd> <kbd>&lt;</kbd> <kbd>\*</kbd> <kbd>\_</kbd> <kbd>~</kbd> |
| Jump across siblings (same level)                 | <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                                                                  |
| Jump to top / bottom of the level                 | <kbd>⌘</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>                                                                                               |
| Exit edit, select block above / below             | <kbd>↑</kbd> / <kbd>↓</kbd> at the first / last line                                                                                   |
| Paste as plain text (newlines → spaces)           | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd>                                                                                                 |
| Select all text, then grow by structure           | <kbd>⌘</kbd> <kbd>A</kbd> (repeat — see the selection ladder)                                                                          |
| Focus on the block / exit focus                   | <kbd>⌘</kbd> <kbd>.</kbd> / <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd>                                                                     |
| Strip the block's marker → merge up               | <kbd>⌫</kbd> at line start                                                                                                             |
| Slash menu (dates, turn into)                     | <kbd>/</kbd> at the start of a word                                                                                                    |

With text selected, typing one of the wrapping characters puts the selection
inside it rather than replacing it: select a phrase, press <kbd>(</kbd>, and it
is in parentheses. A bracket closes with its partner (`[` gives `[…]`); a
quote, a backtick, `*`, `_` and `~` close with themselves. Unlike the
formatting keys above, these only ever **add** — wrapping `(a)` again gives
`((a))`, never `a` — because that is what typing a character should do. With
nothing selected the character simply types, as it always has.

Enter from a heading nests the new block underneath it. A list item (bullet,
numbered, to-do) continues its own list whatever the new-block setting says;
Enter on an empty list item exits the list, leaving the block as the configured
new-block type (a paragraph when that is the same list).

### Slash menu

Typing <kbd>/</kbd> at the start of a word (the start of the block, or after a
space) opens a small menu under the caret. Two groups:

- **Dates** — Today, Tomorrow, Yesterday, Next week, Last week, plus whatever
  the phrase you type after the slash resolves to: `/friday`, `/next week on
friday`, `/in 2 weeks`, `/1 oct`. Picking a row replaces the `/phrase` with
  the date as `dd-mm-yyyy`.
- **Turn into** — Text, Bullet list, Numbered list, To-do, Heading, Quote.
  Picking one swaps the block's marker and removes the `/phrase`; the rest of
  the text stays.

Keep typing to filter (`/tom` → Tomorrow, `/list` → both lists, `/task` →
To-do); <kbd>↑</kbd> / <kbd>↓</kbd> move, <kbd>↵</kbd> or <kbd>⇥</kbd> pick,
<kbd>Esc</kbd> closes and leaves the text as typed. A space straight after the
slash, a slash inside a word (`and/or`, a URL), or a phrase that matches
nothing all leave the slash as ordinary text. A pick is its own undo step, so
<kbd>⌘</kbd> <kbd>Z</kbd> puts the typed `/phrase` back.

Pasting while editing follows the same rich-clipboard rules as select mode: a
Ruminate copy splices in with its exact structure, rich text from other apps is
converted to markdown blocks, and plain multi-line text is split into blocks
at the caret. <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd> ignores the rich flavor.

An arrow leaving the edited block **commits the edit and switches to select
mode**: <kbd>↑</kbd> on the first visual line highlights the block above
(<kbd>↑</kbd> on the very first block focuses the note title); <kbd>↓</kbd> on
the last visual line highlights the block below (on the very last block it
highlights the block itself). <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>V</kbd> collapses
newlines to single spaces because a block is one line in the serialized format.

### Focus

Focus makes one block's subtree the whole editor view, with a breadcrumb
tracing the full path (`Note title › ancestor › … › focused block`; every crumb
is clickable, the note-title crumb exits fully). The focus lives in the URL
(`?block=…`), so the browser back button undoes it.

A focused **heading** renders as an editable title at the top, its children
below it — a heading already names what hangs beneath it. **Every other type**
is content rather than a name, so it simply leads the view as its own first
row, drawn as it is anywhere else, with its subtree indented beneath it and no
title above. The rules below that mention "the title" apply to the first
kind; in the second the leading row behaves like any other row, except that it
cannot be deleted or outdented out of its own view.

| Action                        | Trigger                                             |
| ----------------------------- | --------------------------------------------------- |
| Focus on the selected block   | <kbd>F</kbd> (select mode)                          |
| Step back one level           | <kbd>⇧</kbd> <kbd>F</kbd> (select mode)             |
| Focus on the current block    | <kbd>⌘</kbd> <kbd>.</kbd> (both modes)              |
| Leave focus entirely          | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> (both modes) |
| Focus on a block by finger    | **Focus on** in the edit bar (docs/mobile.md)       |
| Navigate to a shallower level | click its breadcrumb crumb                          |

Rules while focused:

- Focusing **in** selects the first child under a title, or the leading row
  itself where there is none; **stepping back** lands on the block you came
  from.
- <kbd>↵</kbd> / <kbd>⌘</kbd> <kbd>↵</kbd> on the title create its **first
  child** (title + body), never a sibling outside the view.
- The title can't be deleted, moved, duplicated, indented, outdented, or
  collapsed from inside its own view; outdenting a top-level block of the view
  (which would eject it) is a no-op, and <kbd>↑</kbd> at the title stays put
  rather than exiting to the note title.
- The <kbd>⌘</kbd> <kbd>A</kbd> ladder's "page" rung is the focused subtree.
- If the focused block disappears (an undo, a stale link), the editor exits the
  focus gracefully and cleans the URL.

### Note title

| Action                                | Shortcut                                              |
| ------------------------------------- | ----------------------------------------------------- |
| Select the title                      | <kbd>↑</kbd> from the first block                     |
| Edit it                               | <kbd>↵</kbd> (or click)                               |
| New root block below                  | <kbd>⌘</kbd> <kbd>↵</kbd> / <kbd>⇧</kbd> <kbd>↵</kbd> |
| Drop back into the editor             | <kbd>↓</kbd>                                          |
| Commit rename and start a block below | <kbd>↵</kbd>                                          |
| Cancel rename                         | <kbd>Esc</kbd>                                        |

A brand-new note opens with the title editing, so the name is the first thing
typed and <kbd>↵</kbd> carries straight on into the first block. A new root
block is of the type <kbd>↵</kbd> makes (Settings → Editor, "New block
markdown"), and reuses an empty block already at the top rather than adding
another.

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
  <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> (stops at the level's
  ends) — or single-key <kbd>w</kbd> / <kbd>s</kbd> in select mode, which
  break out of the level at its ends and continue one level out.
- **Walk depth** (parent / first child): <kbd>a</kbd> / <kbd>d</kbd> in select
  mode (the wasd spatial mapping: a/d = depth, w/s = siblings).
- **Jump to the top / bottom of the current level** (walking up levels rather
  than to the page top): <kbd>⌘</kbd> <kbd>↑</kbd> / <kbd>↓</kbd>.
- **Reorder** a block and its subtree: <kbd>⌥</kbd> <kbd>↑/↓</kbd> or
  <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>↑/↓</kbd> (the Notion convention).
- **Duplicate** a block and its subtree: <kbd>⇧</kbd> <kbd>⌥</kbd>
  <kbd>↑/↓</kbd> (the VS Code convention — down lands on the lower copy, up on
  the upper).
- **Change depth**: <kbd>⇥</kbd> / <kbd>⇧</kbd> <kbd>⇥</kbd>.
- **Select a run of blocks**: <kbd>⇧</kbd> <kbd>↑/↓</kbd>, then act on them.
