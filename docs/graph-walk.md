# The graph walk: queries and pivots

Status: **design, not built.** Requested by Finn, who prefers the walk of
[Pensive](https://github.com/aatack/Pensive) to the walk ruminate has now.
This document describes the two walks and lists what a reader sees
differently. It proposes a design for pivots (section 4), a sections-only
toggle and an in-place filter in the walk (section 5), and fixes for fold
state (section 6). It gives a migration plan, open questions, and a note on
layered stores for later. Pensive has no
license: this document takes ideas from it and copies no code.

Nothing here changes storage, events, sync or the D1 schema. The `link` table
(`source_id`, `destination_id`, `kind='child'`, `sort_key`) stays as it is. A
pivot is view state, like a fold.

The words used below:

- **Down** — follow a block's child links: what the block holds.
- **Up** — follow child links the other way: what holds the block (its
  parents, its backlinks).
- **Row** (or occurrence) — one place a block shows in a view: one path from
  the view's root (`src/blocks/view.ts`).
- **Query** — the rule for the rows beneath a row: down, up, or nothing
  (collapse).
- **Pivot** — a query set on one block. It replaces the walk beneath that
  block's rows.
- **Frame** — one view in a pane's focus stack (`FocusFrame`, in the pane
  model of the split-view work, `src/data/panes.ts`).

## 1. Ruminate's walk today

### The pieces

| Piece                                         | File                              | What it does                                                                                                                  |
| --------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `walkGraph`                                   | `src/data/graph.ts`               | The lazy walk. It builds a `BlockDoc` from the graph snapshot and descends only where the fold rule opens a row.              |
| `noteView`                                    | `src/data/graph.ts`               | `walkGraph` from a note: the note's children are the roots, at level 1. The note id is on the path from the start.            |
| `blockView`                                   | `src/data/graph.ts`               | `walkGraph` from a focused block: the block is the one root, at level 0.                                                      |
| `LinkDirections`                              | `src/data/graph.ts`               | `"downstream" \| "upstream" \| "both"`: which links every row follows.                                                        |
| `linkDirectionsAtom`                          | `src/global-state.ts`             | The device setting (Settings → Editor, "Show links"). The default is `"downstream"`.                                          |
| `useNoteDoc`                                  | `src/hooks/note-doc.ts`           | Calls `blockView` (in focus) or `noteView`, then `filteredView`. `setDoc` turns an edit into ops (`docToOps`).                |
| `ExpandedRule`                                | `src/blocks/view.ts`              | `(key, level, type) => boolean`: is this row open?                                                                            |
| `expandedByDepth`                             | `src/blocks/default-collapsed.ts` | The standing depth rule: open while `level < n` (n = 2 by default).                                                           |
| `foldRule`, `useFoldRule`, `withFold`         | `src/data/view-state.ts`          | The reader's own folds (open and closed keys, per view, in localStorage) over the depth rule. A board's row starts closed.    |
| `buildRows`, `walkDoc`, `rowsBeneath`         | `src/blocks/view.ts`              | Turn the walked doc into the flat list of rows the editor draws, with keys, depth, guide lines and fold state.                |
| `keyOf`, `directionOfKey`, `hasOccurrence`    | `src/blocks/view.ts`              | The occurrence key: ids joined by `/`, an up segment marked `^` (`root/child/^parent`).                                       |
| `siblingsOf`, `indentBlock`, `removeBlock`, … | `src/blocks/ops.ts`               | The doc maths. They read the direction off the key and edit `children` or `upstream`, which they keep as mirrors of one edge. |
| `filteredView`                                | `src/data/filter-view.ts`         | A narrowed view (filter or sort). It walks eagerly, then applies the fold rule to what survives.                              |
| `buildUpstreamIndex`                          | `src/utils/block-upstream.ts`     | Not part of the walk. It finds the notes that reach each block, for the developer metadata readout only.                      |

### How a note is drawn

1. The route (`src/routes/_appRoot.views_.$.tsx`) reads `?block=` (the
   focused block), `?filter=` and `?sort=`. It gets the fold rule from
   `useFoldRule(noteId, { filter, sort })` and the directions from
   `linkDirectionsAtom`.
2. `useNoteDoc` calls `blockView` when a block is in focus, else `noteView`.
3. `walkGraph` visits each root. For each block it builds a `Block` with the
   complete list of its children (and, when `directions` is not
   `"downstream"`, the complete list of its parents in `upstream`). These
   lists draw the chevron and keep a save diff empty.
4. At each row, `walkGraph` asks the fold rule. A closed row goes into
   `collapsed` and the walk does not go beneath it. An open row walks its
   children (down) and then its parents (up), as the setting says.
5. `buildRows` walks the doc again, depth-first, and makes the rows.
6. An edit comes back through `setDoc`. `docToOps` diffs it against the
   rows that were shown.

### Direction

Direction is one setting for the whole device. It applies to every row of
every note:

- **Downstream** — the tree. This is the default.
- **Upstream** — the note's blocks are still the roots, but beneath each row
  the walk shows only its parents. The note's own parents are rows after its
  blocks (`BlockDoc.upstream`).
- **Both** — beneath each open row, first its children, then its parents.

Note: `docs/graph-storage.md` ("How the app is fed") says the walk goes
"upstream as well as down by default". The code default is `"downstream"`.
Step 9 of the plan corrects that text.

### The path guard and loops

The walk guards by **path**, not by a visited set:

