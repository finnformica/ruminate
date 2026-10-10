import { parseISO } from "date-fns"
import type { Block, BlockDoc } from "../blocks/types"
import { isValidDateString, isValidWeekString, toDateStringUtc, toWeekString } from "../utils/date"
import { fold, projectRows, type LoggedEvent, type LogState } from "./events"
import { buildGraphSnapshot, isNoteType, noteDoc, type GraphSnapshot } from "./graph"
import { emittedNoteTitle } from "./note-identity"

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
 * unchanged, and a run of unchanged rows is **folded** behind one row that
 * says how many it stands for, a row of context kept on either side of a
 * change (`FOLD_CONTEXT`), the shape a reader knows from a pull request.
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
  /** A synthetic row standing for a run of unchanged rows, `count` of them
   * (descendants included), with the ids it hides. */
  | { kind: "fold"; count: number; hidden: string[] }

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
   * back where they stood and unchanged runs folded. */
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

export interface ChangeOptions {
  /** Fold rows the reader has opened: left unfolded. */
  expanded?: ReadonlySet<string>
}

/** Rows of context kept on either side of a change before a run folds. */
const FOLD_CONTEXT = 1
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

const bySeq = (a: LoggedEvent, b: LoggedEvent) => a.seq - b.seq

/** Every day (in the viewer's zone, or the writer's where it said) something
 * was written on — what the calendar dots. A view's row is not writing. */
export function daysWithChanges(log: readonly LoggedEvent[], viewerTz: number): Set<string> {
  const days = new Set<string>()
  for (const event of log) if (event.entity !== "view") days.add(localDayOf(event, viewerTz))
  return days
}

/** The changes a period's events made (see the module header). */
export function changesIn(
  log: readonly LoggedEvent[],
  periodId: string,
  viewerTz: number,
  options: ChangeOptions = {},
): PeriodChanges {
  const inPeriod = periodMatcher(periodId)
  const sorted = [...log].sort(bySeq)
  const earliest =
    sorted.length === 0 ? null : sorted.map((event) => localDayOf(event, viewerTz)).sort()[0]
  if (inPeriod === null) return { events: 0, notes: [], earliest }
  const periodEvents = sorted.filter((event) => inPeriod(localDayOf(event, viewerTz)))
  if (periodEvents.length === 0) return { events: 0, notes: [], earliest }
  const notes = changesOf(sorted, periodEvents, options)
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
  options: ChangeOptions & { gapMs?: number } = {},
): Sitting[] {
  const inPeriod = periodMatcher(periodId)
  if (inPeriod === null) return []
  const gapMs = options.gapMs ?? SITTING_GAP_MS
  const sorted = [...log].sort(bySeq)
  const periodEvents = sorted.filter((event) => inPeriod(localDayOf(event, viewerTz)))
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
    notes: changesOf(sorted, run, options),
  }))
}

/** The device half of `<device>.<tab>`: two tabs of one browser are one
 * writer for the purposes of a sitting. */
const deviceOf = (event: LoggedEvent) => event.device.split(".")[0]

/**
 * The notes a run of events changed, each as the difference between the
 * fold of everything placed ahead of the run's first event and that fold
 * with the run — and only the run — applied on top.
 */
function changesOf(
  sorted: readonly LoggedEvent[],
  run: readonly LoggedEvent[],
  options: ChangeOptions,
): NoteChange[] {
  const firstSeq = run[0].seq
  const before = sorted.filter((event) => event.seq < firstSeq)
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
    const change = noteChange(graphBefore, graphAfter, id, options)
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
 * blocks spliced back where they stood (`spliceRemoved`) and unchanged runs
 * folded (`foldUnchanged`); `marks` says what each row is.
 */
function noteChange(
  before: GraphSnapshot,
  after: GraphSnapshot,
  noteId: string,
  options: ChangeOptions = {},
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

  const folded = foldUnchanged(doc, marks, options.expanded ?? new Set())
  const node = after.nodes.get(noteId) ?? before.nodes.get(noteId)
  return {
    id: noteId,
    title: node ? (emittedNoteTitle(noteId, node.text) ?? "") : "",
    kind: docBefore === null ? "created" : docAfter === null ? "deleted" : "edited",
    added,
    removed,
    changed,
    doc: folded,
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

/**
 * Fold the unchanged runs of every children list: a block is touched when it
 * or anything beneath it is marked; a run of untouched rows longer than two
 * folds, keeping `FOLD_CONTEXT` rows beside each touched one, into one
 * synthetic row (`fold:<parent>:<index>`) that says how many rows — the run's
 * blocks and their descendants — it stands for. A fold the reader opened
 * (`expanded`) stays open.
 */
function foldUnchanged(
  doc: BlockDoc,
  marks: Map<string, DiffMark>,
  expanded: ReadonlySet<string>,
): BlockDoc {
  const touched = new Map<string, boolean>()
  const isTouched = (id: string, path = new Set<string>()): boolean => {
    const known = touched.get(id)
    if (known !== undefined) return known
    if (path.has(id)) return false
    path.add(id)
    const own = marks.has(id)
    const below = (doc.blocks[id]?.children ?? []).some((child) => isTouched(child, path))
    touched.set(id, own || below)
    return own || below
  }
  const rows = (id: string, path = new Set<string>()): number => {
    if (path.has(id)) return 0
    path.add(id)
    return 1 + (doc.blocks[id]?.children ?? []).reduce((n, child) => n + rows(child, path), 0)
  }
  const blocks: Record<string, Block> = { ...doc.blocks }

  const foldList = (parent: string | null, list: readonly string[]): string[] => {
    if (list.length === 0) return [...list]
    const keep = list.map((id) => isTouched(id))
    if (!keep.some(Boolean)) return [...list]
    for (let i = 0; i < list.length; i += 1) {
      if (!isTouched(list[i])) continue
      for (
        let k = Math.max(0, i - FOLD_CONTEXT);
        k <= Math.min(list.length - 1, i + FOLD_CONTEXT);
        k += 1
      )
        keep[k] = true
    }
    const out: string[] = []
    let run: string[] = []
    const flush = () => {
      if (run.length === 0) return
      const foldId = `fold:${parent ?? "root"}:${run[0]}`
      if (run.length < 2 || expanded.has(foldId)) {
        out.push(...run)
      } else {
        blocks[foldId] = { id: foldId, type: "text", text: "", children: [] }
        marks.set(foldId, {
          kind: "fold",
          count: run.reduce((n, id) => n + rows(id), 0),
          hidden: [...run],
        })
        out.push(foldId)
      }
      run = []
    }
    list.forEach((id, index) => {
      if (keep[index]) {
        flush()
        out.push(id)
      } else {
        run.push(id)
      }
    })
    flush()
    return out
  }

  const rootBlockIds = foldList(null, doc.rootBlockIds)
  for (const [id, block] of Object.entries(doc.blocks)) {
    if (block.children.length === 0 || !isTouched(id)) continue
    blocks[id] = { ...blocks[id], children: foldList(id, block.children) }
  }
  return { ...doc, blocks, rootBlockIds }
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
