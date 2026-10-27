import { z } from "zod"
import { blockId } from "../blocks/id"
import type { NoteId } from "../schema"
import {
  TRACKER_TYPE,
  childIdsOf,
  parseProps,
  propsJson,
  sortKeyBetween,
  type GraphSnapshot,
} from "./graph"
import { deleteBlockOps, type Op } from "./ops"

/**
 * Trackers (docs/trackers.md): a note whose root node is of type `tracker`
 * (`TRACKER_TYPE`, src/data/graph.ts), opened on its own page as a month
 * grid of what was logged, with a strip to log today fast.
 *
 * Nothing beneath that type is new in the data. Every value is a props key
 * of an ordinary block, held per key in the event log (docs/event-sourcing.md,
 * "Per-key events"):
 *
 * - A **series** is a direct child of the page whose props carry `kind`
 *   (`check` or `number`). Its text is its name; its other keys are its
 *   settings: `colour` (a palette name, `TRACKER_PALETTE`), `unit`, `min`,
 *   `max`, `step`, `target`, `period` (what the target is for: a day, a
 *   week or the month) and `rollup` (how a number series adds up: `sum` or
 *   `avg`).
 * - An **entry** is a child of a series, one per day, whose props carry
 *   `date` (`YYYY-MM-DD`, the viewer's local day) and `value` (`true` for a
 *   check, a number for a number series). Clearing a day deletes the entry.
 *
 * This module is the one place that reads and writes that shape, and every
 * calculation the page draws — the grid, a streak, a rollup, a target's
 * progress — is a pure function here, with tests beside it.
 */

// -----------------------------------------------------------------------------
// The vocabulary
// -----------------------------------------------------------------------------

/** The palette names the theme has a scale for (src/styles/radix-colors.css):
 * a series's `colour` is one of these, drawn through `var(--<name>-9)`. */
export const TRACKER_PALETTE = [
  "amber",
  "blue",
  "cyan",
  "green",
  "orange",
  "purple",
  "red",
  "sand",
  "violet",
  "yellow",
] as const
export type TrackerColour = (typeof TRACKER_PALETTE)[number]

export const SERIES_KINDS = ["check", "number"] as const
export type SeriesKind = (typeof SERIES_KINDS)[number]

export const SERIES_PERIODS = ["day", "week", "month"] as const
export type SeriesPeriod = (typeof SERIES_PERIODS)[number]

export const SERIES_ROLLUPS = ["sum", "avg"] as const
export type SeriesRollup = (typeof SERIES_ROLLUPS)[number]

/** A local calendar day, `YYYY-MM-DD`. */
export type DayString = string
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** The keys of a series block, each as the app writes it. The per-block-type
 * validation holds a text block's props to these (`validateProps`,
 * src/data/key-events.ts). */
export const trackerSeriesKeys = z.object({
  kind: z.enum(SERIES_KINDS).optional(),
  colour: z.enum(TRACKER_PALETTE).optional(),
  unit: z.string().max(16).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  target: z.number().optional(),
  period: z.enum(SERIES_PERIODS).optional(),
  rollup: z.enum(SERIES_ROLLUPS).optional(),
})

/** The keys of an entry block: the day, and what was logged on it. */
export const trackerEntryKeys = z.object({
  date: z.string().regex(DAY_RE, "a date is YYYY-MM-DD").optional(),
  value: z.union([z.boolean(), z.number()]).optional(),
})

export interface Series {
  /** The series block: its identity. */
  id: string
  /** The block's text. */
  name: string
  kind: SeriesKind
  colour: TrackerColour
  unit: string
  min: number | null
  max: number | null
  /** What one tap of + or − moves a number by. Always positive. */
  step: number
  target: number | null
  period: SeriesPeriod
  rollup: SeriesRollup
}

export interface Entry {
  /** The entry block. */
  id: string
  date: DayString
  value: boolean | number
}

/** A series with its entries, one per day (`entries`), as the page reads it. */
export interface SeriesState {
  series: Series
  entries: ReadonlyMap<DayString, Entry>
}

const DEFAULT_COLOUR: TrackerColour = "green"

// -----------------------------------------------------------------------------
// Reading the graph
// -----------------------------------------------------------------------------

/** Whether the note is a tracker: a note root of type `tracker`. The tracker
 * page refuses any other note, and the writes here write to nothing else. */
