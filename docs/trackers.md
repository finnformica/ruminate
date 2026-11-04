# Trackers

A **tracker** is a note that keeps a habit or a number day by day, with a
page of its own: a month grid, one card per **series**, each day a cell
filled in the series's colour by how much was logged, and a **Today** strip
above it to log the day in a tap. **New tracker**, under the header's
**New** menu, makes one and opens it at `/trackers/<note id>`; its header is
the note's own ⋯ menu, which adds **Series** (the editor) and **Open note**
(the outline beneath).

Requested by Finn, 2026-10-27. The defaults are his: a month view (a week
and a year, and the journal grid, were added 2026-10-28 and removed
2026-11-02), a
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

A tracker is never a **focused frame**, as a board is not (docs/boards.md).
Every way to focus a tracker row (F or ⌘., the block menu, the phone's edit
bar, a crumb, a palette result, a Root row, a link) calls one function,
`useFocusBlock` in `src/hooks/open-note.ts`. It reads the row's kind and
opens the tracker page as a new history entry, so Back returns. A link
opens it in the link's place; in a split the pane keeps the link as a
focus.

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

| on the page | in the graph                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the tracker | a note whose root node is of type `tracker`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| a series    | a direct child of the page whose props carry `kind`: `check` or `number`, whatever the block's type. Its text is its name; the block is its identity. Its settings are its other keys: `colour` (a palette name, below), `unit`, `min`, `max`, `step`, `target`, `period` (`day`, `week` or `month`: what the target is for) `rollup` (`sum` or `avg`: how a number series adds up) and `goal` (`do` or `avoid`: a habit to keep or to keep away from, below). A key not set is the default |
| an entry    | a child of a series, one per day, in date order. Under a check series a to-do block whose text is the day (`YYYY-MM-DD`, the viewer's local day): ticked (`done`) is done, open (`todo`) is not, missing is not. Under a number series a plain block whose text is the day, a separator and the value with its unit (`2026-10-28 · 5 km`); the first number after the day is the value                                                                                                      |

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
the day's to-do, creating it as `done` when the day has none; a clear
deletes the row and its link (Finn, 2026-10-28: an untick leaves no row
behind), so a tick after it makes a new row. A to-do unticked in the note
itself stays as a `todo` row and reads as not done. On a number series a value
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
`colour`, `period`, `rollup`, `goal` and `step` are held to their shapes, and the
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
  wrap, so on a phone the strip grows down. The strip logs today only; a
  past day is logged in the day editor (Finn, 2026-11-03, who asked for no
  shortcut to yesterday: a tap on the day is the one way).
- **The day editor** (`day-dialog.tsx`, Finn 2026-11-03): a tap on a day in
  the heatmap or on a card opens that day, with the strip's controls for
  every series (`DayControls`), so any past value can be added, changed or
  cleared. It writes through the same `setEntry` as the strip: a clear is
  `deleteBlockOps`, as above. Its header steps a day back or on; a day after
  today cannot be opened. A dialog on a desktop, a sheet on a phone.
- **The month grid** (`month-grid.tsx`): a card per series, in as many
  columns as fit (one on a phone), each a seven-column grid of the month's
  days from Monday (`monthGrid`), the cell filled in the series's colour at
  one of four steps (`cellLevel`: a check is on or off; a number is scaled
  against `max` when it has one, else against the month's best day). Today
  has a ring; a day after today is faint and not loggable. A tap on a cell
  opens the day editor on that day (it toggled a check and pointed the strip
  at a number's day until 2026-11-03). Above the grid, the streak (`streak`: days in a row up to
  today, counted from yesterday while today is still open), the month's
  rollup (`rollup`: ticks for a check, the sum or the average of the days
  with a value for a number) and, with a target, a bar of how far towards it
  in the target's period (`targetProgress`: the day, the week from Monday or
  the month). A series to avoid is named **Avoid** beside its name, its
  streak is its clean days in a row, and a slip wears a cross.
- **Series** (`series-dialog.tsx`), from the ⋯ menu: one form per series —
  name, kind, colour, target and its period; for a number series unit, how
  it adds up, step, min and max. Every change is written as it is made.
  **Add series** writes a check series named "New series" with its name
  selected. Remove asks first (`ConfirmDialog`, danger): the entries go
  with it. On a phone the list is a sheet.
- **Display** (Finn, 2026-11-02: "only have heat map and cards"): the
  page shows the activity card (below) and the month as **Cards**. A
  window narrower than `lg` has room for one of the two: it opens on the
  heatmap, and the ⋯ menu's **Display** group picks **Heatmap** or
  **Cards** (`display-groups.tsx`). A wider window shows both, the activity
  card across the page above the cards, with the heatmap two thirds of the
  card and Recent beside it, so the heatmap's cells are large (Finn,
  2026-11-03: "on desktop i think the heat map should be larger"; it was a
  320 px column beside the cards). The heatmap sets the card's height:
  Recent fills it and scrolls within it, with a fade at its foot. When the
  list set the height, a longer list left 33 px under the heatmap's legend,
  not the card's 16 (Finn, 2026-11-03: "too much vertical padding inside
  the Heatmap container"). Its menu has no display options. The week, the year and the journal
  grid (a row per day, a column per series) were removed with their menu
  rows; the range helpers in `src/data/tracker.ts` (`rangeDays`,
  `rangeStart`, `shiftRange`, `rangeLabel`) are still there, used with
  `"month"`. The choice is page state and nothing saves it, so no tracker
  has a removed mode stored: a reload opens on the heatmap.
