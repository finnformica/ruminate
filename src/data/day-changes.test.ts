import { describe, expect, it } from "vitest"
import type { BlockDoc } from "../blocks/types"
import {
  changesIn,
  daysWithChanges,
  diffWords,
  localDayOf,
  periodMatcher,
  sittingsIn,
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
  }
}

/** Ids collide across writers; give the whole log one seq order. */
const placed = (log: LoggedEvent[]) =>
  log.map((event, index) => ({ ...event, id: `e${index}`, seq: index + 1 }))

/**
 * A change's outline as the reader sees it: one line per row, in order,
 * indented by depth, each led by its mark — `+`, `−`, `~` (with the word
 * diff), `⋯n` for a fold of n rows, or `=` for an unchanged row.
 */
function rowsOf(change: NoteChange): string[] {
  const out: string[] = []
  const walk = (ids: readonly string[], depth: number) => {
    for (const id of ids) {
      const block = change.doc.blocks[id]
      const mark = change.marks.get(id)
      const pad = "  ".repeat(depth)
      if (mark?.kind === "fold") out.push(`${pad}⋯${mark.count}`)
      else if (mark?.kind === "changed") {
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

  it("reaches a note from a block through its parents, and a loose block through its home", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "parent", "n"),
      w.link(day("09:01"), "n", "a", "a0"),
      w.block(day("09:02"), "b", "child", "n"),
      w.link(day("09:02"), "a", "b", "a0"),
      // Unlinked on the next day: the block is loose, in the note's basket.
      w.unlink(nextDay("09:00"), "a", "b"),
    ]
    const changes = changesIn(log, "2026-10-10", 0)
    expect(changes.notes.map((note) => note.id)).toEqual(["n"])
    expect(rowsOf(changes.notes[0])).toEqual(["= parent", "  − child"])
  })

  it("folds the unchanged runs, a row of context kept beside each change, and opens one on request", () => {
    const w = writer()
    const log = [w.note(day("09:00"), "n", "Plans")]
    for (let i = 1; i <= 9; i += 1) {
      log.push(w.block(day("09:01"), `b${i}`, `row ${i}`, "n"))
      log.push(w.link(day("09:01"), "n", `b${i}`, `a${i}`))
    }
    log.push(w.edit(nextDay("08:00"), "b5", "row five"))

    const folded = changesIn(log, "2026-10-10", 0)
    expect(rowsOf(folded.notes[0])).toEqual([
      "⋯3",
      "= row 4",
      "~ row [-5-]{+five+}",
      "= row 6",
      "⋯3",
    ])
    const foldId = folded.notes[0].doc.rootBlockIds[0]
    expect(foldId).toBe("fold:root:b1")

    const opened = changesIn(log, "2026-10-10", 0, { expanded: new Set([foldId]) })
    expect(rowsOf(opened.notes[0])).toEqual([
      "= row 1",
      "= row 2",
      "= row 3",
      "= row 4",
      "~ row [-5-]{+five+}",
      "= row 6",
      "⋯3",
    ])
    // A fold is a row of the doc the editor can draw, and nothing more.
    const fold: BlockDoc["blocks"][string] = folded.notes[0].doc.blocks[foldId]
    expect(fold).toMatchObject({ id: foldId, type: "text", text: "", children: [] })
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