export function isTracker(snapshot: GraphSnapshot, trackerId: NoteId): boolean {
  return snapshot.nodes.get(trackerId)?.type === TRACKER_TYPE
}

const numberOr = (value: unknown, fallback: number | null): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

/**
 * The series a block's props declare, or null when they declare none. Read
 * leniently, as a board's features are: `kind` must be one of the two, and
 * every other key falls back when it is missing or malformed — a hand-written
 * block in the outline is still a series rather than content.
 */
export function seriesOf(block: { id: string; text: string; props: string | null }): Series | null {
  const props = parseProps(block.props)
  const kind = props?.kind
  if (kind !== "check" && kind !== "number") return null
  const colour = props?.colour
  const period = props?.period
  const rollup = props?.rollup
  const step = numberOr(props?.step, null)
  return {
    id: block.id,
    name: block.text,
    kind,
    colour: (TRACKER_PALETTE as readonly string[]).includes(colour as string)
      ? (colour as TrackerColour)
      : DEFAULT_COLOUR,
    unit: typeof props?.unit === "string" ? props.unit : "",
    min: numberOr(props?.min, null),
    max: numberOr(props?.max, null),
    step: step !== null && step > 0 ? step : 1,
    target: numberOr(props?.target, null),
    period: (SERIES_PERIODS as readonly string[]).includes(period as string)
      ? (period as SeriesPeriod)
      : "day",
    rollup: rollup === "avg" ? "avg" : "sum",
  }
}

/** The entry a block's props declare, or null: a day, and a boolean or a
 * finite number. */
export function entryOf(block: { id: string; props: string | null }): Entry | null {
  const props = parseProps(block.props)
  const date = props?.date
  const value = props?.value
  if (typeof date !== "string" || !DAY_RE.test(date)) return null
  if (typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value)))
    return null
  return { id: block.id, date, value }
}

/** The entries of a series, by day. Two entries on one day — two devices
 * logging the same day offline — read as the later child, so the grid shows
 * one of them rather than neither; a clear deletes both (`setEntryOps`). */
function seriesEntries(snapshot: GraphSnapshot, seriesId: string): Map<DayString, Entry> {
  const entries = new Map<DayString, Entry>()
  for (const id of childIdsOf(snapshot, seriesId)) {
    const node = snapshot.nodes.get(id)
    if (!node) continue
    const entry = entryOf({ id, props: node.props })
    if (entry) entries.set(entry.date, entry)
  }
  return entries
}

/** The tracker's series in the page's order, each with its entries. Empty
 * for a note that is not a tracker. */
export function trackerSeries(snapshot: GraphSnapshot, trackerId: NoteId): SeriesState[] {
  if (!isTracker(snapshot, trackerId)) return []
  const out: SeriesState[] = []
  for (const id of childIdsOf(snapshot, trackerId)) {
    const node = snapshot.nodes.get(id)
    if (!node) continue
    const series = seriesOf({ id, text: node.text, props: node.props })
    if (series) out.push({ series, entries: seriesEntries(snapshot, id) })
  }
  return out
}

// -----------------------------------------------------------------------------
// Writing the graph
// -----------------------------------------------------------------------------

/** The block type a series or an entry is stored as: a plain row, so the
 * outline draws it as one. */
const ROW_TYPE = "text"

/** What **Add series** writes before it is configured. */
const NEW_SERIES_NAME = "New series"

/** The sort key of a new last child of `parentId`. */
function lastKey(snapshot: GraphSnapshot, parentId: string): string {
  const links = snapshot.childLinks.get(parentId) ?? []
  return sortKeyBetween(links.length > 0 ? links[links.length - 1].sort_key : null, null)
}

/**
 * A tracker made from nothing — **New tracker**: its root node, typed
 * `tracker` and named by `title` (its id when the title is blank, as an
 * untitled note is), stamped as edited now. No series yet: the page's
 * **Series** editor adds them. No view row is written here: whether the
 * tracker is listed is the caller's to say (`LISTED_VIEW`, src/data/views.ts).
 * Nothing when the id is taken.
 */
export function newTrackerOps(snapshot: GraphSnapshot, trackerId: NoteId, title: string): Op[] {
  if (snapshot.nodes.has(trackerId)) return []
  return [
    {
      op: "create",
      id: trackerId,
      type: TRACKER_TYPE,
      text: title.trim() || trackerId,
      props: propsJson({ updated_at: new Date().toISOString() }),
    },
  ]
}

