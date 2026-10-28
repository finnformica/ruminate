# Trackers

A **tracker** is a note that keeps a habit or a number day by day, with a
page of its own: a month grid, one card per **series**, each day a cell
filled in the series's colour by how much was logged, and a **Today** strip
above it to log the day in a tap. **New tracker**, under the header's
**New** menu, makes one and opens it at `/trackers/<note id>`; its header is
the note's own ⋯ menu, which adds **Series** (the editor) and **Open note**
(the outline beneath).

Requested by Finn, 2026-10-27. The defaults are his: a month view only, a
streak is days in a row, the week starts on Monday, an entry carries no
note, nothing is imported from a journal, and a day is the viewer's local
date. The grid fits a phone (375 px) with no sideways scroll. The design is
a first cut, to be iterated on.

## One type, and nothing else new in the data

A tracker is a note whose root node is of type `tracker` (`TRACKER_TYPE`,
beside `NOTE_TYPE` and `BOARD_TYPE` in `src/data/graph.ts`). The three are
the note types — `NOTE_TYPES`, and `isNoteType` is the question — so
everywhere a note is listed, counted, ordered, deleted, shared or walked, a
tracker is one; the registry knows the type (`src/blocks/registry.ts`, the
`note` family), so a tracker linked under a block walks as a `tracker` row,
drawn as a note row is with the tracker's icon in the favicon slot. The
note's kind is `tracker` (`NoteType`, derived in `src/data/note-meta.ts`),
which gives it its icon in every list, sends its rows to the tracker page
rather than the outline (`useOpenNote`, `src/hooks/open-note.ts`), lists it
under `type:tracker` in a search, and is what the page checks before it
draws anything (`isTracker`). A note of any other type is refused and
opened as a note.

The type is a note's **default surface**, nothing more: **Make this a
tracker** on a plain note sets the root's type (`useMakeTracker`,
`src/hooks/tracker.ts`, one `setType`) and opens the tracker; **Make this a
note** on a tracker sets it back (`useMakeNote`). Nothing else about the
note changes either way.

Beneath that type, every piece of a tracker is a block the outline already
understands, and the log reads as text in the outline (Finn, 2026-10-28:
"codified as text"). A series's settings are **props keys** of its block —
held per key in the event log (docs/event-sourcing.md, "Per-key events"),
so two devices that change two settings offline both keep their change. An
entry carries no keys at all: its text is the truth. No table is added.

