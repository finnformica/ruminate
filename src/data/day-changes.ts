import { parseISO } from "date-fns"
import { serialize } from "../blocks/serialize"
import { isValidDateString, isValidWeekString, toDateStringUtc, toWeekString } from "../utils/date"
import { fold, projectRows, type LoggedEvent, type LogState } from "./events"
import { buildGraphSnapshot, isNoteType, noteDoc, type GraphSnapshot } from "./graph"
import { emittedNoteTitle } from "./note-identity"

/**
 * What a day (or a week) on the calendar shows: the notes written on it, as
 * the difference between how each stood before the day's first change and
 * after its last (docs/event-sourcing.md). Pure: the log in, the changes out.
 *
 * ## Whose day
 *
 * An edit belongs to the day it was for the person making it. Every event
 * carries the writer's clock (`at`) and the writer's UTC offset at the time
 * (`tz`), so its day is read in the writer's own zone — a line typed at 23:30
 * in London is Friday's, and stays Friday's when read from Tokyo, where the
 * same instant is Saturday morning. An event that did not say its zone (one
 * the replica derived from a pushed row) is read in the viewer's. The viewer's
 * zone also draws the calendar itself: "today" is today where the reader is.
 *
 * ## Before and after
 *
 * The day's events need not be a contiguous run of the log: a second device
 * in another zone, or a late push, can place another day's event between two
 * of this one's. So "before" is the fold of everything placed ahead of the
 * day's first event, and "after" is that fold with the day's events — and
 * only the day's — applied on top. What the diff shows is what the day's
 * edits did, whatever else landed around them.
 *
 * ## The lines
 *
 * A note is compared as its outline, the lines its markdown rollup has (the
 * same bytes a copy produces) less the `id::` line under each block, which is
 * plumbing rather than content. The diff is by line, as a reader expects of
 * one: a changed line is the old line removed and the new one added.
 */

export interface DiffLine {
  kind: "same" | "added" | "removed" | "skipped"
  text: string
  /** `skipped` only: how many unchanged lines the row stands for. */
  count?: number
}

export interface NoteChange {
  id: string
  /** The note's title after the day's changes (before them, for a deleted
   * note): what the row is headed by. Date notes carry their id. */
  title: string
  kind: "created" | "edited" | "deleted"
  added: number
  removed: number
  /** The whole outline's diff, unchanged lines included. */
  lines: DiffLine[]
}

export interface PeriodChanges {
  /** The day's (or week's) events, in the writer's zones. */
  events: number
  notes: NoteChange[]
  /** The first day the log knows anything about, in the viewer's zone, or
   * null while it is empty: a day before it is one history cannot answer. */
  earliest: string | null
}

/** The day an event fell on for its writer — in its own zone when it says
 * one, else the viewer's. `YYYY-MM-DD`. */
export function localDayOf(event: Pick<LoggedEvent, "at" | "tz">, viewerTz: number): string {
  const offsetMs = (event.tz ?? viewerTz) * 60_000
  return toDateStringUtc(new Date(event.at + offsetMs))
}

/** Does a day belong to the period a calendar id names — the day itself, or
 * the ISO week? Null for an id that names neither. */
export function periodMatcher(periodId: string): ((day: string) => boolean) | null {
  if (isValidDateString(periodId)) return (day) => day === periodId
  if (isValidWeekString(periodId)) return (day) => toWeekString(parseISO(day)) === periodId
  return null
}

const bySeq = (a: LoggedEvent, b: LoggedEvent) => a.seq - b.seq