/** What the Series editor may set on a series. A null clears the key. */
export type SeriesPatch = Partial<{
  name: string
  kind: SeriesKind
  colour: TrackerColour
  unit: string | null
  min: number | null
  max: number | null
  step: number | null
  target: number | null
  period: SeriesPeriod | null
  rollup: SeriesRollup | null
}>

/** The props a patch writes over the ones a series block holds: a key set to
 * null goes, a key not named stays. */
function patchedSeriesProps(
  props: Record<string, unknown> | null,
  patch: SeriesPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(props ?? {}) }
  for (const key of [
    "kind",
    "colour",
    "unit",
    "min",
    "max",
    "step",
    "target",
    "period",
    "rollup",
  ]) {
    if (!(key in patch)) continue
    const value = patch[key as keyof SeriesPatch]
    if (value === null || value === undefined || value === "") delete next[key]
    else next[key] = value
  }
  return next
}

/**
 * A series added from the Series editor: a check series in the default
 * colour named "New series", after the tracker's other children. `seriesId`
 * is the caller's, so the editor can open the new row. Nothing for a note
 * that is not a tracker, or an id the graph has.
 */
export function addSeriesOps(
  snapshot: GraphSnapshot,
  trackerId: NoteId,
  seriesId: string,
  patch: SeriesPatch = {},
): Op[] {
  if (!isTracker(snapshot, trackerId) || snapshot.nodes.has(seriesId)) return []
  const props = patchedSeriesProps({ kind: "check", colour: DEFAULT_COLOUR }, patch)
  return [
    {
      op: "create",
      id: seriesId,
      type: ROW_TYPE,
      text: patch.name ?? NEW_SERIES_NAME,
      props: propsJson(props),
      notesId: trackerId,
    },
    { op: "link", source: trackerId, destination: seriesId, sortKey: lastKey(snapshot, trackerId) },
  ]
}

/** A series changed from the Series editor: its name is its text, every
 * other field a key of its props. Nothing when the block is not a series. */
export function updateSeriesOps(
  snapshot: GraphSnapshot,
  seriesId: string,
  patch: SeriesPatch,
): Op[] {
  const node = snapshot.nodes.get(seriesId)
  if (!node || !seriesOf({ id: seriesId, text: node.text, props: node.props })) return []
  const ops: Op[] = []
  if (patch.name !== undefined && patch.name !== node.text) {
    ops.push({ op: "setText", id: seriesId, text: patch.name })
  }
  const before = parseProps(node.props)
  const after = patchedSeriesProps(before, patch)
  if (propsJson(after) !== propsJson(before ?? {})) {
    ops.push({ op: "setProps", id: seriesId, props: propsJson(after) })
  }
  return ops
}

/** A series removed from the Series editor: the block and every entry
 * under it (`deleteBlockOps`, which rescues nothing blank). */
export function removeSeriesOps(snapshot: GraphSnapshot, seriesId: string): Op[] {
  const node = snapshot.nodes.get(seriesId)
  if (!node || !seriesOf({ id: seriesId, text: node.text, props: node.props })) return []
  return deleteBlockOps([seriesId, ...childIdsOf(snapshot, seriesId)], snapshot)
}

/**
 * A day logged — the Today strip, or a tap on a cell: one entry per series
 * per day. A value writes the day's entry, creating it under the series when
 * the day has none and setting `value` when it has; `null` clears the day,
 * deleting its entry (and any duplicate of it). A check series takes `true`
 * only — `false` is a clear. Nothing when the block is not a series.
 */
export function setEntryOps(
  snapshot: GraphSnapshot,
  seriesId: string,
  date: DayString,
  value: boolean | number | null,
): Op[] {
  const node = snapshot.nodes.get(seriesId)
  if (!node || !DAY_RE.test(date)) return []
  const series = seriesOf({ id: seriesId, text: node.text, props: node.props })
  if (!series) return []
  const onDay = childIdsOf(snapshot, seriesId).filter((id) => {
    const child = snapshot.nodes.get(id)
    return child ? entryOf({ id, props: child.props })?.date === date : false
  })
  const clears = value === null || value === false
  if (clears) return onDay.length === 0 ? [] : deleteBlockOps(onDay, snapshot)
  const stored = series.kind === "check" ? true : value
  if (typeof stored !== "boolean" && !Number.isFinite(stored)) return []
  if (onDay.length > 0) {
    const [keep, ...extra] = onDay
    const props = parseProps(snapshot.nodes.get(keep)?.props ?? null) ?? {}
    return [
      { op: "setProps", id: keep, props: propsJson({ ...props, date, value: stored }) },
      ...(extra.length > 0 ? deleteBlockOps(extra, snapshot) : []),
    ]
  }
  const trackerId = (snapshot.parentLinks.get(seriesId) ?? []).find((link) =>
    isTracker(snapshot, link.source_id),
  )?.source_id
  const id = blockId()
  return [
    {
      op: "create",
      id,
      type: ROW_TYPE,
      text: "",
      props: propsJson({ date, value: stored }),
      ...(trackerId ? { notesId: trackerId } : {}),
    },
    { op: "link", source: seriesId, destination: id, sortKey: lastKey(snapshot, seriesId) },
  ]
}

