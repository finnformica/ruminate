import { parseISO } from "date-fns"
import type { Block, BlockDoc } from "../blocks/types"
import { isValidDateString, isValidWeekString, toDateStringUtc, toWeekString } from "../utils/date"
import { fold, projectRows, type LoggedEvent, type LogState } from "./events"
import { buildGraphSnapshot, isNoteType, noteDoc, type GraphSnapshot } from "./graph"
import { emittedNoteTitle } from "./note-identity"
import { keyOf } from "../blocks/view"

/**
 * What a day (or a week) on the calendar shows: the notes written on it, each
 * as its outline with what the day did to it marked block by block
 * (docs/event-sourcing.md). Pure: the log in, the changes out; the block
 * editor draws the result in its read-only mode (`BlockEditor.diff`).
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
 * only the day's — applied on top. What shows is what the day's edits did,
 * whatever else landed around them.
 *
 * ## The marks
 *
 * A note is compared as two outlines, block by block: a block only the
 * after-outline holds was **added**, one only the before-outline holds was
 * **removed** — and is spliced back where it stood, so it draws as a row —
 * and one in both whose text or type differs was **changed**, carrying the
 * words that went and the words that came (`diffWords`). Everything else is
 * unchanged, and drawn as the note's own view draws it — folded where the
 * reader's folds and the depth setting fold it — then cut down to the
 * changes and a row of context on either side (`foldContext`): the rows
 * between fold behind one row that says how many, as a pull request's do,
 * and open a few at a time.
 *
 * ## Before history began
 *
 * The log was seeded from the rows that predate it: one snapshot `create`
 * per row (`batch: "snapshot"`, docs/event-sourcing.md), stamped with the
 * row's last save and no zone. The calendar reads a snapshot as the row
 * written on that day — its last save before the log is the nearest thing
 * to a date it has — so a note's rows show as added on the days they were
 * last saved, and history begins on the earliest. A tombstone's snapshot is
 * skipped: a row that was already gone is not a row the day wrote.
 *
 * A snapshot's `seq` is the row's old one, which says nothing about when the
 * row was saved — a note's row, re-stamped on every save, keeps the seq it
 * was made with. So the log is read in the order snapshots first, by the day
 * they were saved, then every edit by `seq` (`byPlace`): the seeded rows are
 * the beginning of history, whatever seq they hold, and a day's "before" is
 * everything placed ahead of its first event in that order.
 */

/** A word diff's piece: a run of text that both have, or only one of them. */
export interface WordSegment {
  kind: "same" | "added" | "removed"
  text: string
}

/** What the period did to one block of a note's outline. */
export type DiffMark =
  | { kind: "added" }
  | { kind: "removed" }
  | { kind: "changed"; words: WordSegment[] }
  /** A synthetic row standing for `count` unchanged rows above the next
   * change, below the last, or between two (`foldContext`). */
  | { kind: "fold"; count: number; position: FoldPosition }

export type FoldPosition = "above" | "below" | "between"

export interface NoteChange {
  id: string
  /** The note's title after the period's changes (before them, for a
   * deleted note). */
  title: string
  kind: "created" | "edited" | "deleted"
  added: number
  removed: number
  changed: number
  /** The outline to draw: the after-outline with the removed blocks spliced
   * back where they stood. */
  doc: BlockDoc
  marks: Map<string, DiffMark>
}

export interface PeriodChanges {
  /** The period's events, in the writers' zones. */
  events: number
  notes: NoteChange[]
  /** The first day the log knows anything about, in the viewer's zone, or
   * null while it is empty: a day before it is one history cannot answer. */
  earliest: string | null
}

/** One sitting: a run of edits from one device with no long pause in it. */
export interface Sitting {
  /** The writer's clock at the first and last edit, and its zone. */
  at: number
  until: number
  tz: number | null
  device: string
  events: number
  notes: NoteChange[]
}

/** The batch the replica seeds the log with (`planReconcile`). */
const SNAPSHOT_BATCH = "snapshot"
const isSnapshot = (event: LoggedEvent) => event.batch === SNAPSHOT_BATCH
/** A snapshot of a row that was already deleted: not a row the day wrote. */
const isTombstoneSnapshot = (event: LoggedEvent) =>
  isSnapshot(event) && typeof (event.patch as { deleted_at?: unknown }).deleted_at === "number"
