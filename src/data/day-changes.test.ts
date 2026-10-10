import { describe, expect, it } from "vitest"
import type { Block, BlockDoc } from "../blocks/types"
import {
  changesIn,
  daysWithChanges,
  diffWords,
  foldContext,
  localDayOf,
  periodMatcher,
  sittingsIn,
  type DiffMark,
  type NoteChange,
} from "./day-changes"
import { EVENT_VERSION, linkEntityId, type LoggedEvent } from "./events"

/** Milliseconds for a UTC instant. */
const utc = (iso: string) => Date.parse(iso)

/** A writer of placed events, one zone and one device, a clock set per event. */
function writer(tz: number | null = 0, device = "dev.tab") {
  let seq = 0
  const make = (
    at: number,
    entity: LoggedEvent["entity"],
    entityId: string,
    action: LoggedEvent["action"],
    patch: object,
  ): LoggedEvent =>
    ({
      id: `evt_${(seq += 1)}`,
      seq,
      batch: `bat_${seq}`,
      device,
      at,
      ...(tz === null ? {} : { tz }),
      v: EVENT_VERSION,
      entity,
      entity_id: entityId,
      action,
      patch,
    }) as LoggedEvent
  return {
    note: (at: number, id: string, title: string) =>
      make(at, "block", id, "create", { type: "note", text: title, props: null, notes_id: null }),
    block: (at: number, id: string, text: string, note: string, type = "text") =>
      make(at, "block", id, "create", { type, text, props: null, notes_id: note }),
    edit: (at: number, id: string, text: string) => make(at, "block", id, "update", { text }),
    remove: (at: number, id: string) => make(at, "block", id, "delete", {}),
    link: (at: number, source: string, destination: string, sortKey: string) =>
      make(at, "link", linkEntityId(source, destination), "create", {
        source_id: source,
        destination_id: destination,
        kind: "child",
        sort_key: sortKey,
      }),
    unlink: (at: number, source: string, destination: string) =>
      make(at, "link", linkEntityId(source, destination), "delete", {}),
    view: (at: number, id: string) =>
      make(at, "view", id, "create", {
        root_id: id,
        filter: null,
        sort: null,
        pinned: true,
        sort_key: null,
      }),
    /** A row the replica seeded the log with (`planReconcile`): stamped with
     * its last save, no zone, batch `snapshot`. */
    snapshot: (at: number, id: string, text: string, note: string | null, deletedAt?: number) => ({
      ...make(at, "block", id, "create", {
        type: note === null ? "note" : "text",
        text,
        props: null,
        notes_id: note,
        ...(deletedAt === undefined ? {} : { deleted_at: deletedAt }),
      }),
      batch: "snapshot",
      device: "replica",
      tz: undefined,
    }),
    snapshotLink: (at: number, source: string, destination: string, sortKey: string) => ({
      ...make(at, "link", linkEntityId(source, destination), "create", {
        source_id: source,
        destination_id: destination,
        kind: "child",
        sort_key: sortKey,
      }),
      batch: "snapshot",
      device: "replica",
      tz: undefined,
    }),
  }
}

/** Ids collide across writers; give the whole log one seq order. */
const placed = (log: LoggedEvent[]) =>
  log.map((event, index) => ({ ...event, id: `e${index}`, seq: index + 1 }))

/**
 * A change's outline as the reader sees it: one line per row, in order,
 * indented by depth, each led by its mark — `+`, `−`, `~` (with the word
 * diff), or `=` for an unchanged row.
 */
function rowsOf(change: NoteChange): string[] {
  const out: string[] = []
  const walk = (ids: readonly string[], depth: number) => {
    for (const id of ids) {
      const block = change.doc.blocks[id]
      const mark = change.marks.get(id)
      const pad = "  ".repeat(depth)
      if (mark?.kind === "changed") {
        const words = mark.words
          .map((w) =>
            w.kind === "same" ? w.text : w.kind === "added" ? `{+${w.text}+}` : `[-${w.text}-]`,
          )
          .join("")
        out.push(`${pad}~ ${words}`)
      } else {
        const sign = mark?.kind === "added" ? "+" : mark?.kind === "removed" ? "−" : "="
        out.push(`${pad}${sign} ${block.text}`)
      }
      walk(block.children, depth + 1)
    }
  }
  walk(change.doc.rootBlockIds, 0)
  return out
}