/** The changes a period's events made (see the module header). */
export function changesIn(
  log: readonly LoggedEvent[],
  periodId: string,
  viewerTz: number,
): PeriodChanges {
  const inPeriod = periodMatcher(periodId)
  const sorted = [...log].sort(bySeq)
  const earliest =
    sorted.length === 0 ? null : sorted.map((event) => localDayOf(event, viewerTz)).sort()[0]
  if (inPeriod === null) return { events: 0, notes: [], earliest }
  const periodEvents = sorted.filter((event) => inPeriod(localDayOf(event, viewerTz)))
  if (periodEvents.length === 0) return { events: 0, notes: [], earliest }

  const firstSeq = periodEvents[0].seq
  const before = sorted.filter((event) => event.seq < firstSeq)
  const stateBefore = fold(before)
  const stateAfter = fold([...before, ...periodEvents])
  const graphBefore = graphOf(stateBefore)
  const graphAfter = graphOf(stateAfter)

  const touched = new Set<string>()
  for (const event of periodEvents) {
    if (event.entity === "view") continue
    const blocks =
      event.entity === "block" ? [event.entity_id] : event.entity_id.split("|").slice(0, 2)
    for (const id of blocks) {
      for (const note of notesHolding(graphBefore, id)) touched.add(note)
      for (const note of notesHolding(graphAfter, id)) touched.add(note)
    }
  }

  const notes: NoteChange[] = []
  for (const id of touched) {
    const was = outlineLines(graphBefore, id)
    const now = outlineLines(graphAfter, id)
    if (was === null && now === null) continue
    const lines = diffLines(was ?? [], now ?? [])
    const added = lines.filter((line) => line.kind === "added").length
    const removed = lines.filter((line) => line.kind === "removed").length
    if (added === 0 && removed === 0 && was !== null && now !== null) continue
    const node = graphAfter.nodes.get(id) ?? graphBefore.nodes.get(id)
    notes.push({
      id,
      title: node ? (emittedNoteTitle(id, node.text) ?? id) : id,
      kind: was === null ? "created" : now === null ? "deleted" : "edited",
      added,
      removed,
      lines,
    })
  }
  notes.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return { events: periodEvents.length, notes, earliest }
}

/** The live graph a state describes. */
function graphOf(state: LogState): GraphSnapshot {
  const rows = projectRows(state)
  return buildGraphSnapshot(rows.nodes, rows.links)
}

/**
 * The notes a block is in: the block itself when it is a note, else every
 * note reached by walking up its parents — and, for a block nothing holds
 * (one in a note's Unassigned basket), the note it was written in.
 */
function notesHolding(graph: GraphSnapshot, blockId: string): string[] {
  const node = graph.nodes.get(blockId)
  if (!node) return []
  if (isNoteType(node.type)) return [blockId]
  const notes = new Set<string>()
  const seen = new Set<string>([blockId])
  const queue = [blockId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const link of graph.parentLinks.get(id) ?? []) {
      const parent = link.source_id
      if (seen.has(parent)) continue
      seen.add(parent)
      const row = graph.nodes.get(parent)
      if (!row) continue
      if (isNoteType(row.type)) notes.add(parent)
      else queue.push(parent)
    }
  }
  if (notes.size === 0 && node.notes_id && graph.nodes.has(node.notes_id)) notes.add(node.notes_id)
  return [...notes]
}

/** A note's outline as lines — its rollup less the `id::` lines — or null
 * when the graph does not hold the note. */
function outlineLines(graph: GraphSnapshot, noteId: string): string[] | null {
  const doc = noteDoc(noteId, graph)
  if (doc === null) return null
  const lines = serialize(doc)
    .split("\n")
    .filter((line) => !/^\s*id:: \S+$/.test(line))
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/**
 * A line diff: the longest common subsequence of the two, with what is only
 * in `before` removed and what is only in `after` added, in order. The
 * unchanged head and tail are peeled off first, so a one-line edit to a long
 * note costs its length, not its square.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)

  // LCS lengths, bottom-up: `table[i][j]` is the LCS of a[i..] and b[j..].
  const table: Uint32Array[] = []
  for (let i = 0; i <= a.length; i += 1) table.push(new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      middle.push({ kind: "same", text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      middle.push({ kind: "removed", text: a[i] })
      i += 1
    } else {
      middle.push({ kind: "added", text: b[j] })
      j += 1
    }
  }
  while (i < a.length) middle.push({ kind: "removed", text: a[i++] })
  while (j < b.length) middle.push({ kind: "added", text: b[j++] })

  return [
    ...before.slice(0, head).map((text): DiffLine => ({ kind: "same", text })),
    ...middle,
    ...before.slice(before.length - tail).map((text): DiffLine => ({ kind: "same", text })),
  ]
}

/**
 * A diff with its unchanged stretches folded: `context` lines are kept on
 * either side of a change, and a longer run of unchanged lines becomes one
 * `skipped` row saying how many it stands for — the shape a reader knows
 * from a pull request.
 */
export function withContext(lines: readonly DiffLine[], context = 2): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === "same") return
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k += 1
    ) {
      keep[k] = true
    }
  })
  const out: DiffLine[] = []
  let skipped = 0
  const flush = () => {
    if (skipped > 0) out.push({ kind: "skipped", text: "", count: skipped })
    skipped = 0
  }
  lines.forEach((line, index) => {
    if (keep[index]) {
      flush()
      out.push(line)
    } else {
      skipped += 1
    }
  })
  flush()
  return out
}
