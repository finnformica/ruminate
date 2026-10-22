# Focus stack and split view

The note page shows one or two **panes** side by side. Each pane keeps a
**focus stack**: its history of **frames**, the last one on screen. A frame
is one live query state: its root (the note, or a block in it), its
selection, its filter and sort, and its folds. The frame at the bottom comes
from a View (one saved frame, a bookmark: docs/metadata.md) or from opening a
note. The idea comes from Pensive
(github.com/aatack/Pensive), where each tab holds a stack of focus frames and
tab groups sit side by side; no code comes from there.

This is view state only. The graph, the store, sync, the event log and the
D1 schema do not change. Both panes read `graphSnapshotAtom`, so an edit in
one pane shows in the other at once.

## The state model

The model is pure and lives in `src/data/panes.ts` (tests in
`panes.test.ts`):

```ts
interface FocusFrame {
  noteId: string
  root: string | null // null = the whole note
  selected: SelectionPath | null // the row selected when the reader left: ids from the root
  filter?: string // absent = what the root's view saved
  sort?: string
  folds?: FrameFolds // a pushed frame's: rows opened and closed over the rule
}
interface Pane {
  frames: FocusFrame[] // bottom first; the last is the view on screen
}
interface PaneLayout {
  panes: Pane[] // left to right
  active: number // the pane with the keyboard
}
```