describe("whose day an event is", () => {
  it("reads the day in the writer's zone when the event names one, else the viewer's", () => {
    const lateInLondon = { at: utc("2026-10-09T22:30:00Z"), tz: 60 } // 23:30 BST, Friday
    expect(localDayOf(lateInLondon, 540)).toBe("2026-10-09")
    // Read from Tokyo the instant is Saturday morning; the day stays Friday's.
    const unsaid = { at: utc("2026-10-09T22:30:00Z"), tz: null }
    expect(localDayOf(unsaid, 540)).toBe("2026-10-10")
    expect(localDayOf(unsaid, -300)).toBe("2026-10-09")
  })

  it("matches a day to itself and to its ISO week, and nothing to an id that is neither", () => {
    expect(periodMatcher("2026-10-09")!("2026-10-09")).toBe(true)
    expect(periodMatcher("2026-10-09")!("2026-10-10")).toBe(false)
    expect(periodMatcher("2026-W41")!("2026-10-05")).toBe(true) // Monday
    expect(periodMatcher("2026-W41")!("2026-10-11")).toBe(true) // Sunday
    expect(periodMatcher("2026-W41")!("2026-10-12")).toBe(false)
    expect(periodMatcher("blk_note0000")).toBeNull()
  })

  it("dots the days something was written on, in the writers' zones, and not a view's row", () => {
    const w = writer(60)
    const log = [
      w.note(utc("2026-10-09T22:30:00Z"), "n", "Plans"),
      w.view(utc("2026-10-11T09:00:00Z"), "n"),
    ]
    expect(daysWithChanges(log, 540)).toEqual(new Set(["2026-10-09"]))
  })
})