- A child already on the path is shown once more, as a leaf (`looped`): no
  chevron, nothing beneath. The outline ends where the loop closes.
- A parent already on the path is **skipped**. The parent the row came from
  is not a row beneath it. This also hides a real loop in the up direction.
- Beneath an up row, a child already on the path is skipped, for the same
  reason.

### Laziness

The walk is O(rows on screen). A closed row carries its id lists but no rows
beneath it. Opening a fold walks one more level. There is no budget: the
depth rule and the reader's folds decide what is walked.

### Focus

Focus is one level, in the URL (`?block=`). A focused block's view is the
same walk from a different root. Leaving focus opens the folds down to the
block (`revealOnLeaveFocus`). The split-view work adds a stack of frames per
pane (`src/data/panes.ts`, below).

## 2. Pensive's walk

Pensive's walk is about 150 lines (`frontend/src/queries/resolution.ts`,
`types.ts` and `helpers.ts`). Its model:

- **The view is a query tree.** A tab shows one frame. A frame has a root
  entity and a query. The root query is always "outbound links" (down).
- **A query** is one of two shapes: links in one direction (outbound or
  inbound), or collapse (no rows beneath).
- **The walk is breadth-first** from the root. Each entity it reaches
  becomes a result node. The query gives the ids beneath it.
- **A pivot** is a query stored for one entity id. When the walk reaches an
  entity with a pivot, it does not go beneath it with the current query. It
  puts the entity on a list, and walks it later with the pivot's query. The
  pivot's query then applies to everything beneath that entity, until
  another pivot.
- **Collapse is a pivot.** A collapsed entity gets the collapse query, which
  has no rows beneath. A collapse wins over a link pivot on the same entity.
- **State.** Pivots are kept on the frame, keyed by entity id. Collapses are
  kept on the tab, keyed by entity id. So a pivot or a collapse applies to
  every row of that entity in the view. A hotkey cycles the selected
  entity's pivot through inbound, outbound and none.
- **Budget.** Each query walk stops after 200 entities. A result with ids
  that were not walked is marked incomplete. Each pivot gets a new budget of
  its own.
- **Cycles.** There is no path guard. The budget is the only thing that
  stops a cycle: the cycle repeats until the budget is spent.
- **Drawing.** The result tree is flattened depth-first for display, so
  breadth-first order changes only which rows the budget drops. A pivoted
  row shows a small label (`--> inbound`).
- **Filter.** Each frame has a highlight: a text, a sections-only flag and
  "hide snoozed". A row passes when its text holds the highlight text, it
  is a section (when the flag is on), and it is not snoozed. `prune` keeps a
  row when it passes or when a row beneath it passes, so the ancestors stay
  as the path. A passing row's children go unless they pass too. The prune
  keeps a pivoted subtree whole. A section is a flag on any entity, not a
  type. Finn toggles sections-only with `q`.
- **Focus.** A frame has a `context` (the frame beneath it). Push makes the
  selected entity the new root with no pivots. Pop goes back to the frame
  beneath, with its pivots.
- **Edits.** A row's path is a list of ids. The move tool takes the row
  above as the parent, and does not look at the pivot direction.

## 3. What a reader sees differently

| Topic                     | Ruminate today                                                                                                                                   | Pensive                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Who chooses the direction | One setting per device, for every row of every note.                                                                                             | The reader, per entity, in the view. One row shows its backlinks; the rest show children.                                             |
| Mixed directions          | "Both" shows children and then parents beneath every open row.                                                                                   | A row shows one direction. There is no "both".                                                                                        |
| Beneath an up row         | Its other children and its parents ("both"), or only its parents ("upstream").                                                                   | Only its parents: the inbound query continues down the chain of holders until another pivot.                                          |
| The row it came from      | Skipped. A block's own parent is not shown beneath it.                                                                                           | Shown. An inbound pivot under its parent lists that parent again beneath it.                                                          |
| How deep a view opens     | n levels (2 by default), then rows start closed. Each closed row has a chevron.                                                                  | Everything opens until 200 rows, then the rest is marked incomplete.                                                                  |
| Fold scope                | Per row (occurrence key), per view, per device. A block with two rows has two folds.                                                             | Per entity, per tab. A collapse closes every row of that entity.                                                                      |
| Pivot scope               | No pivots.                                                                                                                                       | Per entity, per frame.                                                                                                                |
| Root direction            | The note's blocks are always the roots.                                                                                                          | The root is always walked outbound. A pivot on the root is not read.                                                                  |
| Cycles                    | Shown once where they close (down), or skipped (up).                                                                                             | Repeated until the budget is spent.                                                                                                   |
| Focus                     | One level (`?block=`), plus browser history. The split-view work adds a stack per pane.                                                          | A stack of frames per tab. Each frame keeps its pivots.                                                                               |
| A marker on the row       | Up rows look like child rows.                                                                                                                    | A pivoted row has a label that names its query.                                                                                       |
| Editing a parent row      | Direction-aware: Enter adds a new holder, indent and outdent move the link the other way, ⌫ unlinks.                                             | The move tool takes the row above as the parent in every direction.                                                                   |
| Filter                    | A query in the note's header (`?filter=`), first pane only. It keeps a match's ancestors and all of its children. A narrowed view walks eagerly. | A text, a sections-only flag (`q`) and hide snoozed, per frame. It keeps a match's ancestors only, and keeps a pivoted subtree whole. |
| Sections                  | No toggle. ⌘P lists the headings in the palette.                                                                                                 | Sections-only shows the structure without the detail.                                                                                 |

