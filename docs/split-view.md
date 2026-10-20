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
- **No view twice.** `goTo` to a view that is already on the stack pops back
  to it. So <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> (the whole note) and the
  note's crumb return to the bottom frame when it is the note, with its
  selection.
- **One frame left.** With one frame and a block in focus, <kbd>⇧</kbd>
  <kbd>F</kbd> leaves the focus for the whole note, as it did before the
  stack. On the whole note with nothing beneath, it does nothing.
- **Folds.** A frame does not record folds. Folds are kept per view, keyed
  by the row's path from the view's root (`src/data/view-state.ts`), so a
  fold made inside a focus never touches the view it came from. A pop
  (`restored: true`) leaves the folds of the view it returns to as they were.
  A push to a new, wider view (<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> from a
  deep link) first opens the folds down to the block just left
  (`revealOnLeaveFocus`), as before.
- **Across notes.** A frame names its note, so one stack can hold views from
  more than one note. While the page is split, a note opened from the sidebar,
  the palette or the Views page opens in the active pane, as a push
  (`useOpenInPane`, `src/hooks/open-note.ts`).
- **Layout.** `openBeside` opens a view in a new pane, or pushes it onto the
  next pane's stack when there is no room for one. `closePane` removes a pane
  (never the last one). `activate` moves the keyboard. `MAX_PANES` is 2.

Each pane keeps its own folds and selection. The selection is the editor's
own state, and each pane has its own editor. The folds are the pane's own
`useFoldRule` state. Two panes on the same note write to the same stored
entry, so after a reload both start from the folds written last.

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

## Later

The model does not count panes. To add panes or a tiling layout:

1. Raise `MAX_PANES`. The URL codec reads and writes `pane<i>` for every
   pane under the cap; add `pane2` and on to the route's search type
   (`validateSearch`).
2. Give `PaneLayout` a tree of splits in place of the list, if the panes
   must tile. The frames and stacks do not change.
3. Change `SplitView`'s grid.