describe("changesIn", () => {
  const day = (hour: string) => utc(`2026-10-09T${hour}:00Z`)
  const nextDay = (hour: string) => utc(`2026-10-10T${hour}:00Z`)

  it("shows a note written on the day as created, with every row added", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "buy bread", "n", "ul"),
      w.link(day("09:01"), "n", "a", "a0"),
      w.view(day("09:01"), "n"),
    ]
    const changes = changesIn(log, "2026-10-09", 0)
    expect(changes.events).toBe(4)
    expect(changes.notes).toHaveLength(1)
    expect(changes.notes[0]).toMatchObject({
      id: "n",
      title: "Plans",
      kind: "created",
      added: 1,
      removed: 0,
      changed: 0,
    })
    expect(rowsOf(changes.notes[0])).toEqual(["+ buy bread"])
    expect(changes.earliest).toBe("2026-10-09")
  })

  it("marks the day's rows added, removed or changed, a removed row back where it stood", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "buy bread", "n", "ul"),
      w.link(day("09:01"), "n", "a", "a0"),
      w.block(day("09:02"), "b", "call mum", "n", "ul"),
      w.link(day("09:02"), "n", "b", "a1"),
      // The next day: one row reworded, one removed, one added.
      w.edit(nextDay("08:00"), "a", "buy sourdough"),
      w.unlink(nextDay("08:01"), "n", "b"),
      w.block(nextDay("08:02"), "c", "walk", "n", "ul"),
      w.link(nextDay("08:02"), "n", "c", "a2"),
      // And the day after, which must not show.
      w.edit(utc("2026-10-11T08:00:00Z"), "c", "run"),
    ]
    const changes = changesIn(log, "2026-10-10", 0)
    expect(changes.events).toBe(4)
    expect(changes.notes).toHaveLength(1)
    expect(changes.notes[0]).toMatchObject({ kind: "edited", added: 1, removed: 1, changed: 1 })
    expect(rowsOf(changes.notes[0])).toEqual([
      "~ buy [-bread-]{+sourdough+}",
      "− call mum",
      "+ walk",
    ])
  })

  it("applies only the day's events over what came before, whatever landed between them", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "one", "n"),
      w.link(day("09:01"), "n", "a", "a0"),
    ]
    // A Tokyo device's Saturday-morning edit is placed between two of
    // London's Friday edits: its text is not Friday's.
    const tokyo = writer(540, "tokyo.tab")
    const friday = writer(60, "london.tab")
    log.push(friday.edit(utc("2026-10-09T21:00:00Z"), "a", "one, Friday"))
    log.push(tokyo.edit(utc("2026-10-09T21:30:00Z"), "a", "one, Saturday in Tokyo"))
    log.push(friday.edit(utc("2026-10-09T22:00:00Z"), "a", "one, Friday night"))

    // Friday made the note, so Friday shows it whole, as it left it.
    const friday9 = changesIn(placed(log), "2026-10-09", 0)
    expect(friday9.notes[0].kind).toBe("created")
    expect(rowsOf(friday9.notes[0])).toEqual(["+ one, Friday night"])
    const saturday10 = changesIn(placed(log), "2026-10-10", 0)
    expect(rowsOf(saturday10.notes[0])).toEqual(["~ one, [-Friday-]{+Saturday in Tokyo+}"])
  })

  it("shows a deleted note as deleted, every row removed, and a week's days together", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "one", "n"),
      w.link(day("09:01"), "n", "a", "a0"),
      w.remove(nextDay("09:00"), "a"),
      w.remove(nextDay("09:00"), "n"),
    ]
    const gone = changesIn(log, "2026-10-10", 0)
    expect(gone.notes[0]).toMatchObject({ kind: "deleted", title: "Plans", removed: 1, added: 0 })
    expect(rowsOf(gone.notes[0])).toEqual(["− one"])
    // The week holds both days: a note created and deleted within it has
    // nothing to show, so the week is quiet about it.
    const week = changesIn(log, "2026-W41", 0)
    expect(week.events).toBe(5)
    expect(week.notes).toEqual([])
  })

  it("answers an empty period, and says where history begins", () => {
    const w = writer()
    const log = [w.note(day("09:00"), "n", "Plans")]
    expect(changesIn(log, "2026-10-01", 0)).toEqual({
      events: 0,
      notes: [],
      earliest: "2026-10-09",
    })
    expect(changesIn([], "2026-10-01", 0)).toEqual({ events: 0, notes: [], earliest: null })
  })

  describe("before history began", () => {
    // The replica seeded the log from the rows it held (one snapshot per
    // row, stamped with its last save): a note and a row last saved on the
    // 7th, a row on the 8th, a row deleted on the 8th. Then, on the 9th, a
    // real edit.
    const seeded = () => {
      const w = writer()
      return [
        w.snapshot(utc("2026-10-09T09:00:00Z"), "n", "Plans", null),
        w.snapshot(utc("2026-10-07T10:00:00Z"), "a", "one", "n"),
        w.snapshotLink(utc("2026-10-07T10:00:00Z"), "n", "a", "a0"),
        w.snapshot(utc("2026-10-08T10:00:00Z"), "b", "two", "n"),
        w.snapshotLink(utc("2026-10-08T10:00:00Z"), "n", "b", "a1"),
        w.snapshot(utc("2026-10-08T11:00:00Z"), "gone", "old", "n", utc("2026-10-08T11:00:00Z")),
        w.edit(utc("2026-10-09T12:00:00Z"), "a", "one, edited"),
      ]
    }

    it("shows a seeded row as added on the day it was last saved", () => {
      const seventh = changesIn(seeded(), "2026-10-07", 0)
      expect(seventh.events).toBe(2)
      // The note itself stands at the beginning of history, so its rows are
      // additions to it, not a new note.
      expect(seventh.notes[0]).toMatchObject({ kind: "edited", added: 1 })
      expect(rowsOf(seventh.notes[0])).toEqual(["+ one"])
      // The 7th's row is context on the 8th; the tombstone's snapshot is no
      // row the day wrote; the note's own re-stamp (the 9th) is not a row.
      const eighth = changesIn(seeded(), "2026-10-08", 0)
      expect(eighth.events).toBe(2)
      expect(eighth.notes[0]).toMatchObject({ kind: "edited", added: 1 })
      expect(rowsOf(eighth.notes[0])).toEqual(["= one", "+ two"])
      expect(seventh.earliest).toBe("2026-10-07")
    })

    it("diffs a real edit exactly against the seeded rows, whatever seq they hold", () => {
      // The note's own row was re-stamped last, so its snapshot holds the
      // lowest seq and the latest stamp: the seeded rows are the beginning
      // of history all the same, and the 9th finds the row it edits.
      const ninth = changesIn(seeded(), "2026-10-09", 0)
      expect(ninth.events).toBe(1)
      expect(ninth.notes[0]).toMatchObject({ kind: "edited", changed: 1, added: 0 })
      expect(rowsOf(ninth.notes[0])).toEqual(["~ one{+, edited+}", "= two"])
    })

    it("dots a snapshot's day, but not a tombstone's nor a note's own re-stamp", () => {
      expect([...daysWithChanges(seeded(), 0)].sort()).toEqual([
        "2026-10-07",
        "2026-10-08",
        "2026-10-09",
      ])
      const w = writer()
      const nothingWritten = [
        w.snapshot(utc("2026-10-08T11:00:00Z"), "gone", "old", "n", utc("2026-10-08T11:00:00Z")),
        w.snapshot(utc("2026-10-06T11:00:00Z"), "n", "Plans", null),
      ]
      expect(daysWithChanges(nothingWritten, 0)).toEqual(new Set())
    })

    it("lists the seeded rows as the replica's own sittings, ahead of the day's edits", () => {
      const w = writer()
      const log = [
        w.snapshot(utc("2026-10-09T08:00:00Z"), "n", "Plans", null),
        w.snapshot(utc("2026-10-09T08:00:00Z"), "a", "one", "n"),
        w.snapshotLink(utc("2026-10-09T08:00:00Z"), "n", "a", "a0"),
        w.edit(utc("2026-10-09T12:00:00Z"), "a", "one, edited"),
      ]
      const sittings = sittingsIn(log, "2026-10-09", 0)
      expect(sittings.map((s) => s.device)).toEqual(["replica", "dev"])
      expect(rowsOf(sittings[0].notes[0])).toEqual(["+ one"])
      expect(rowsOf(sittings[1].notes[0])).toEqual(["~ one{+, edited+}"])
    })
  })
})