- **Push.** `goTo(pane, target, selected)` goes to a view. A view that is
  not on the stack yet is a new frame, and the current frame records
  `selected`, the row selected as the reader left it. <kbd>F</kbd>,
  <kbd>⌘</kbd> <kbd>.</kbd> and the touch screen's **Focus on** push. A
  pushed frame starts from the defaults: no filter or sort of its own (so
  the root's saved view applies), the standing fold rule, and the editor's
  own landing row.
- **Pop.** `popFrame` removes the top frame. `popTo(pane, i)` removes every
  frame above frame `i`. The frame popped back to has its filter, sort and
  folds as the reader left them, and hands back its `selected` as the
  **landing**: the editor selects that row once the view shows it
  (`BlockEditor.landing`). <kbd>⇧</kbd> <kbd>F</kbd> pops one frame; a crumb
  pops to its frame.
- **Narrowing.** The Sort and Filter menus change the frame on screen
  (`withCurrent`), in every pane. A change replaces the URL entry, so it is
  not a step of the history.
- **By way of a frame.** `goVia(pane, i, target)` pops to frame `i`, then
  pushes `target` from it. A path crumb between two frames does this (see
  "The breadcrumb").
- **No view twice.** `goTo` to a view that is already on the stack pops back
  to it. So <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> (the whole note) and the
  note's crumb return to the bottom frame when it is the note, with its
  selection.
- **One frame left.** With one frame and a block in focus, <kbd>⇧</kbd>
  <kbd>F</kbd> leaves the focus for the whole note, as it did before the
  stack. On the whole note with nothing beneath, it does nothing.
- **Folds.** Each frame keeps its own folds, so a pop restores them
  (docs/graph-walk.md, section 5, GW-10).
  - Every frame holds its folds itself, in the URL, as the rows the reader
    opened and closed over the standing rule (`FrameFolds`), with the depth
    they were made at (`depth`). A frame narrowed by a filter or a sort
    keeps a second set (`narrowFolds`), cleared when the narrowing changes.
    A pushed frame starts with none. `useFoldRule` reads and writes them
    through its `owned` argument, and a toggle replaces the URL entry.
  - The bottom frame of a note opened with no folds takes the folds the
    note once kept on the device (`collapse:<noteId>`) once, and the stored
    entry goes (`takeStoredFolds`).
  - A move to a new, wider view (<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd>
    from a deep link) opens the folds down to the block just left, so the
    reader lands on it (`settleFolds`), in the new frame's folds.
  - An indent or an outdent moves a row's folds with it (`rekeyFolds`).
- **Pivots.** Each frame keeps its own link pivots (`pivots`, keyed by
  block id; docs/graph-walk.md, section 3). A pushed frame starts with none,
  and a pop restores them. An up pivot on the frame's own root pushes a
  frame (`pivotRoot`), so Back returns to the view as it was.
- **Across notes.** A frame names its note, so one stack can hold views from
  more than one note. While the page is split, a note opened from the sidebar,
  the palette or the Views page opens in the active pane, as a push
  (`useOpenInPane`, `src/hooks/open-note.ts`).
- **Layout.** `openBeside` opens a view in a new pane, or pushes it onto the
  next pane's stack when there is no room for one. `closePane` removes a pane
  (never the last one). `activate` moves the keyboard. `MAX_PANES` is 2.

Each pane keeps its own frames, so its own folds, pivots and selection.

### Selection

A selection is the path of block ids from the frame's root, as in Pensive:
`SelectionPath`, an array of ids (`src/data/panes.ts`). A block that sits
under two parents is two paths, so a frame never names an unclear place.

- On a whole note the path starts at a top row: `["a", "b", "c"]`.
- In a frame rooted at `r` the path starts with `r`: `["r", "a", "b"]`.
- A step up a link to a parent carries `^` before its id.

The editor names a row by the same ids joined with `/` (an occurrence key,
`src/blocks/view.ts`). The page crosses between the two at one place each
way: `pathOfKey` when the editor reports the row it leaves, and `keyOfPath`
when a pop hands the editor its landing row.

## The breadcrumb

There is one focus breadcrumb, `FocusTrail` (`src/components/focus-trail.tsx`).
It takes the place of the editor's own and hangs in the gutter as before
(`.note-header`, docs/design-principles.md, "Header pull"). It merges the
stack and the graph path:

- **Frame segments.** Each frame of the stack is a segment, with its root as
  the label (the note's title for a whole-note frame). A click pops back to
  that frame, with its root, selection and folds.
- **The path between frames.** Between two frames, the trail shows the blocks
  on the path from the earlier root down to the later root, in a quieter
  colour. This is the path from the frame root to the focused block, as the
  breadcrumb showed it before. A click on one goes by way of the earlier
  frame (`goVia`): it pops to that frame and focuses the block from there.
- **A stack that starts on a block** (an old `?block=` link) leads with the
  note and the path down to the block, so the whole note is one click away.
- **A block with more than one parent.** The stack decides the path. The
  frame beneath recorded the row it was left from as an occurrence key, and
  that key is the path the reader took (`A/B/C`). When the key does not end
  at the next root (the reader focused from another row), the trail shows
  the shortest path from the earlier root (`pathToBlock`).

Outside a focus, the pane draws the same trail above the note title once the
stack holds a frame beneath the view on screen.

## The URL

The layout lives in the URL, so a reload and the browser's back and forward
keep it. Every push and pop is a push of the URL; a change of the active
pane replaces the entry.

```
/views/<note>?block=<root>&stack=<frames>&pane1=<frames>&active=1
```

- The first pane is the page's own address: the path's note and `block`,
  as before. An old `/views/<note>?block=<id>` link opens one pane, focused
  on the block, with an empty stack.
- `stack` holds the first pane's frames beneath the view on screen.
- `pane1` holds the second pane's whole stack, the view on screen last.
- `active` names the pane with the keyboard when it is not the first.
- `filter`, `sort` and `folds` are the first pane's frame on screen.
  `filter` and `sort` work as before (docs/metadata.md). `folds` is written
  only for a pushed frame.

A frame in `stack` or `pane1` is `note[:root[:selected]]`, then any of
`;f=<filter>`, `;s=<sort>` and `;z=<folds>`. Frames are joined with commas.
The encoding is short:

- A path (the selection, a fold) is written from the frame's root. The
  root's own id is left out, and `@` stands for the root itself.
- Each id drops its `blk_`. An id without `blk_` (an old date-shaped note)
  is written after `~`.
- Folds are `+path` for a row opened and `-path` for a row closed, joined
  by `.`.
- A filter or sort escapes `%`, `,`, `:` and `;`.

```
/views/A?block=blk_b2&stack=A::x1/b1,A:blk_b1:@;f=type%3Atodo&folds=-c4&pane1=B,B:blk_c1&active=1
```

Here the first pane shows block `b2` of note A, with row `c4` closed.
Beneath it are the whole note (with row `x1/b1` selected) and block `b1`
(with `b1` itself selected, filtered to todos). The second pane shows block
`c1` of note B, with the whole of B beneath it, and has the keyboard.
`layoutFromSearch` drops a malformed frame and a stray `active`.

### URL length

Measured on two panes of four frames each, every pushed frame with a
selection three deep and a filter:

| Folds in each pushed frame | Query string |
| -------------------------- | ------------ |
| 0                          | 0.7 KB       |
| 20                         | 3 KB         |
| 60                         | 7.7 KB       |

Cloudflare takes URLs up to 16 KB, and browsers take far more, so ordinary
use fits. A link of more than a few KB is hard to share, though, and one
past 16 KB fails on reload. The fallback, not built: when a frame's folds
pass about 2 KB, keep them in `sessionStorage` under a short hash and write
`;z=#<hash>`. On another device, or after the session ends, that frame then
opens with the default folds.

The landing row is not in the URL: a frame on screen records no selection
until it is left. After a reload, or after back and
forward, the editor lands by its own rule: the block left behind, or the
first row.

## The page

`SplitView` (`src/routes/_appRoot.views_.$.tsx`) reads the layout, draws one
`NotePage` per pane on screen, and writes every change back. Each pane is a
whole `PageLayout`, with its own header and scroller. The panes after the
first are `secondary`: their header binds none of the page's keys and draws
no history buttons, and the page's notices show once.

- **Wide screens** (1024px and up) show both panes in two equal columns.
  The header of the pane without the keyboard shows its title in the
  secondary colour.
- **Narrow screens** (a phone, docs/mobile.md) show the active pane only,
  with the same header, nav bar and edit bar as before. Focus goes down
  (**Focus on**, a tap), the breadcrumb goes up, and the browser's back
  button pops a frame, because every push is an entry of the history. The
  URL keeps the other pane; a wider window shows it again. `o` and the
  Split view button are not offered there.

## Keys

| Action                                     | Keys                                     |
| ------------------------------------------ | ---------------------------------------- |
| Push: focus on the selected block          | <kbd>F</kbd> / <kbd>⌘</kbd> <kbd>.</kbd> |
| Pop: back to the view before, with its row | <kbd>⇧</kbd> <kbd>F</kbd>                |
| Split the view, or close the active pane   | <kbd>⌘</kbd> <kbd>\\</kbd>               |
| Open the selected block in the other pane  | <kbd>o</kbd> (select mode)               |
| Move the keyboard to the other pane        | <kbd>g</kbd> then <kbd>p</kbd>           |

Pensive pushes with <kbd>d</kbd> and pops with <kbd>⇧</kbd> <kbd>A</kbd>.
Ruminate keeps <kbd>w</kbd> <kbd>a</kbd> <kbd>s</kbd> <kbd>d</kbd> for tree
moves, and <kbd>F</kbd> / <kbd>⇧</kbd> <kbd>F</kbd> already went into a
block and back along the path taken. So the stack keeps those two keys, and
<kbd>⇧</kbd> <kbd>F</kbd> now also restores the selection. <kbd>⌘</kbd>
<kbd>\\</kbd> is the split key in VS Code. <kbd>g</kbd> <kbd>p</kbd> joins
the `g` chords, and works from select mode.

## Finn's decisions (2026-10-20)

Finn settled these. The ones this branch touches are built as stated:

1. **A pushed frame resets filter, pivots and folds to the defaults.**
   Built for the filter, the sort and the folds. Pivots (inbound and
   outbound links) are not part of this branch.
2. **A selection is the path of block ids from the frame root.** The
   occurrence keys already are this path, so they are reused (see
   "Selection").
3. **Frame state lives in the URL**, encoded short, with folds as
   differences from the default rule — the bottom frame's too, since
   GW-10. See "URL length" for when the URL grows too long, and the
   fallback.
4. A section is a heading block. Not touched here.
5. A note with no View shows only in a frame rooted at the hidden root.
   Not touched here.
6. An edit in an inbound pivot behaves as an edit does today. Not touched
   here.
7. **Phone:** as before — focus goes down, the breadcrumb goes up, the
   browser's back button pops a frame, and one pane only.

## Choices still open

1. **The breadcrumb shows the path between frames**, and a click on a path
   crumb pops to the earlier frame and then pushes. To make a path crumb
   push on top of the stack instead, call `goTo` in place of `goVia`
   (`src/components/focus-trail.tsx`).
2. **The bottom frame's folds.** Decided and built (GW-10): every frame's
   folds are in the URL, and a note opens with the default folds each time.

## Later

### Views that save a stack

A View will save a whole stack: its root is the top frame, with the frames
beneath it. A frame is plain data (ids, strings, arrays; no sets, no
functions), so a View can store `Pane.frames` as it is, and a test checks
that a pane survives a JSON round trip (`panes.test.ts`). The URL codec
(`formatFrame`, `parseFrame`) is a second way to write the same frames.

### More panes

The model does not count panes. To add panes or a tiling layout:

1. Raise `MAX_PANES`. The URL codec reads and writes `pane<i>` for every
   pane under the cap; add `pane2` and on to the route's search type
   (`validateSearch`).
2. Give `PaneLayout` a tree of splits in place of the list, if the panes
   must tile. The frames and stacks do not change.
3. Change `SplitView`'s grid.