// -----------------------------------------------------------------------------
// Days
// -----------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0")

/** The day `at` falls on in the viewer's local time: what "today" means
 * everywhere here (Finn, 2026-10-27). */
export function localDay(at: Date = new Date()): DayString {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/** A day's parts. The arithmetic below runs in UTC on these, so no step
 * crosses a daylight-saving change. */
function partsOf(day: DayString): { year: number; month: number; date: number } {
  const [year, month, date] = day.split("-").map(Number)
  return { year, month, date }
}

const utcOf = (day: DayString): number => {
  const { year, month, date } = partsOf(day)
  return Date.UTC(year, month - 1, date)
}

const dayOfUtc = (ms: number): DayString => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** The day `n` days after `day` (before, when negative). */
export function addDays(day: DayString, n: number): DayString {
  return dayOfUtc(utcOf(day) + n * 86_400_000)
}

/** Whole days from `a` to `b`: positive when `b` is later. */
export function daysBetween(a: DayString, b: DayString): number {
  return Math.round((utcOf(b) - utcOf(a)) / 86_400_000)
}

/** A month: `YYYY-MM`. */
export type MonthString = string

/** The month a day is in. */
export const monthOf = (day: DayString): MonthString => day.slice(0, 7)

/** The month `n` months after `month` (before, when negative). */
export function addMonths(month: MonthString, n: number): MonthString {
  const [year, m] = month.split("-").map(Number)
  const index = year * 12 + (m - 1) + n
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`
}

/** How many days the month has. */
function daysInMonth(month: MonthString): number {
  const [year, m] = month.split("-").map(Number)
  return new Date(Date.UTC(year, m, 0)).getUTCDate()
}

/** Every day of the month, in order. */
export function monthDays(month: MonthString): DayString[] {
  const count = daysInMonth(month)
  const days: DayString[] = []
  for (let d = 1; d <= count; d += 1) days.push(`${month}-${pad2(d)}`)
  return days
}

/** The weekday of a day with Monday first: 0 is Monday, 6 is Sunday. */
export function weekdayFromMonday(day: DayString): number {
  return (new Date(utcOf(day)).getUTCDay() + 6) % 7
}

/** The Monday of the week a day is in. */
export function weekStart(day: DayString): DayString {
  return addDays(day, -weekdayFromMonday(day))
}

/** The weekday headings, Monday first. */
export const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const

/**
 * The month as a grid of weeks, Monday first (Finn, 2026-10-27): each row
 * seven cells, a day or null where the month has not begun or has ended.
 * Four to six rows.
 */
export function monthGrid(month: MonthString): (DayString | null)[][] {
  const days = monthDays(month)
  const lead = weekdayFromMonday(days[0])
  const cells: (DayString | null)[] = [...Array<null>(lead).fill(null), ...days]
  while (cells.length % 7 !== 0) cells.push(null)
  const rows: (DayString | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

/** The locale the labels are spelled in: the app's copy is British, and a
 * fixed locale keeps a label the same in every test environment. */
const LABEL_LOCALE = "en-GB"

/** A month's name for a heading: "October 2026". */
export function monthLabel(month: MonthString, locale: string = LABEL_LOCALE): string {
  const [year, m] = month.split("-").map(Number)
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

/** A day for a heading: "Mon 27 Oct". */
export function dayLabel(day: DayString, locale: string = LABEL_LOCALE): string {
  return new Date(utcOf(day)).toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
}

// -----------------------------------------------------------------------------
// Reading the entries
// -----------------------------------------------------------------------------

/** A day's logged amount: 1 for a check, the number for a number series,
 * 0 when the day has no entry. */
function amountOn(state: SeriesState, day: DayString): number {
  const entry = state.entries.get(day)
  if (!entry) return 0
  return typeof entry.value === "boolean" ? (entry.value ? 1 : 0) : entry.value
}

/**
 * Whether a day counts as done — what a streak is made of. A check is done
 * when it is ticked. A number is done when something was logged above zero;
 * with a daily target, when the day reached it.
 */
export function isDone(state: SeriesState, day: DayString): boolean {
  const entry = state.entries.get(day)
  if (!entry) return false
  const { series } = state
  if (series.kind === "check") return entry.value === true
  const amount = amountOn(state, day)
  if (series.target !== null && series.period === "day") return amount >= series.target
  return amount > 0
}

/**
 * Days in a row (Finn, 2026-10-27): how many consecutive days up to `today`
 * are done. A day not yet logged does not break the run — the streak is
 * counted from yesterday while today is still open — but a day missed
 * before that ends it.
 */
export function streak(state: SeriesState, today: DayString): number {
  let day = isDone(state, today) ? today : addDays(today, -1)
  let count = 0
  while (isDone(state, day)) {
    count += 1
    day = addDays(day, -1)
  }
  return count
}

/**
 * The series over a run of days: a check series counts its ticks; a
 * number series adds its values (`sum`) or averages the days it has a value
 * on (`avg`). Null when nothing in the run was logged.
 */
export function rollup(state: SeriesState, days: readonly DayString[]): number | null {
  const logged = days.filter((day) => state.entries.has(day))
  if (logged.length === 0) return null
  const total = logged.reduce((sum, day) => sum + amountOn(state, day), 0)
  if (state.series.kind === "check") return total
  return state.series.rollup === "avg" ? total / logged.length : total
}

/** The days a target's period covers at `today`: the day, its week from
 * Monday, or its month. */
export function periodDays(period: SeriesPeriod, today: DayString): DayString[] {
  if (period === "day") return [today]
  if (period === "week") {
    const start = weekStart(today)
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }
  return monthDays(monthOf(today))
}

export interface TargetProgress {
  /** What the period has reached so far: 0 when nothing was logged. */
  value: number
  target: number
  period: SeriesPeriod
  /** `value / target`, held to 0..1. */
  ratio: number
  /** The target is met. */
  met: boolean
}

/** How far the series is towards its target in the period `today` falls
 * in. Null for a series with no target. */
export function targetProgress(state: SeriesState, today: DayString): TargetProgress | null {
  const { target, period } = state.series
  if (target === null || target <= 0) return null
  const value = rollup(state, periodDays(period, today)) ?? 0
  return {
    value,
    target,
    period,
    ratio: Math.min(1, Math.max(0, value / target)),
    met: value >= target,
  }
}

/** How many shades a cell can be drawn in, besides empty. */
const CELL_LEVELS = 4

/**
 * How strongly a day's cell is drawn, 0 (nothing logged) to `CELL_LEVELS`.
 * A check is on or off. A number is scaled against the series's `max` when
 * it has one, else against the largest value in `days` (the month shown), so
 * the best day is full and the rest read against it.
 */
export function cellLevel(state: SeriesState, day: DayString, days: readonly DayString[]): number {
  const entry = state.entries.get(day)
  if (!entry) return 0
  if (state.series.kind === "check") return entry.value === true ? CELL_LEVELS : 0
  const amount = amountOn(state, day)
  if (amount <= 0) return 0
  const scale =
    state.series.max !== null && state.series.max > 0
      ? state.series.max
      : Math.max(...days.map((d) => amountOn(state, d)), amount)
  return Math.max(1, Math.min(CELL_LEVELS, Math.ceil((amount / scale) * CELL_LEVELS)))
}

/** A number as the strip and the cards show it: whole when it is, else to
 * one decimal, with the unit after a space when the series has one. */
export function formatAmount(series: Pick<Series, "unit">, value: number): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return series.unit ? `${text} ${series.unit}` : text
}

/** The value one tap of + (or −, negative `direction`) gives a number
 * series from `current`: by `step`, held within `min` and `max`. */
export function stepValue(series: Series, current: number, direction: 1 | -1): number {
  const next = Math.round((current + direction * series.step) * 1e6) / 1e6
  const floor = series.min ?? 0
  const low = Math.max(floor, next)
  return series.max !== null ? Math.min(series.max, low) : low
}