A series's block type is never read: `trackerSeries` reads a series from a
child's props alone (`seriesOf`), so a child of any type is a series the
moment its props carry `kind`. **Add series** writes a bullet block
(`SERIES_TYPE`, `src/data/tracker.ts`, the editor's ordinary bullet list
type, `ul`) so the series name shows as a normal bullet in the note's
outline (Finn, follow-up to #301, 2026-10-28). A series from before that
change, still typed `text`, keeps reading as one — no migration, as there
are no production trackers yet (the same reasoning behind the entry
shape's own transition below).

| on the page | in the graph                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the tracker | a note whose root node is of type `tracker`                                                                                                                                                                                                                                                                                                                                                                           |
| a series    | a direct child of the page whose props carry `kind`: `check` or `number`, whatever the block's type. Its text is its name; the block is its identity. Its settings are its other keys: `colour` (a palette name, below), `unit`, `min`, `max`, `step`, `target`, `period` (`day`, `week` or `month`: what the target is for) and `rollup` (`sum` or `avg`: how a number series adds up). A key not set is the default |
| an entry    | a child of a series, one per day, in date order. Under a check series a to-do block whose text is the day (`YYYY-MM-DD`, the viewer's local day): ticked (`done`) is done, open (`todo`) is not, missing is not. Under a number series a plain block whose text is the day, a separator and the value with its unit (`2026-10-28 · 5 km`); the first number after the day is the value                                |

So a tracker's outline reads, with the series's keys shown as the
outline's props:

```
Habits
  - Read                    kind: check · colour: green · target: 20 · period: month
    [x] 2026-10-26
    [x] 2026-10-27
    [ ] 2026-10-28
  - Run                     kind: number · colour: blue · unit: km · step: 0.5 · target: 15 · period: week
    2026-10-27 · 3 km
    2026-10-28 · 5 km
```

`src/data/tracker.ts` is the one place that reads and writes that shape:
`trackerSeries` reads the series with their entries, leniently (a `kind`
that is not one of the two is not a series; a malformed key falls back to
its default; `entryOf` reads an entry from a block's type and text, a comma
decimal as a point, and a row it cannot read — `Knee felt fine` under Run —
is an ordinary row the grid leaves out). `newTrackerOps`, `addSeriesOps`,
`updateSeriesOps`, `removeSeriesOps` and `setEntryOps` write it. Logging a
day writes one entry per series per day. On a check series a value ticks
the day's to-do, creating it as `done` when the day has none; a clear opens
it again (`todo`), so the row stays in the log. On a number series a value
writes the day's row (`entryText`), creating it when the day has none; a
clear deletes the row (and any duplicate of it — two devices that logged
the same day offline). A new row goes in among the entries in date order
(`entryKey`). `removeSeriesOps` deletes the series with every entry under
it. A row written before 2026-10-28, with `date` and `value` in its props
and no readable text, is still read from those and left as it is; there
are no production trackers, so there is no migration.

The series's keys have a zod schema in the per-block-type validation
(`validateProps`, `src/data/key-events.ts`): a series is a bullet block (or,
from before this change, a text block), so a `ul` or `text` block's `kind`,
`colour`, `period`, `rollup` and `step` are held to their shapes, and the
per-key `set` events are held to the same (`KNOWN_PROP_VALUES`). The replica
refuses a push that breaks them, as PR 1 does for every known key. An entry
has no keys to validate.

## The page

`src/routes/_appRoot.trackers.$.tsx`, with the components in
`src/components/trackers/`:

- **The Today strip** (`today-strip.tsx`): one control per series. A check
  series is a pill that ticks and clears the day; a number series shows its
  value with − and + by its `step`, held within `min` and `max`, and the
  value itself is a field to type into (empty or `0` clears). The controls
  wrap, so on a phone the strip grows down. The strip logs today unless a
  number series's cell was tapped in the grid, which points it at that day,
  named in the heading, with **Today** to come back.
- **The month grid** (`month-grid.tsx`): a card per series, in as many
  columns as fit (one on a phone), each a seven-column grid of the month's
  days from Monday (`monthGrid`), the cell filled in the series's colour at
  one of four steps (`cellLevel`: a check is on or off; a number is scaled
  against `max` when it has one, else against the month's best day). Today
  has a ring; a day after today is faint and not loggable. A tap on a check
  series's cell toggles that day; on a number series's cell it picks the day
  for the strip. Above the grid, the streak (`streak`: days in a row up to
  today, counted from yesterday while today is still open), the month's
  rollup (`rollup`: ticks for a check, the sum or the average of the days
  with a value for a number) and, with a target, a bar of how far towards it
  in the target's period (`targetProgress`: the day, the week from Monday or
  the month).
- **Series** (`series-dialog.tsx`), from the ⋯ menu: one form per series —
  name, kind, colour, target and its period; for a number series unit, how
  it adds up, step, min and max. Every change is written as it is made.
  **Add series** writes a check series named "New series" with its name
  selected. Remove asks first (`ConfirmDialog`, danger): the entries go
  with it. On a phone the list is a sheet.
- The month shown moves with the arrows beside its name; **This month**
  comes back. The page refreshes its idea of today every minute, so a tab
  left open over midnight moves on.

### Colour

A series's `colour` is a palette name the theme has a scale for
(`TRACKER_PALETTE`: amber, blue, cyan, green, orange, purple, red, sand,
violet, yellow — `src/styles/radix-colors.css`), drawn through
`var(--<name>-<step>)` so it follows light and dark. A name the theme has
no scale for reads as the default, green.

## Tests

`src/data/tracker.test.ts` covers the days (local day, Monday start, month
steps), the grid (October 2026, a month that begins on Sunday, a four-row
February), the streak, the rollups, the target's three periods, the cell
levels, the entry text in both shapes and the ops; `src/components/trackers/month-grid.test.tsx` renders
the grid and the strip; `src/data/key-events.test.ts` pins the key
validation. `month-grid.stories.tsx` shows the page at desktop and phone
widths.