/** The snapshot of a note's own row. Its stamp is the note's last save, not
 * a day anything was written: the note is placed at the very beginning of
 * history, so its rows are found on their own days. */
const isNoteSnapshot = (event: LoggedEvent) =>
  isSnapshot(event) &&
  event.entity === "block" &&
  isNoteType(String((event.patch as { type?: unknown }).type))
/** An event the calendar reads as something written: not a view's row, and
 * not a snapshot that stands for no day's writing. */
const isWriting = (event: LoggedEvent) =>
  event.entity !== "view" && !isTombstoneSnapshot(event) && !isNoteSnapshot(event)

/** A pause longer than this ends a sitting (`sittingsIn`). */
const SITTING_GAP_MS = 30 * 60_000

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

/** The order the calendar reads the log in (see the module header): the
 * notes' own snapshots first, then the other snapshots by the day they were
 * saved on, then the edits by seq — seq within each. Snapshots always hold
 * lower seqs than edits, so the fold — which applies by seq — agrees. */
const byPlace =
  (viewerTz: number) =>
  (a: LoggedEvent, b: LoggedEvent): number => {
    const tierA = isNoteSnapshot(a) ? 0 : isSnapshot(a) ? 1 : 2
    const tierB = isNoteSnapshot(b) ? 0 : isSnapshot(b) ? 1 : 2
    if (tierA !== tierB) return tierA - tierB
    if (tierA === 1) {
      const dayA = localDayOf(a, viewerTz)
      const dayB = localDayOf(b, viewerTz)
      if (dayA !== dayB) return dayA < dayB ? -1 : 1
    }
    return a.seq - b.seq
  }

/** Every day (in the viewer's zone, or the writer's where it said) something
 * was written on — what the calendar dots. A view's row is not writing. */
export function daysWithChanges(log: readonly LoggedEvent[], viewerTz: number): Set<string> {
  const days = new Set<string>()
  for (const event of log) if (isWriting(event)) days.add(localDayOf(event, viewerTz))
  return days
}

/** The changes a period's events made (see the module header). */
export function changesIn(
  log: readonly LoggedEvent[],
  periodId: string,
  viewerTz: number,
): PeriodChanges {
  const inPeriod = periodMatcher(periodId)
  const sorted = [...log].sort(byPlace(viewerTz))
  const earliest =
    sorted.length === 0 ? null : sorted.map((event) => localDayOf(event, viewerTz)).sort()[0]
  if (inPeriod === null) return { events: 0, notes: [], earliest }
  const periodEvents = sorted.filter(
    (event) => (!isSnapshot(event) || isWriting(event)) && inPeriod(localDayOf(event, viewerTz)),
  )
  if (periodEvents.length === 0) return { events: 0, notes: [], earliest }
  const notes = changesOf(sorted, periodEvents, byPlace(viewerTz))
  return { events: periodEvents.length, notes, earliest }
}

/**
 * The period's edits as sittings, in order: consecutive events from one
 * device with no pause over `gapMs` between them, each sitting diffed on its
 * own — what it found, against what it left. The day as it happened.
 */
export function sittingsIn(
  log: readonly LoggedEvent[],
  periodId: string,
  viewerTz: number,
  options: { gapMs?: number } = {},
): Sitting[] {
  const inPeriod = periodMatcher(periodId)
  if (inPeriod === null) return []
  const gapMs = options.gapMs ?? SITTING_GAP_MS
  const sorted = [...log].sort(byPlace(viewerTz))
  const periodEvents = sorted.filter(
    (event) => (!isSnapshot(event) || isWriting(event)) && inPeriod(localDayOf(event, viewerTz)),
  )
  // The seeded rows come first (`byPlace`), as the replica's own sittings.
  const runs: LoggedEvent[][] = []
  for (const event of periodEvents) {
    const run = runs.at(-1)
    const last = run?.at(-1)
    if (run && last && deviceOf(last) === deviceOf(event) && event.at - last.at <= gapMs) {
      run.push(event)
    } else {
      runs.push([event])
    }
  }
  return runs.map((run) => ({
    at: run[0].at,
    until: (run.at(-1) as LoggedEvent).at,
    tz: run[0].tz ?? null,
    device: deviceOf(run[0]),
    events: run.length,
    notes: changesOf(sorted, run, byPlace(viewerTz)),
  }))
}

