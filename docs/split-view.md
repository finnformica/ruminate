# Focus stack and split view

The note page shows one or two **panes** side by side. Each pane shows a
note, rooted at the note or at one block in it, and keeps a **focus stack**:
the views the reader went into, in order. The idea comes from Pensive
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
  selected: string | null // the row selected when the reader left this view
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
  <kbd>⌘</kbd> <kbd>.</kbd> and the touch screen's **Focus on** push.
- **Pop.** `popFrame` removes the top frame. `popTo(pane, i)` removes every
  frame above frame `i`. The frame popped back to hands back its `selected`
  as the **landing**: the editor selects that row once the view shows it
  (`BlockEditor.landing`). <kbd>⇧</kbd> <kbd>F</kbd> pops one frame; a crumb
  pops to its frame.
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
- **Folds.** Each frame keeps its own folds, so a pop restores them. A
  frame focused on a block stores its folds under a key of its own:
  `foldKeyOf(note, { scope })`, with the scope `p<pane>f<depth>:<root>`
  (`frameScope`, `src/routes/_appRoot.views_.$.tsx`). A push clears that key
  (`clearFolds`), so the new frame starts with the default folds. A pop
  (`restored: true`) does not touch the key, so the frame shows its folds as
  the reader left them. A frame on the whole note uses the note's own folds,
  as before. A move to a new, wider view (<kbd>⌘</kbd> <kbd>⇧</kbd>
  <kbd>.</kbd> from a deep link) first opens the folds down to the block
  just left (`openFolds`). The page does all of this in storage before the
  move (`settleFolds`), so the new view never shows the wrong folds.
- **Across notes.** A frame names its note, so one stack can hold views from
  more than one note. While the page is split, a note opened from the sidebar,
  the palette or the Views page opens in the active pane, as a push
  (`useOpenInPane`, `src/hooks/open-note.ts`).
- **Layout.** `openBeside` opens a view in a new pane, or pushes it onto the
  next pane's stack when there is no room for one. `closePane` removes a pane
  (never the last one). `activate` moves the keyboard. `MAX_PANES` is 2.

Each pane keeps its own folds and selection. The selection is the editor's
own state, and each pane has its own editor. A focused frame's fold key
names its pane. Two panes on the whole of the same note write to the note's
one stored entry, so after a reload both start from the folds written last.

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
- `filter` and `sort` stay the first pane's (docs/metadata.md). The second
  pane shows its view as saved, and has no Sort or Filter menu.

A frame is `note[:root[:selected]]`, and frames are joined with commas.
Ids are `blk_…` or date-shaped, and occurrence keys join ids with `/` and
`^`, so neither separator can appear inside a part:

```
/views/A?block=b2&stack=A::b1,A:b1:b1/b2x&pane1=B,B:c1&active=1
```

Here the first pane shows block `b2` of note A. Beneath it are the whole
note (with `b1` selected) and block `b1` (with row `b1/b2x` selected). The
second pane shows block `c1` of note B, with the whole of B beneath it, and
has the keyboard. `layoutFromSearch` drops a malformed frame and a stray
`active`.

The landing row is not in the URL. After a reload, or after back and
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
  with the same header, nav bar and edit bar as before. The URL keeps the
  other pane; a wider window shows it again. `o` and the Split view button
  are not offered there.

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

## Decisions Finn can change

These are choices, not constraints. Each one is local to the file named.

1. **A pushed frame starts with the default folds.** It does not copy the
   folds of the frame beneath. To copy them, read the parent frame's folds in
   `settleFolds` and write them under the new key in place of `clearFolds`.
   The keys differ (a focus view keys rows from its own root), so a copy
   must cut the parent's keys down to the new root.
2. **A whole-note frame uses the note's own folds**, which persist across
   sessions as they did before the stack. Only a frame focused on a block
   has folds of its own. To give every frame its own, set a scope for a root
   of `null` too (`frameScope`).
3. **A focused frame's folds ignore the filter and sort.** The key holds the
   scope and not the narrowing, because the page cannot read the target's
   saved view before the move. A filtered frame still opens every row by the
   standing rule beneath its own folds.
4. **The breadcrumb shows the path between frames**, and a click on a path
   crumb pops to the earlier frame and then pushes. To make a path crumb
   push on top of the stack instead, call `goTo` in place of `goVia`.
5. **Frame fold keys name the pane by its index.** When the first pane
   closes, the second becomes the first and its focused frames start with
   the default folds again.

## Later

The model does not count panes. To add panes or a tiling layout:

1. Raise `MAX_PANES`. The URL codec reads and writes `pane<i>` for every
   pane under the cap; add `pane2` and on to the route's search type
   (`validateSearch`).
2. Give `PaneLayout` a tree of splits in place of the list, if the panes
   must tile. The frames and stacks do not change.
3. Change `SplitView`'s grid.