## 4. The design

### 4.1 The model in one paragraph

A view is a root and a query. The default query is down, so with no pivots a
note reads exactly as it does today. The reader can put a **pivot** on a
block in the view: "show what holds this" (up) or, inside an up region, "show
what this holds" (down). The pivot replaces the walk beneath each row of that
block, and the rows beneath inherit it until another pivot. A **fold** is a
collapse pivot on one row. The walk stays lazy and has no budget: it walks
only rows that are open. Pivots belong to a frame, so each pane, and each
frame in a pane's focus stack, has its own. The global "Show links" setting
goes away at the end.

Example graph, used below:

```
Note N ── A ── X ── Y
     └─── B
Note P ── X            (X has two parents: A and P)
```

With no pivots, N shows `A, X (under A), Y (under X), B`. Put an up pivot on
X. Beneath the X row the reader now sees `P` (an up row) and not `Y`. A is
not listed: it is the row X came from. Beneath P, the walk stays up: P's
holders (none here). The other rows of N do not change.

### 4.2 Types

A new pure module, `src/blocks/query.ts`. The names reuse `Direction`
(`"down" | "up"`, `src/blocks/view.ts`), so there is one name for each
direction.

```ts
/** The rule for the rows beneath a row. */
export type Query = { type: "links"; direction: Direction } | { type: "collapse" }

/** The link pivots of one frame: block id → the direction its rows walk.
 * Keyed by block id, as Pensive keys them (see 4.4). */
export type LinkPivots = ReadonlyMap<string, Direction>

/** Everything a walk reads to decide a row: the frame's link pivots, and
 * the fold rule (the reader's folds over the depth rule) for collapse. */
export interface WalkRule {
  pivots: LinkPivots
  expanded: ExpandedRule
}

/** The query beneath one row. Pure. */
export function queryAt(
  rule: WalkRule,
  row: { key: string; id: string; level: number; type?: string },
  inherited: Direction,
): Query
```

`queryAt` decides in this order:

1. The fold rule says the row is closed → `collapse`. A fold wins over a
   link pivot, as in Pensive. The pivot stays stored. When the reader opens
   the row, the pivot applies again.
2. The block has a link pivot → `links` in that direction.
3. Else → `links` in the inherited direction (the direction of the row
   above's query; the frame's root query at the top).

`Occurrence` (`src/blocks/view.ts`) gains one field, `pivot?: Direction`,
set when the row's block has a link pivot. The editor draws the marker from
it.

The root query of a frame is the pivot on the frame's root id (the note id
or the focused block id). No pivot there means down. So a pivot on the root
is read, which Pensive does not do.

### 4.3 The guard: one rule in both directions

The rows beneath a row are the ids its query lists, with one rule:

- The block the row **came from** is not a row beneath it. That is the row
  above, when the row above is reached in the other direction (an up row
  beneath a down row, or a down row beneath an up row).
- Any other block already on the path is a **looped** row: shown once, as a
  leaf, with no chevron and no pivot control.