describe("sittingsIn", () => {
  const at = (iso: string) => utc(iso)

  it("groups a day's edits by device and by pauses, each sitting diffed on its own", () => {
    const laptop = writer(60, "laptop.1")
    const phone = writer(60, "phone.1")
    const log = placed([
      laptop.note(at("2026-10-09T08:00:00Z"), "n", "Plans"),
      laptop.block(at("2026-10-09T08:01:00Z"), "a", "one", "n"),
      laptop.link(at("2026-10-09T08:01:00Z"), "n", "a", "a0"),
      // Another tab of the same laptop, ten minutes on: the same sitting.
      { ...laptop.edit(at("2026-10-09T08:11:00Z"), "a", "one, more"), device: "laptop.2" },
      // The phone, straight after: its own sitting.
      phone.edit(at("2026-10-09T08:12:00Z"), "a", "one, more, on the phone"),
      // The laptop again, after lunch: a new sitting.
      laptop.edit(at("2026-10-09T13:00:00Z"), "a", "one, after lunch"),
    ])
    const sittings = sittingsIn(log, "2026-10-09", 0)
    expect(sittings.map((s) => [s.device, s.events, s.tz])).toEqual([
      ["laptop", 4, 60],
      ["phone", 1, 60],
      ["laptop", 1, 60],
    ])
    expect(sittings[0]).toMatchObject({
      at: at("2026-10-09T08:00:00Z"),
      until: at("2026-10-09T08:11:00Z"),
    })
    expect(rowsOf(sittings[0].notes[0])).toEqual(["+ one, more"])
    expect(rowsOf(sittings[1].notes[0])).toEqual(["~ one, more{+, on the phone+}"])
    expect(rowsOf(sittings[2].notes[0])).toEqual(["~ one, [-more, on the phone-]{+after lunch+}"])
  })

  it("answers nothing for an id that names no period", () => {
    expect(sittingsIn([], "blk_x", 0)).toEqual([])
  })
})

describe("diffWords", () => {
  it("keeps the words both have, removes what only the first has, adds what only the second has", () => {
    expect(diffWords("buy bread and milk", "buy sourdough and oat milk")).toEqual([
      { kind: "same", text: "buy " },
      { kind: "removed", text: "bread " },
      { kind: "added", text: "sourdough " },
      { kind: "same", text: "and " },
      { kind: "added", text: "oat " },
      { kind: "same", text: "milk" },
    ])
    // Punctuation is its own token: a word keeps matching itself when a
    // comma lands beside it.
    expect(diffWords("one, more", "one, more, on the phone")).toEqual([
      { kind: "same", text: "one, more" },
      { kind: "added", text: ", on the phone" },
    ])
    expect(diffWords("", "new")).toEqual([{ kind: "added", text: "new" }])
    expect(diffWords("old", "")).toEqual([{ kind: "removed", text: "old" }])
    expect(diffWords("same", "same")).toEqual([{ kind: "same", text: "same" }])
  })
})