/** The device half of `<device>.<tab>`: two tabs of one browser are one
 * writer for the purposes of a sitting. */
const deviceOf = (event: LoggedEvent) => event.device.split(".")[0]

/**
 * The notes a run of events changed, each as the difference between the
 * fold of everything placed ahead of the run's first event (`byPlace`) and
 * that fold with the run — and only the run — applied on top.
 */
function changesOf(
  sorted: readonly LoggedEvent[],
  run: readonly LoggedEvent[],
  place: (a: LoggedEvent, b: LoggedEvent) => number,
): NoteChange[] {
  const first = run[0]
  const before = sorted.filter((event) => place(event, first) < 0)
  const graphBefore = graphOf(fold(before))
  const graphAfter = graphOf(fold([...before, ...run]))

  const touched = new Set<string>()
  for (const event of run) {
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
    const change = noteChange(graphBefore, graphAfter, id)
    if (change !== null) notes.push(change)
  }
  notes.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return notes
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

// -----------------------------------------------------------------------------
// One note: two outlines → one marked outline
// -----------------------------------------------------------------------------

/**
 * A note's change between two graphs: null when neither holds it, or both
 * hold it unchanged. The doc returned is the after-outline with the removed
 * blocks spliced back where they stood (`spliceRemoved`); `marks` says what
 * each row is.
 */
function noteChange(
  before: GraphSnapshot,
  after: GraphSnapshot,
  noteId: string,
): NoteChange | null {
  const docBefore = noteDoc(noteId, before)
  const docAfter = noteDoc(noteId, after)
  if (docBefore === null && docAfter === null) return null

  const marks = new Map<string, DiffMark>()
  const base: BlockDoc = docAfter ?? { props: docBefore!.props, rootBlockIds: [], blocks: {} }
  for (const [id, block] of Object.entries(base.blocks)) {
    const was = docBefore?.blocks[id]
    if (!was) marks.set(id, { kind: "added" })
    else if (was.text !== block.text || was.type !== block.type) {
      marks.set(id, { kind: "changed", words: diffWords(was.text, block.text) })
    }
  }
  const doc = docBefore ? spliceRemoved(base, docBefore, marks) : base
  const added = countMarks(marks, "added")
  const removed = countMarks(marks, "removed")
  const changed = countMarks(marks, "changed")
  if (added + removed + changed === 0 && docBefore !== null && docAfter !== null) return null

  const node = after.nodes.get(noteId) ?? before.nodes.get(noteId)
  return {
    id: noteId,
    title: node ? (emittedNoteTitle(noteId, node.text) ?? "") : "",
    kind: docBefore === null ? "created" : docAfter === null ? "deleted" : "edited",
    added,
    removed,
    changed,
    doc,
    marks,
  }
}

const countMarks = (marks: ReadonlyMap<string, DiffMark>, kind: DiffMark["kind"]) =>
  [...marks.values()].filter((mark) => mark.kind === kind).length

/**
 * The after-outline with every block only the before-outline holds put back
 * where it stood: after the nearest earlier sibling that is still there, else
 * first under its parent (the root list, or a block the after-outline holds
 * — or one spliced back itself, so a removed subtree comes whole). Each is
 * marked `removed`.
 */
function spliceRemoved(after: BlockDoc, before: BlockDoc, marks: Map<string, DiffMark>): BlockDoc {
  const blocks: Record<string, Block> = { ...after.blocks }
  const lists = new Map<string | null, string[]>()
  lists.set(null, [...after.rootBlockIds])
  const listOf = (parent: string | null): string[] => {
    let list = lists.get(parent)
    if (!list) {
      list = [...(blocks[parent as string]?.children ?? [])]
      lists.set(parent, list)
    }
    return list
  }
  const place = (parent: string | null, siblingsBefore: readonly string[]) => {
    const list = listOf(parent)
    siblingsBefore.forEach((id, index) => {
      if (blocks[id] && list.includes(id)) return
      if (!blocks[id]) {
        const gone = before.blocks[id]
        if (!gone) return
        blocks[id] = { ...gone, children: [] }
        marks.set(id, { kind: "removed" })
      }
      if (list.includes(id)) return
      // After the nearest earlier sibling still in the list, else first.
      let at = 0
      for (let k = index - 1; k >= 0; k -= 1) {
        const found = list.indexOf(siblingsBefore[k])
        if (found !== -1) {
          at = found + 1
          break
        }
      }
      list.splice(at, 0, id)
    })
  }
  place(null, before.rootBlockIds)
  for (const [id, block] of Object.entries(before.blocks)) {
    if (block.children.length === 0) continue
    // A parent the after-outline holds keeps its own children, with the
    // removed ones spliced in; a removed parent takes its old children whole.
    if (!blocks[id]) continue
    place(id, block.children)
  }
  for (const [parent, list] of lists) {
    if (parent === null) continue
    blocks[parent] = { ...blocks[parent], children: list }
  }
  return { ...after, blocks, rootBlockIds: lists.get(null) as string[] }
}

// -----------------------------------------------------------------------------
// The context: what to show around the changes
// -----------------------------------------------------------------------------

/** Rows of context kept on either side of a change before a run folds. */
const FOLD_CONTEXT = 1
/** How many more rows a click on a fold reveals. */
export const FOLD_REVEAL = 3

export interface FoldOptions {
  /** The occurrence keys the reader's folds close (`collapsedKeysOf`): what
   * is beneath one is not shown, so a run that holds one counts it as a row.
   * A row with a change beneath it is never closed (`changedBeneath`). */
  collapsed: ReadonlySet<string>
  /** How many rows each fold has been opened by, by fold id. */
  revealed: ReadonlyMap<string, number>
  context?: number
}

/**
 * The blocks with a change somewhere beneath them — the rows a day's reading
 * holds open whatever the reader's folds say, so nothing the day did is
 * hidden (`components/day-changes.tsx`).
 */
export function changedBeneath(doc: BlockDoc, marks: ReadonlyMap<string, DiffMark>): Set<string> {
  const holds = new Map<string, boolean>()
  const walk = (id: string, path: Set<string>): boolean => {
    const known = holds.get(id)
    if (known !== undefined) return known
    if (path.has(id)) return false
    path.add(id)
    let below = false
    for (const child of doc.blocks[id]?.children ?? []) {
      if (walk(child, path) || marks.has(child)) below = true
    }
    path.delete(id)
    holds.set(id, below)
    return below
  }
  for (const id of doc.rootBlockIds) walk(id, new Set())
  return new Set([...holds].filter(([, below]) => below).map(([id]) => id))
}

/**
 * A note's outline cut down to its changes, the way a pull request shows a
 * file: a changed row, a row of context on either side, and a run of
 * unchanged rows between folded behind one synthetic row (`fold:<parent
 * key|root>:<first id>`) that says how many it stands for — and, once
 * clicked, gives back `revealed` rows from the end nearest the change (both
 * ends, between two). Pure: the doc and marks in, a doc and marks to draw
 * out. The real rows keep their ids and keys, so the reader's folds still
 * apply to them.
 */
export function foldContext(
  doc: BlockDoc,
  marks: ReadonlyMap<string, DiffMark>,
  options: FoldOptions,
): { doc: BlockDoc; marks: Map<string, DiffMark> } {
  const context = options.context ?? FOLD_CONTEXT
  const out = new Map(marks)
  const blocks: Record<string, Block> = { ...doc.blocks }
  const changed = changedBeneath(doc, marks)
  // The rows a hidden run stands for: the run's blocks and what shows
  // beneath each, folds closed where the reader closed them.
  const visibleRows = (id: string, key: string, path: Set<string>): number => {
    if (path.has(id)) return 0
    const block = doc.blocks[id]
    if (!block) return 0
    if (options.collapsed.has(key)) return 1
    path.add(id)
    const n =
      1 +
      block.children.reduce((sum, child) => sum + visibleRows(child, keyOf(key, child), path), 0)
    path.delete(id)
    return n
  }

  const foldList = (list: readonly string[], parentKey: string | null, path: Set<string>) => {
    const interesting = list.map((id) => marks.has(id) || changed.has(id))
    if (!interesting.some(Boolean)) return [...list]
    const keep = interesting.map((_, i) => {
      for (let k = Math.max(0, i - context); k <= Math.min(list.length - 1, i + context); k += 1) {
        if (interesting[k]) return true
      }
      return false
    })

    const result: string[] = []
    const pushFold = (foldId: string, hidden: string[], position: FoldPosition) => {
      const count = hidden.reduce(
        (sum, id) => sum + visibleRows(id, keyOf(parentKey, id), new Set(path)),
        0,
      )
      blocks[foldId] = { id: foldId, type: "text", text: "", children: [] }
      out.set(foldId, { kind: "fold", count, position })
      result.push(foldId)
    }
    let run: string[] = []
    const flush = (position: FoldPosition) => {
      if (run.length === 0) return
      const foldId = `fold:${parentKey ?? "root"}:${run[0]}`
      const opened = Math.min(run.length, options.revealed.get(foldId) ?? 0)
      if (opened >= run.length || run.length < 2) {
        result.push(...run)
      } else if (position === "above") {
        pushFold(foldId, run.slice(0, run.length - opened), position)
        result.push(...run.slice(run.length - opened))
      } else if (position === "below") {
        result.push(...run.slice(0, opened))
        pushFold(foldId, run.slice(opened), position)
      } else {
        const top = Math.ceil(opened / 2)
        const bottom = opened - top
        result.push(...run.slice(0, top))
        pushFold(foldId, run.slice(top, run.length - bottom), position)
        result.push(...run.slice(run.length - bottom))
      }
      run = []
    }
    list.forEach((id, index) => {
      if (keep[index]) {
        flush(run.length === index ? "above" : "between")
        result.push(id)
      } else {
        run.push(id)
      }
    })
    flush("below")
    return result
  }

  const walk = (list: readonly string[], parentKey: string | null, path: Set<string>) => {
    for (const id of list) {
      const block = doc.blocks[id]
      if (!block || path.has(id) || block.children.length === 0) continue
      const key = keyOf(parentKey, id)
      if (options.collapsed.has(key) || !changed.has(id)) continue
      path.add(id)
      walk(block.children, key, path)
      blocks[id] = { ...blocks[id], children: foldList(block.children, key, path) }
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, null, new Set())
  const rootBlockIds = foldList(doc.rootBlockIds, null, new Set())
  return { doc: { ...doc, blocks, rootBlockIds }, marks: out }
}

// -----------------------------------------------------------------------------
// Words
// -----------------------------------------------------------------------------

/**
 * A text split into words, each carrying the space after it, with the
 * punctuation beside a word a token of its own — so "more" still matches
 * "more," and a rewording is marked word by word, not as one long run.
 */
const tokens = (text: string): string[] =>
  text.match(/[\p{L}\p{N}]+\s*|[^\p{L}\p{N}\s]+\s*|\s+/gu) ?? []

/**
 * A word diff of two texts: the longest common subsequence of their tokens,
 * with what is only in `before` removed and what is only in `after` added,
 * adjacent pieces of one kind run together. The unchanged head and tail are
 * peeled off first, so a one-word edit to a long line costs its length.
 */
export function diffWords(before: string, after: string): WordSegment[] {
  const a = tokens(before)
  const b = tokens(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }
  const mid = a.slice(head, a.length - tail)
  const nid = b.slice(head, b.length - tail)
  const table: Uint32Array[] = []
  for (let i = 0; i <= mid.length; i += 1) table.push(new Uint32Array(nid.length + 1))
  for (let i = mid.length - 1; i >= 0; i -= 1) {
    for (let j = nid.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        mid[i] === nid[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: WordSegment[] = []
  const push = (kind: WordSegment["kind"], text: string) => {
    const last = out.at(-1)
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  for (const t of a.slice(0, head)) push("same", t)
  let i = 0
  let j = 0
  while (i < mid.length && j < nid.length) {
    if (mid[i] === nid[j]) {
      push("same", mid[i])
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("removed", mid[i++])
    } else {
      push("added", nid[j++])
    }
  }
  while (i < mid.length) push("removed", mid[i++])
  while (j < nid.length) push("added", nid[j++])
  for (const t of a.slice(a.length - tail)) push("same", t)
  return out
}