Today the guard skips every parent on the path. Under the new rule an up
loop shows where it closes, the same as a down loop. Example: blocks C and D
hold each other, and C is in N. Pivot C up. Beneath C: D (C's holder).
Beneath D (still up): C is D's holder and is on the path, so C shows as a
looped leaf. Today that C is skipped, and the reader cannot see the loop.

The note id (or the focused block id) is on the path from the start, as
today (`rootId` in `walkGraph`).

### 4.4 Where pivot state lives

| Choice                    | Result                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Per frame, in the URL     | **Proposed.** Each pane and each frame has its own. Reload, share and pop keep them.                |
| Per view, in localStorage | Two panes on the same view share pivots. Lost on another device.                                    |
| In the `views` table      | Synced, but it is a schema change, and it mixes reading state with what a note lists. Not proposed. |

The proposal:

- `FocusFrame` (`src/data/panes.ts`) gains `pivots: LinkPivots`. A new frame
  starts with none. `goTo` and `popTo` keep each frame's pivots as they are,
  so a pop restores the pivots the reader left.
- The URL frame format `note[:root[:selected]]` gains a fourth field: the
  pivots, as `id~u` or `id~d` joined by `;`. Ids hold none of `,`, `:`, `~`
  or `;`. The first pane's frame on screen uses a `pivots` parameter beside
  `block`. A change of pivot replaces the URL entry (`replace: true`), so it
  does not add a history step.
- Pivots are keyed by **block id**, as in Pensive, not by occurrence key. A
  pivot is a question about a block ("what holds this?"). The answer is the
  same at each place it shows, and an id is short in a URL. It also
  survives an indent or a move that changes the row's path.
- Until the split-view work merges, the note route holds one frame's pivots
  in the `pivots` parameter, with the same codec.

### 4.5 Folds are collapse pivots

Folds stay where they are: per view, per row (occurrence key), in
localStorage (`src/data/view-state.ts`), over the depth rule. They need no
migration. The split-view work also keeps them there ("Folds need no
record").

At the walk, a fold is the collapse query (`queryAt`, step 1). So the walk
reads one rule, but the two kinds of state keep their own scope:

- A fold is fine-grained and many: one row, kept per device.
- A link pivot is deliberate and few: one block, kept with the frame.

Two rules join them:

- **Setting a pivot opens the row.** The command records an explicit open
  fold for that row (`withFold(…, true)`), as `indent` does with `reveal`.
  The reader asked to see the row's holders, so the depth rule must not hide
  them.
- **The depth count starts again at a pivot.** The rows beneath a pivot row
  are level 1, as a focused block's children are. So a pivot opens n levels
  of holders, whatever the depth of the row. (Open question 5.)

A board's row still starts closed (`foldRule`).

### 4.6 The lazy walk, with no budget

`walkGraph` keeps its shape: depth-first, lazy, one `Block` per id. Changes:

- It takes `pivots` and asks `queryAt` at each row, instead of reading one
  `directions` value.
- `blockOf` fills a block's `upstream` list when the row's query is up, or
  the row was reached up. The default view (no up pivot) then builds the
  same doc as today, so the walk-equals-parse invariant still holds.
- There is no queue, no budget and no incomplete marker. Pensive is
  breadth-first only to share its budget fairly. With no budget the order of
  the walk does not change what is drawn.

What bounds the walk is what the reader can see:

- A closed row (fold, depth rule, board) carries its id lists and no rows.
- A looped row is a leaf.
- An up region follows the depth rule, from the pivot row down.

So the cost stays O(rows on screen plus their id lists). The renderer's
hard depth cap stays as a last guard.

### 4.7 A block with many parents, and a cycle

- **Many parents.** A block with two parents is two rows, one per path, as
  today. Each row has its own key and its own fold. A link pivot on the
  block applies to both rows. Beneath an up pivot, a block with three
  holders shows them as three rows, less the one it came from. A text edit
  shows in every row.
- **Order of holders.** Holders have no order of their own. They show in
  the order `parentIdsOf` gives them, as up rows do today. They cannot be
  reordered (open question 9).
- **A cycle.** The guard in 4.3 shows a cycle once where it closes, in
  either direction. A looped row has no chevron and offers no pivot.
  Focusing on it starts a fresh path, as today.
- **A block under itself** stays refused (`docToOps`, paste).

### 4.8 Editing inside an up pivot

The rows beneath an up pivot are up occurrences, keyed with `^`, exactly as
the "upstream" setting draws them today. So the doc maths in
`src/blocks/ops.ts` already act on them correctly. They read the direction
off the key. The change is that a command must see the same rows the walk
drew: `CommandInput` gains the frame's `pivots`, and `keysBeneath`
(`src/blocks/commands.ts`) calls the new `rowsBeneath` with them.

Take row X with an up pivot, and its holder rows P1 and P2 beneath it.

| Command on P1 (an up row)       | Effect on the graph                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Type, change type               | The block's own text and type, as everywhere.                                            |
| Enter (new row after P1)        | A new block that holds X. The new row is an up row beside P1.                            |
| Enter with text after the caret | Refused with a toast when P1 has more than one place, as today for any block held twice. |
| Indent P2 (under P1)            | P2 stops holding X and holds P1. The row now shows beneath P1, as P1's holder.           |
| Outdent P2 (from beneath P1)    | The reverse: P2 stops holding P1 and holds X again, as a row beside P1.                  |
| ⌫ on an empty row, Cut, Unlink  | Unlinks P1 → X. P1 lives on wherever else it is held, or goes to its note's basket.      |
| Delete (block menu)             | `deleteBlockOps`, as everywhere: every inbound link and the row are tombstoned.          |
| Move up or down                 | Refused: holders have no order (`moveBlocks` returns the doc as it is).                  |
| Duplicate                       | Refused: a copy of a holder would copy the block too (`duplicateBlocks` returns null).   |
| Paste in select mode            | Refused with a toast in the first version (open question 8).                             |
| Add downstream / upstream link  | As today: they act on the block, not on the row's direction.                             |
| Set or clear a pivot            | Allowed on any row except a looped row. A down pivot on P1 shows what P1 holds, less X.  |

The pivot row itself (X) edits by its own key, as today. The pivot changes
what is beneath X, not X.

A command that adds a row beneath X must use X's query, not the direction
of X's key. The one case today is Enter on a heading (`insertBelow`): it
nests the new block under the heading with `indentBlock`, in the heading's
key direction, so the new block becomes a child. Under an up pivot on the
heading that child is not drawn, and the row the reader just made goes away.
The fix: when X's query is up, the new block becomes a holder of X, an up
row beneath it. Step 6 adds a test for this.

Markdown stays a tree. The rollup, copy, the clipboard payload and the
search index walk down only, and ignore pivots. Copy of a selection in an up
region copies the selected blocks with what they hold, as today.

### 4.9 Filter and sort

Section 5 moves the filter, the sort and a new sections-only toggle into the
walk. They apply to down rows only. An up region is kept whole, as Pensive's
prune keeps a pivoted subtree whole (open question 7).

### 4.10 What the reader sees

- The block menu gets two entries: **Show what holds this** (up) and, on a
  row in an up region, **Show what this holds** (down). A row with a pivot
  gets **Clear pivot** instead of its current entry. The final copy is for
  Finn (docs/settings.md, Copy).
- One shortcut cycles the selected row's pivot: up, then down, then none.
  It goes in `src/shortcuts/registry.ts` and `src/blocks/keymap.ts`.
- A pivoted row shows a small arrow beside its chevron: up for "held by",
  down for "holds". The rows beneath look like rows.
- The touch screen offers the same entries in the long-press sheet.

### 4.11 What does not change

- The graph, the `link` table, ops, events, sync and D1.
- The occurrence key format (`/` and `^`).
- Folds and their storage.
- The doc maths for up rows.
- Markdown import and export.

## 5. Sections and the in-place filter

Finn uses Pensive's sections toggle (`q`) to walk the structure of a note
without the detail. This section adds a sections-only toggle to each pane,
and moves the text filter into the walk.

### 5.1 What ruminate has now

- **Filter.** The note header's Filter takes a query-language string
  (`?filter=`, `viewNarrowing`, `src/utils/view-narrowing.ts`). The search
  engine answers it (`searchBlocks`). `filteredView`
  (`src/data/filter-view.ts`) then prunes an **eager** walk. It keeps a
  match, the match's ancestors (drawn dimmed, as `context`), and everything
  beneath the match. The row in edit stays until the edit leaves it
  (`keep`). The split-view work keeps the filter on the first pane only.
- **Sections.** There is no toggle. `type:heading` as a filter does not do
  the job: it keeps everything beneath each heading, so the note comes back
  almost whole. ⌘P lists the headings in the palette, but that is a list,
  not the outline.

### 5.2 State: on the frame

A pane's frame gets two more fields, beside its pivots (4.4):

```ts
interface FocusFrame {
  noteId: string
  root: string | null
  selected: string | null
  pivots: LinkPivots
  /** Sections-only: walk the structure without the detail. */
  sections: boolean
  /** The in-place filter: a query-language string; "" for none. */
  filter: string
}
```

- Each pane, and each frame in a pane's focus stack, has its own toggle and
  its own filter. A pop restores them with the frame, as in Pensive.
- In the URL, `sections` is a flag in the frame field after the pivots. The
  filter is URI-encoded inside the frame field, so its `:` and `,` cannot
  break the frame format. The first pane's frame on screen keeps `?filter=`,
  so links made before panes still open filtered.
- A saved view's filter (the `views` row) is the bottom frame's start
  value, as `narrowingParam` makes it today. The sort stays a view setting.

### 5.3 Sections-only

**What counts as a section.** The heading types: `h1`, `h2` and `h3`
(`isHeading`, `src/blocks/markers.ts`). This design also counts a linked
note row (`note`) and a board row (`board`). Each names a part of the
structure, and a reader walks into it by focus. No other type counts
(open question 12).

**The rule.** With sections-only on, a down row shows when:

1. it is a section, or
2. a section is beneath it. It is then drawn dimmed, as path, like the
   filter's `context`.

Beneath a section, only rows that pass the same rule show. So the body of a
section is hidden, and a section's chevron shows only when a section is
beneath it. This is Pensive's prune, and it is different from the text
filter, which keeps a match's body.

**With a text filter.** Both apply: a row passes when it is a section and
it matches. Its ancestors stay as path.

**The view's root** always stays, as the filter keeps it today
(`keepRoots`). A note with no sections shows its title and a short notice.
The notice copy is for Finn.

**Pivots.** Sections-only applies to down rows only. An up region is kept
whole (4.9).

**Edits.** A sections-only view is a narrowed view. It edits by the rules a
filtered view edits by today (`docToOps` with `shown`): text and type edits
act on the block; a move or an indent acts among the rows shown; the hidden
rows and their order do not change. A new row made by Enter after a heading
is not a section. It stays while in edit (`keep`), and then goes, as a
non-matching row does under a filter today.

### 5.4 The in-place text filter

The filter keeps its query language and its prune rule (a match, its
ancestors as path, and its body). The change is where it runs: in the walk,
per frame, for every pane.

- **Per frame and per pane.** It comes from `FocusFrame.filter`. The
  second pane gets a filter of its own.
- **One box.** The pane header's Filter field. `/` already focuses the
  page's search field (`APP_SHORTCUTS.focusSearch`). On a note, `/` in select
  mode focuses the active pane's filter field. `Escape` in the field leaves
  it, and `Escape` again on an empty field clears the filter.
- **Scope.** The engine scopes hits to the note (`viewNarrowing`). Rows of
  other notes in an up region never match. So the filter keeps an up region
  whole (4.9).

Pensive also has "hide snoozed". Ruminate has no snooze. The nearest
counterpart is "hide done to-dos" (`-type:done` as a filter today). A third
toggle is open question 15.

### 5.5 Part of the walk, and still lazy

Today a narrowed view walks the whole note eagerly, because a branch's fate
depends on what is beneath it. Both narrowings can tell that from an index
instead, so the walk stays lazy and has no budget:

- **Sections.** A `sectionReach` set per snapshot: every node from which a
  section can be reached down. Build it once by walking **up** from each
  section over the reverse index (`parentLinks`). Memoise it on
  `graphSnapshotAtom`, so every pane shares it. The cost is O(sections ×
  their ancestors).
- **Text filter.** The ancestor closure of the matched ids, built by
  walking up from each match to the view's root. The cost is O(matches ×
  depth), once per filter and snapshot.
- **Sort.** `walkGraph` orders a block's child list when it walks the
  block. Each `Block` already holds the complete list, so the sort needs no
  eager walk either.

`walkGraph` takes the narrowing as one more option. Beneath a row it lists
only the children that pass: in the reach set or the closure, or beneath a
match. Then it asks the fold rule as usual. `filteredView` becomes a thin
wrapper and then goes away (step 13).

### 5.6 Keys

**Row keys.** A narrowed row keeps the occurrence key it has in the full
note, because the key is the row's path in the graph (`src/blocks/view.ts`).
So a selection, a fold or a pivot survives a toggle of sections-only or of
the filter.

**Fold entries.** A narrowed view keeps folds of its own, over a standing
rule of everything open (`foldKeyOf`, `src/data/view-state.ts`).
Sections-only joins that key: `foldKeyOf(noteId, { filter, sort, sections
})`. So a fold made in sections-only never closes a row of the full note.

**Keyboard keys.**

| Key (select mode)   | Action                                                   |
| ------------------- | -------------------------------------------------------- |
| `q`                 | Toggle sections-only in the active pane. Free on `main`. |
| `/`                 | Focus the active pane's filter field.                    |
| `Escape` (in field) | Leave the field. On an empty field, clear the filter.    |

The split-view work adds `o` (open beside), so `q` does not collide. The
help panel lists the keys from `src/shortcuts/registry.ts` as usual.

## 6. Fold state: why rows need folding again

Finn often folds and unfolds the same rows again and again. This section
finds the causes in the code, compares Pensive, and ranks the fixes.

### 6.1 The fold model today

- A standing **depth rule**: a row is open while `level < n`, n = 2 by
  default (`expandedByDepth`, `src/blocks/default-collapsed.ts`).
- Over it, the reader's **own folds**: open and closed occurrence keys, per
  view, in localStorage (`collapse:<viewKey>`, `src/data/view-state.ts`).
  At most 500 views are kept.
- A board row starts closed (`foldRule`).
- A narrowed view has its own entry, over a rule of everything open.

### 6.2 Causes

1. **Leaving a focus stores opens.** `revealOnLeaveFocus`
   (`src/routes/_appRoot.views_.$.tsx`) opens each closed fold on the path
   back to the block, with `setFold(key, true)`. These are stored as the
   reader's own opens. After a few focus trips the note stays open along
   every path the reader came back on, and the reader folds those rows
   again.
2. **Focus changes the keys and the levels.** `blockView` keys rows from
   the focused block (`F/c`). The note keys the same row `a/F/c`. So a fold
   made in focus does not apply in the note, and the opposite. The depth
   rule also counts from the focused block (level 0), so a row closed in
   the note can be open in focus, and the opposite.
3. **A fold is lost when its row moves.** Indent, outdent, a move to
   another parent, cut and paste, and a drag give the row a new path, and
   so a new key. The new key has no entry, so the depth rule decides. The
   level can change too, so a row that was open can now start closed.
4. **The depth rule closes new rows.** A row that arrives from another
   device, a paste or a sync is decided by the rule. Every parent at
   level n starts closed.
5. **A block with two places has two folds.** The reader folds it in one
   place and finds it open in the other.
6. **Folds stay on one device.** Another device, a cleared browser, or a
   note older than the last 500 written starts on the depth rule again.
7. **Two panes overwrite each other** (when the split view lands). Each
   `useFoldRule` holds its own copy and writes the whole entry on each
   toggle (`writeFolds`). Two panes, or two browser tabs, on one note undo
   each other's toggles. A reload shows the last pane's set.
8. **A filter's folds stay with the filter.** A fold made while filtered
   does not carry to the note. This is by design.

### 6.3 What Pensive does

- Everything is open by default. The 200-row budget stops the walk.
- A collapse is keyed by entity id, per tab. It survives a move and
  applies at every place the entity shows.
- The reader narrows by scope, not by folds: push a frame (focus), or
  turn on sections-only or a text filter. A pop restores the frame as it
  was.

### 6.4 Fixes, ranked by value against cost

| Rank | Fix                                                                                                                                                                                                                                                                          | Causes  | Value  | Cost   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ------ |
| 1    | **Do not store the opens that leaving a focus makes.** Hold them on the frame, as a transient layer over the folds. `useFoldRule` already takes a `held` set for this kind of layer.                                                                                         | 1       | High   | Low    |
| 2    | **Write one key, not the whole entry.** Read the stored entry, change the one key, and write it back. Listen for the `storage` event so other panes and tabs see the change.                                                                                                 | 7       | High   | Low    |
| 3    | **Move a fold with its row.** `indentBlock` and `outdentBlock` already return the row's new key. A move among siblings keeps its key. Cut and paste, and a drag, pass the old and the new path. Rewrite the stored keys under the old path to the new path in the same step. | 3       | High   | Low    |
| 4    | **Scope instead of fold.** Sections-only (`q`) and the per-pane filter (section 5) let the reader see the structure without closing rows one by one, and leave the folds alone.                                                                                              | 4, 5    | High   | Medium |
| 5    | **A depth setting of "All"** (Pensive's default), plus two fold commands: fold the siblings of the row, and fold the note to the row's level.                                                                                                                                | 4       | Medium | Low    |
| 6    | **Collapse by block id** (Pensive), with a key per row only for a block that shows in more than one place. A fold then survives a move and applies in focus and in the note. `foldRule` already reads bare-id entries.                                                       | 2, 3, 5 | Medium | Medium |
| 7    | **Folds per focus frame.** A frame keeps the folds made in it, so a pop restores them exactly. With fixes 1 and 2, a pop already restores the view it returns to, so this adds little.                                                                                       | 1, 2    | Low    | Medium |
| 8    | **Folds on every device.** Sync the reader's folds. This needs a store change, which is out of scope here.                                                                                                                                                                   | 6       | Medium | High   |

The proposal: do 1, 2 and 3 first (small, and each removes a cause). Do 4
with the walk work. Ask Finn about 5 and 6 (open question 16). Leave 7 and 8.

Fix 6 changes one rule of the split-view work: there, a fold made in focus
never touches the view it came from. With fold by id, it does. Fix 3 gives
most of fix 6's gain without that change.

## 7. Migration plan

Each step is one small PR. Each PR runs only the test files it touches, and
the pre-push gate. A step that a reader can see adds a changelog file.

1. **Add the query types and the rule.** Add `src/blocks/query.ts` with
   `Query`, `LinkPivots`, `WalkRule` and `queryAt`. No caller yet.
   Tests (`query.test.ts`): fold beats pivot; pivot beats inherited; no
   pivot inherits; the depth count starts again at a pivot; a board row
   starts closed.
2. **Teach `walkGraph` to read pivots.** Add `WalkOptions.pivots`, passed
   through `noteView` and `blockView`. Keep `directions` as it is for now.
   With no pivots, the walk is the same as today.
   Tests (`graph.test.ts`): every existing walk test passes unchanged; an up
   pivot on a row lists its holders, less the row it came from; the region
   inherits up; a down pivot inside an up region; a pivot on the note root;
   a closed row beneath a pivot is not walked (its rows are not in
   `blocks`).
3. **Teach the rows to read pivots.** `buildRows`, `walkDoc`,
   `rowsBeneath`, `occurrenceKeys` and `firstOccurrenceKey` take the
   pivots. `Occurrence.pivot` is set. `CommandInput` gains `pivots`, and
   `keysBeneath` uses them.
   Tests (`view.test.ts`, `commands.test.ts`): the rows equal the walk for
   the same pivots; `hasChildren` follows the row's query; fold toggles
   under a pivot act on the right keys.
4. **Hold pivots on the frame.** Add `pivots` to `FocusFrame` and the URL
   codec (`src/data/panes.ts`), or, before the split-view work merges, a
   `pivots` parameter on the note route. `useNoteDoc` passes them to the
   walk.
   Tests (`panes.test.ts`): format and parse round-trip; a malformed pivot
   is dropped; `goTo` starts a frame with none; `popTo` restores a frame's
   pivots; two panes keep their own.
5. **Let the reader set a pivot.** Add the block menu entries, the
   shortcut, the row marker and the long-press entries. Setting a pivot
   records an explicit open fold. Add a changelog file.
   Tests: a `commands.test.ts` case for the pivot command; `keymap.test.ts`
   resolves the shortcut; a Storybook story with an up pivot (its visual
   baseline comes from CI).
6. **Check every edit inside an up pivot.** Add a test for each row of the
   table in 4.8, on a block with two holders and on a cycle. Fix each gap
   (paste refused with a toast; Enter on a heading with an up pivot makes a
   holder). Add a changelog file if a reader sees a
   change.
   Tests: `commands.test.ts`, `ops.test.ts`, `block-editor` tests for paste.
7. **One guard in both directions.** Show an up loop where it closes
   (4.3). This changes what the "upstream" setting shows, so it is its own
   PR.
   Tests (`graph.test.ts`, `view.test.ts`): a two-block cycle walked up
   shows one looped leaf; the row it came from is still skipped.
8. **Pivots in a narrowed view.** `filteredView` walks with the frame's
   pivots, and keeps an up region whole (4.9). Step 13 later moves the
   narrowing into the walk.
   Tests (`filter-view.test.ts`): a filter does not prune an up region; a
   sort leaves up rows in holder order.
9. **Retire "Show links".** Remove `linkDirectionsAtom`, `LinkDirections`,
   the `directions` options and the Settings entry. Remove the stored
   `link-directions` value. Update `docs/graph-schema-v2.md` ("Upstream"),
   `docs/graph-storage.md` ("How the app is fed"),
   `docs/block-editor-architecture.md` ("Rows, keys and direction") and
   `docs/settings.md`. Run knip. Add a changelog file.
   Tests: the settings tests lose the option; the walk tests that used
   `directions` move to pivots.

10. **Write one fold key at a time** (6.4, fix 2). `setFold` reads the
    stored entry, changes one key and writes it back. `useFoldRule` listens
    for the `storage` event.
    Tests (`view-state.test.ts`): two hooks on one view keep both toggles;
    a toggle in one hook shows in the other.
11. **Do not store the opens that leaving a focus makes** (fix 1).
    `revealOnLeaveFocus` puts its opens in a transient layer on the frame
    (the `held` set of `useFoldRule`), not in the stored folds.
    Tests (`view-state.test.ts`): a held open shows the row and is not
    written; a reload is back on the stored folds. Add a changelog file.
12. **Move a fold with its row** (fix 3). Add a pure `rekeyFolds(folds,
from, to)` to `src/data/view-state.ts`. Indent, outdent, cut and
    paste, and a drag call it with the old and the new key.
    Tests (`view-state.test.ts`, `commands.test.ts`): a closed row stays
    closed after indent and outdent; its closed descendants stay closed;
    other keys do not change. Add a changelog file.
13. **Narrow inside the walk** (5.5). Add the `sectionReach` index and the
    filter's ancestor closure. `walkGraph` takes the narrowing and sorts
    child lists as it walks. `filteredView` becomes a thin wrapper, then
    goes.
    Tests (`graph.test.ts`, `filter-view.test.ts`): the lazy walk gives
    the same rows, context and matches as the eager walk for every
    existing filter test; a closed row is not walked; a loop ends the
    walk.
14. **Sections-only** (5.3). Add the `sections` frame flag, its URL form,
    the `q` key, a header toggle and the fold entry key.
    Tests: `query.test.ts` or `graph.test.ts` for the rule (a section, a
    path row, a hidden body, a linked note and a board row, a note with
    no sections); `panes.test.ts` for the URL; `keymap.test.ts` for `q`; a
    Storybook story. Add a changelog file.
15. **A filter per frame and per pane** (5.4). Move the filter to
    `FocusFrame.filter`, with the first pane's `?filter=` kept. The second
    pane gets a filter field. `/` focuses the active pane's field.
    Tests (`panes.test.ts`): an encoded filter round-trips; a pop restores
    the frame's filter; two panes keep their own. Add a changelog file.
16. **Collapse by block id** (fix 6), only if Finn wants it (open question
    16). Write a fold by id for a block with one place, by key for a block
    with more.
    Tests (`view-state.test.ts`): a fold survives a move to another parent;
    a fold made in focus shows in the note; a block in two places keeps a
    fold per place.

Steps 1 to 3 change nothing a reader sees. Step 4 needs the split-view work
or the route parameter. Steps 5 to 8 can merge in any order after 4. Steps
10 to 12 do not depend on pivots and can go first. Steps 14 and 15 need
step 13, and step 15 needs the frame model of step 4.

## 8. Open questions for Finn

1. **Pivot key.** This design keys a pivot by block id, as Pensive does, so
   a pivot applies to every row of the block in the frame. Do you want it
   per row (occurrence key), like a fold?
2. **"Both".** Pensive has no query that shows children and holders
   together. Do you use "Both" today? If yes, do you want a third query,
   or can it go?
3. **Where pivots live.** The URL (per frame, per pane) is proposed. Do you
   want them to stay on a note when you open it again later (localStorage
   per view)?
4. **Focus into a pivoted row.** Pensive starts a new frame with no
   pivots. Do you want the new frame to start with the row's pivot, so a
   row that shows its holders opens on its holders?
5. **Depth inside a pivot.** This design starts the depth count again at a
   pivot, so a pivot shows n levels of holders. Do you want all holders
   open (as in Pensive), or one level only?
6. **An up pivot on the note root.** It replaces the note's blocks with what
   holds the note, as in Pensive. Is that what you want, or must the note's
   blocks stay?
7. **Filter and pivots.** This design keeps an up region whole under a
   filter and under sections-only, as Pensive keeps a pivoted subtree
   whole. Do you want the filter to prune holders too?
8. **Paste and drag into an up region.** Refuse (proposed for the first
   version), or link each pasted block as a new holder?
9. **Order of holders.** Holders have no order of their own. Do you want
   them sorted, for example by note title or by when the link was made?
10. **Folds per pane.** Folds stay per view, so two panes on one note share
    them. Do you want folds per pane as well?
11. **Labels and shortcut.** Which words and which key do you want for the
    pivot entries and the cycle shortcut?
12. **What is a section.** Headings, plus linked note rows and board rows,
    is proposed. Do you want headings only, or other types as well (for
    example quotes, or bold first lines)?
13. **A section's hidden body.** Do you want a count of hidden rows on a
    section in sections-only, so you can see where the detail is?
14. **The filter's language.** The design keeps the query language
    (`type:`, `under:`, text). Pensive matches plain text only. Is the
    query language right for the in-place filter?
15. **A third toggle.** Do you want "hide done to-dos" as a toggle, the
    nearest counterpart of Pensive's "hide snoozed"?
16. **Fold by id.** Fix 6 makes a fold follow the block, and a fold made
    in focus then shows in the note. Do you want that, or are fixes 1 to 3
    enough? Do you want a depth setting of "All" (fix 5)?
17. **Keys.** Is `q` right for sections-only, and `/` for the filter field?

## 9. Later: layered stores

Finn: a nice-to-have, not for now. This section records the idea only.

**Today.** A share is a slice of another user's corpus, fetched whole and
held in memory, then merged into `graphSnapshotAtom`
(`src/data/shared-mode.ts`, docs/sharing.md). The write seam
(`src/data/store.ts`) sends a batch of ops to the share it names, and only
the verbs the owner granted are allowed. A block cannot live in a shared
note and in one of your own at once.

**The idea.** Treat each share as a read-only **layer** under your own
corpus. Your edits go in your own layer, on top:

- A link from one of your blocks to a block of the share puts that block in
  your outline, with no copy.
- A change of text or type on a share's block is an override row in your
  layer. You see the override; the owner's block does not change.
- To hide a share's link in your view is a hide row in your layer.

**What the walk needs.** Nothing new. The walk reads one merged snapshot,
so pivots, folds, sections and the filter work across layers. An up pivot
on a share's block shows its holders in both layers.

**What it needs elsewhere.** This is why it is not for now:

- Override and hide rows in your corpus, keyed by share and node. That is
  a schema and sync change.
- A rule for an override when the owner later changes the same text.
- A marker on a row that shows an override, and a way to drop it.
- A share with write still writes to the owner's corpus. The layer is for
  read-only shares, or for edits the reader wants to keep private.