describe("foldContext", () => {
  const block = (id: string, children: string[] = []): Block => ({
    id,
    type: "text",
    text: id,
    children,
  })
  /** Nine rows, the fifth changed; the second has two children, the sixth one. */
  const doc: BlockDoc = {
    props: null,
    rootBlockIds: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"],
    blocks: {
      ...Object.fromEntries(
        ["r1", "r3", "r4", "r5", "r7", "r8", "r9"].map((id) => [id, block(id)]),
      ),
      r2: block("r2", ["c1", "c2"]),
      c1: block("c1"),
      c2: block("c2"),
      r6: block("r6", ["c3"]),
      c3: block("c3"),
    },
  }
  const marks = new Map<string, DiffMark>([["r5", { kind: "changed", words: [] }]])
  const none = new Set<string>()
  /** The rows in order, a fold as `⋯n above|below|between`. */
  const shape = (out: ReturnType<typeof foldContext>) =>
    out.doc.rootBlockIds.map((id) => {
      const mark = out.marks.get(id)
      return mark?.kind === "fold" ? `⋯${mark.count} ${mark.position}` : id
    })

  it("keeps a row of context beside each change and folds the rest, counting what shows", () => {
    const out = foldContext(doc, marks, { collapsed: none, revealed: new Map() })
    // r1..r3 above: r2's two children show too, so five rows; r7..r9 below.
    expect(shape(out)).toEqual(["⋯5 above", "r4", "r5", "r6", "⋯3 below"])
    // A closed fold counts as one row.
    const closed = foldContext(doc, marks, { collapsed: new Set(["r2"]), revealed: new Map() })
    expect(shape(closed)).toEqual(["⋯3 above", "r4", "r5", "r6", "⋯3 below"])
  })

  it("gives back a few rows from the end nearest the change, and dissolves once open", () => {
    const once = foldContext(doc, marks, {
      collapsed: none,
      revealed: new Map([["fold:root:r1", 2]]),
    })
    expect(shape(once)).toEqual(["⋯1 above", "r2", "r3", "r4", "r5", "r6", "⋯3 below"])
    const below = foldContext(doc, marks, {
      collapsed: none,
      revealed: new Map([["fold:root:r7", 3]]),
    })
    expect(shape(below)).toEqual(["⋯5 above", "r4", "r5", "r6", "r7", "r8", "r9"])
  })

  it("folds between two changes from both ends", () => {
    const two = new Map<string, DiffMark>([
      ["r1", { kind: "added" }],
      ["r9", { kind: "added" }],
    ])
    const out = foldContext(doc, two, { collapsed: none, revealed: new Map() })
    expect(shape(out)).toEqual(["r1", "r2", "⋯6 between", "r8", "r9"])
    const opened = foldContext(doc, two, {
      collapsed: none,
      revealed: new Map([["fold:root:r3", 3]]),
    })
    expect(shape(opened)).toEqual(["r1", "r2", "r3", "r4", "⋯3 between", "r7", "r8", "r9"])
  })

  it("marks a closed row that hides a change, and folds inside an open one", () => {
    const deep = new Map<string, DiffMark>([["c2", { kind: "added" }]])
    const closed = foldContext(doc, deep, { collapsed: new Set(["r2"]), revealed: new Map() })
    // r4..r9, with r6's child: seven rows.
    expect(shape(closed)).toEqual(["r1", "r2", "r3", "⋯7 below"])
    expect(closed.marks.get("r2")).toEqual({ kind: "hidden", count: 1 })
    expect(closed.doc.blocks.r2.children).toEqual(["c1", "c2"])

    const open = foldContext(doc, deep, { collapsed: none, revealed: new Map() })
    expect(open.marks.get("r2")).toBeUndefined()
    // c1 is c2's context, so nothing folds inside r2.
    expect(open.doc.blocks.r2.children).toEqual(["c1", "c2"])
  })

  it("leaves a list with nothing beneath it whole", () => {
    const out = foldContext(doc, new Map(), { collapsed: none, revealed: new Map() })
    expect(out.doc).toEqual(doc)
  })
})