- **Activity** (`activity.tsx`, Finn 2026-10-29, after a friend's habit
  tracker that reads well on a phone): a day is **active** when any series
  to keep (not one to avoid, below) has something on it (`isLogged`: a ticked check, or a number above zero;
  no target is asked). At the top of the page, the stats row
  (`TrackerStats`, from `activeSummary`; Finn, 2026-11-02, in place of the
  summary line and its streak badge): **Streak** (active days in a row,
  counted from yesterday while today is still open, as a series's streak
  is), **Last 7 days** (`N/7`), **Last 28 days** (`N/28`) and **All time**,
  each window ending on today, each a small label over a bold value. Each
  series to avoid has a group of its own after it, below. Under the Today strip, the activity card: a
  heatmap of the last twelve weeks (`heatmapWeeks`, `HEATMAP_WEEKS`), a
  column a week from Monday with this week at the right edge, a cell is the
  grey tile with a small square in the colour of each series logged that
  day (`seriesOnDay`, `DayDots`), the same design for one series and for
  many (Finn, 2026-11-03: squares, not dots). The marks sit on a fixed grid
  of equal square cells inside a 10 % margin (`DOT_MARGIN`), with a 6 % gap,
  at least 1 px (`DOT_GAP`), and a circular corner of 20 % of each mark's
  short side, in whole device pixels (Finn 2026-11-04: the single square's
  look on every mark): one
  series is one square, 2 to 4 a 2×2, 5 to 9 a 3×3, in reading order
  (`dotGrid`, Finn 2026-11-03: "grow the grid", "prefer using the square
  shape"). No cell is left empty: the nearest mark spans it, the gap
  between too, so the block keeps one shape (`dotCells`, Finn 2026-11-03:
  "empty space should be filled by the closest square"). 2 is two halves,
  one over the other; 3 a half on top and two quarters below; 5 three over
  two full-width rows (Finn, 2026-11-04: option 5a); 6 three over three tall marks; 7 six over a
  full row; 8 seven, the last two cells wide. Past 9, eight squares and a
  grey outline for the rest. A slip on a series to avoid is a plain square: the
  Heatmap has no slip mark (Finn, 2026-11-03). The squares are plain CSS
  layout, with no measure: the tile is a size container, and the squares a
  CSS grid inset by one margin on all four sides (CSS `round()`, lengths
  in `cqw`). Every length is a whole number of device pixels: `--dot-u` is
  one device pixel (1/3 px at 3 dppx, 1/2 px at 2 dppx, set on the grid by
  resolution media queries, `DEVICE_PIXEL_CLASS`), and each day's tile is
  its cell's width rounded down to it, centred in the cell (`dayTileSide`).
  A phone's day is a fraction of a pixel wide (14.37 px at 390); an inset
  rounds as the tile's own edge does, so the margins are equal. Each square
  is the same side, the outer ones on the inset box's edges
  (`space-between`), and the gaps take what is left. In a 3×3 the side
  takes the tile's parity, so what is left is even and the two gaps are
  equal: a 43 px tile (14.37 px at DPR 3) is margins 4, squares 9, gaps 4.
  Today
  with a ring and the rest of this week dashed over a faint grey. A tap on a day up to today opens the day editor on it;
  the grid is one tab stop, and the arrow keys move a day (up, down) or a
  week (left, right). A week that runs into a new month is split into two
  columns (`heatmapColumns`), the other month's days drawn as hollow placeholders, a 0.5 px outline and 0.5 px stripes in one solid colour (`--neutral-6`) under the faint squares (40 %) of the day each holds the place of (Finn, 2026-11-03: so data reads across the divider; not tappable), so a straight line divides the
  months: one element per boundary, in a narrow track of its own with a gap
  each side, from the Monday row down to Sunday. A day is the cards' own
  square (`DaySquare` in `month-grid.tsx`: one radius, a quarter of the
  side at any size, one today ring, one fill and hover), the days to come
  drawn with a dashed outline and the placeholders with stripes, both
  grown with the cell (`cellScale`). On a large grid (`LARGE_GRID`, a
  desktop) the text is at the cards' sizes and the month line is 2 px
  (`HEATMAP_SIZES`, Finn 2026-11-03).
  Each month's short name ("Oct", 11 px; 14 px on a large grid) sits above its divider, its first
  letter over the line, with 4 px under it (6 px on a large grid) before the
  first row of days (Finn, 2026-11-03). A weekday's name takes no height, so each row is
  exactly a cell high and the cells read as squares. Each weekday's row is
  set to the measured cell width, and one gap serves both ways, so the gap
  down is the gap across in any engine (Finn, 2026-11-02); the month the heatmap opens in is named only when
  the heatmap opens on its 1st. Every month when the names fit, else this month and every second or third
  (`fitMonthLabels` in `month-labels.ts`, at the measured column pitch, or
  the narrowest card's before a cell is measured). The day axis names all seven weekdays when a row is tall
  enough for each name, else Mon, Wed and Fri (`axisWeekdays`, from the
  measured cell size), and today's weekday and the current month's name in bold; today has
  no dot under its column (Finn, 2026-11-03). A legend of the series is below it,
  one item a series (no item for a mixed day). The month names and the
  legend's names are trimmed to their capitals and baseline
  (`text-box: trim-both cap alphabetic`), so the card's padding is the space
  seen on all four sides;
  then **Recent**
  (`recentEntries`): the newest entries up to today, a group a day (Finn,
  2026-11-02): the day named once, then a line per series logged on it,
  with the entry's text after the day (`Entry.detail`, read only). A
  divider runs between two days, never inside one. Five days at first and
  ten more for each **Show more**.
- The month shown moves with the arrows beside its name; **This month**
  comes back. The page refreshes its idea of today every minute, so a tab
  left open over midnight moves on.

### Habits to avoid

Finn, 2026-11-03: "i am also tracking a negative activity which needs to be
considered in the stats". A series whose `goal` is `avoid` (**Goal** in
**Series**; `do`, the default, clears the key) is a habit to keep away
from. Its entries are written as any series's are: a logged day is a
**slip**. What changes is how it counts (`cleanSummary`):

- It is left out of the active days, so a slip never lifts the page's
  streak or windows.
- It has its own group in the stats row, named with its dot and **Avoid**
  (the active days' group is then named **Active days**): **Streak** is the
  clean days in a row up to today, today one of them until a slip is logged
  on it; **Last 7 days** and **Last 28 days** count the clean days in each
  window; **All time** counts the clean days from the tracker's first entry
  (`trackingStart`, over every series: a block holds no date of its own, so
  that is where the tracker was first in use). No day before it counts.
- Its card's streak is the clean streak.
- On its card a slip keeps the series's colour and wears a cross
  (`SlipMark`), so it reads as a bad day. In the heatmap it is a plain
  square in the series's colour, with no mark (Finn, 2026-11-03). The other way, filling
  every clean day, was not taken: an avoided habit is clean on most days,
  and its colour on every cell would drown the habits to keep.

A target on a series to avoid still reads as one to reach.

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
levels, the active days (streak, the 7- and 28-day windows, today with no
entry, midnight and daylight-saving edges), the heatmap's weeks, the Recent
order, the entry text in both shapes and the ops; `src/components/trackers/month-grid.test.tsx` renders
the grid and the strip; `src/data/key-events.test.ts` pins the key
validation. `page.stories.tsx` shows the whole page body with sample data
(the stats row, the strip, the activity card and the cards), with a series
to avoid, and `DayEditor` the day editor open on yesterday;
`month-grid.stories.tsx` the cards at desktop and phone widths;
`activity.stories.tsx` the stats row and the activity card;
`activity.test.tsx` the heatmap's tracks, square rows and labels, the
day taps and arrow keys, the squares and their layout, the placeholders' faint squares, the slips, the Recent
groups and the stats with a series to avoid; `day-dialog.test.tsx` the day
editor as a dialog and as a sheet; `display-groups.test.tsx` the ⋯ menu's
Heatmap and Cards rows.
