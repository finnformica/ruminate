import { describe, expect, it } from "vitest"
import { changesIn, diffLines, localDayOf, periodMatcher, withContext } from "./day-changes"
import { EVENT_VERSION, linkEntityId, type LoggedEvent } from "./events"

/** Milliseconds for a UTC instant. */
const utc = (iso: string) => Date.parse(iso)

/** A writer of placed events, one zone, a clock to set per event. */
function writer(tz: number | null = 0) {
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
      device: "dev.tab",
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
})

describe("changesIn", () => {
  const day = (hour: string) => utc(`2026-10-09T${hour}:00Z`)
  const nextDay = (hour: string) => utc(`2026-10-10T${hour}:00Z`)

  it("shows a note written on the day as created, with every line added", () => {
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
    })
    expect(changes.notes[0].lines).toEqual([{ kind: "added", text: "- buy bread" }])
    expect(changes.earliest).toBe("2026-10-09")
  })

  it("diffs an edited note between the day's first change and its last, and no further", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "buy bread", "n", "ul"),
      w.link(day("09:01"), "n", "a", "a0"),
      w.block(day("09:02"), "b", "call mum", "n", "ul"),
      w.link(day("09:02"), "n", "b", "a1"),
      // The next day: one line retitled, one removed, one added.
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
    expect(changes.notes[0]).toMatchObject({ kind: "edited", added: 2, removed: 2 })
    expect(changes.notes[0].lines).toEqual([
      { kind: "removed", text: "- buy bread" },
      { kind: "removed", text: "- call mum" },
      { kind: "added", text: "- buy sourdough" },
      { kind: "added", text: "- walk" },
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
    const tokyo = writer(540)
    const friday = writer(60)
    log.push(friday.edit(utc("2026-10-09T21:00:00Z"), "a", "one, Friday"))
    log.push(tokyo.edit(utc("2026-10-09T21:30:00Z"), "a", "one, Saturday in Tokyo"))
    log.push(friday.edit(utc("2026-10-09T22:00:00Z"), "a", "one, Friday night"))
    // Ids collide across writers; give each its own seq order.
    log.forEach((event, index) => Object.assign(event, { id: `e${index}`, seq: index + 1 }))

    const friday9 = changesIn(log, "2026-10-09", 0)
    const lines = friday9.notes[0].lines.map((line) => `${line.kind} ${line.text}`)
    expect(lines).toContain("added one, Friday night")
    expect(lines).not.toContain("added one, Saturday in Tokyo")
    const saturday10 = changesIn(log, "2026-10-10", 0)
    expect(saturday10.notes[0].lines.map((l) => `${l.kind} ${l.text}`)).toEqual([
      "removed one, Friday",
      "added one, Saturday in Tokyo",
    ])
  })

  it("shows a deleted note as deleted, with every line removed, and lists a week's days together", () => {
    const w = writer()
    const log = [
      w.note(day("09:00"), "n", "Plans"),
      w.block(day("09:01"), "a", "one", "n"),
      w.link(day("09:01"), "n", "a", "a0"),
      w.remove(nextDay("09:00"), "a"),
      w.remove(nextDay("09:00"), "n"),
    ]
    const gone = changesIn(log, "2026-10-10", 0)
    expect(gone.notes[0]).toMatchObject({ kind: "deleted", removed: 1, added: 0 })
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
    expect(changes.notes[0].lines).toEqual([
      { kind: "same", text: "parent" },
      { kind: "removed", text: "  child" },
    ])
  })
})

describe("diffLines", () => {
  it("keeps what both have, removes what only the first has, adds what only the second has", () => {
    expect(diffLines(["a", "b", "c"], ["a", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ])
    expect(diffLines([], ["x"])).toEqual([{ kind: "added", text: "x" }])
    expect(diffLines(["x"], [])).toEqual([{ kind: "removed", text: "x" }])
    expect(diffLines(["x"], ["x"])).toEqual([{ kind: "same", text: "x" }])
  })

  it("folds long unchanged stretches, keeping two lines of context", () => {
    const lines = diffLines(
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      ["1", "2", "3", "4", "five", "6", "7", "8", "9"],
    )
    expect(
      withContext(lines).map((line) => (line.kind === "skipped" ? `…${line.count}` : line.text)),
    ).toEqual(["…2", "3", "4", "5", "five", "6", "7", "…2"])
  })
})
