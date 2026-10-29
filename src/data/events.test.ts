import { describe, expect, it } from "vitest"
import {
  EVENT_VERSION,
  MAX_EVENTS_PER_PUT,
  coalesceTyping,
  eventStamp,
  fold,
  foldByStamp,
  historyOf,
  linkEntityId,
  netChanges,
  opsToEvents,
  parseEvent,
  parseEventsPayload,
  planRestore,
  rowsToEvents,
  projectRows,
  stateAt,
  toGraphSnapshot,
  type CurrentRows,
  type EventContext,
  type RuminateEvent,
} from "./events"
import { buildGraphSnapshot, childIdsOf, type GraphSnapshot } from "./graph"
import { decodeHlc, encodeHlc, tickHlc, type Hlc } from "./hlc"
import type { Op } from "./ops"
import { sampleGraph } from "./sample-graph"
import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"

function context(device = "tab", at = 1_000): EventContext {
  let n = 0
  return {
    batch: "b1",
    device,
    at,
    tz: 60,
    cause: "test",
    mintId: () => `evt_${device}_${at}_${(n += 1)}`,
  }
}

/** Number events the way the replica would. */
const sequenced = (events: RuminateEvent[], from = 1): RuminateEvent[] =>
  events.map((event, i) => ({ ...event, seq: from + i }))

const snapshot = buildGraphSnapshot(
  [
    { id: "note", type: "note", text: "N", props: null, updated_at: 1, seq: 1 },
    { id: "a", type: "text", text: "A", props: null, updated_at: 1, seq: 2, notes_id: "note" },
  ],
  [
    {
      source_id: "note",
      destination_id: "a",
      kind: "child",
      sort_key: "a0",
      updated_at: 1,
      seq: 3,
    },
  ],
)

describe("opsToEvents", () => {
  it("folds a block's set ops into its create, and into one update", () => {
    const ops: Op[] = [
      { op: "create", id: "b", type: "text", text: "", props: null, notesId: "note" },
      { op: "setText", id: "b", text: "typed" },
      { op: "link", source: "note", destination: "b", sortKey: "a1" },
      { op: "setText", id: "a", text: "A!" },
      { op: "setType", id: "a", type: "h1" },
    ]
    const events = opsToEvents(snapshot, ops, context())
    expect(events.map((e) => [e.entity, e.action, e.entity_id, e.patch])).toEqual([
      ["block", "create", "b", { type: "text", text: "typed", props: null, notes_id: "note" }],
      ["link", "create", linkEntityId("note", "b"), expect.objectContaining({ sort_key: "a1" })],
      ["block", "update", "a", { text: "A!", type: "h1" }],
    ])
    // What the writer believed it was changing travels with the change.
    expect(events[2].base_seq).toBe(2)
  })

  it("says a reorder is a link update, a move is a delete and a create, and a same-key link is nothing", () => {
    const events = opsToEvents(
      snapshot,
      [
        { op: "link", source: "note", destination: "a", sortKey: "a0" },
        { op: "link", source: "note", destination: "a", sortKey: "a7" },
        { op: "unlink", source: "note", destination: "a" },
        { op: "delete", id: "a" },
      ],
      context(),
    )
    expect(events.map((e) => `${e.entity}.${e.action}`)).toEqual([
      "link.update",
      "link.delete",
      "block.delete",
    ])
  })
})

describe("the fold", () => {
  const ctx = context()
  const created = opsToEvents(
    buildGraphSnapshot([], []),
    [
      { op: "create", id: "x", type: "text", text: "one", props: null, notesId: "note" },
      { op: "link", source: "note", destination: "x", sortKey: "a0" },
    ],
    ctx,
  )
  const edit = (text: string, at: number, device = "tab"): RuminateEvent => ({
    ...context(device, at),
    id: `edit_${at}`,
    v: 1,
    entity: "block",
    entity_id: "x",
    action: "update",
    patch: { text },
  })

  it("is time travel when folded to a prefix, and a history when filtered", () => {
    const log = sequenced([...created, edit("two", 2_000), edit("three", 3_000)])
    expect(fold(log).blocks.get("x")?.fields.text).toBe("three")
    expect(stateAt(log, 3).blocks.get("x")?.fields.text).toBe("two")
    expect(historyOf(log, "block", "x").map((e) => e.seq)).toEqual([1, 3, 4])
  })

  it("never throws: an event it cannot apply is set aside", () => {
    const state = fold(sequenced([edit("orphan", 1)]))
    expect(state.blocks.size).toBe(0)
    expect(state.rejected.map((r) => r.reason)).toEqual(["update-on-missing"])
  })

  it("lets an edit that raced a delete land under the tombstone, for a restore to find", () => {
    const log = sequenced([
      ...created,
      { ...edit("", 5), action: "delete", patch: {} } as RuminateEvent,
      edit("typed on another device", 6, "phone"),
    ])
    const state = fold(log)
    expect(state.blocks.get("x")).toMatchObject({ deleted: true })
    expect(state.blocks.get("x")?.fields.text).toBe("typed on another device")
  })

  it("plans a restore as an event: undelete and revert in one, nothing when already there", () => {
    const log = sequenced([
      ...created,
      edit("kept", 10),
      edit("", 20),
      { ...edit("", 30), id: "del", action: "delete", patch: {} } as RuminateEvent,
    ])
    const states = (events: RuminateEvent[]) => ({ then: stateAt(events, 3), now: fold(events) })
    const restore = planRestore(states(log), "block", "x", 3, context("tab", 40)) as RuminateEvent[]
    expect(restore).toHaveLength(1)
    expect(restore[0]).toMatchObject({ action: "restore", ref_seq: 3, patch: { text: "kept" } })
    const after = fold([...log, ...sequenced(restore, 6)])
    expect(after.blocks.get("x")).toMatchObject({ deleted: false, fields: { text: "kept" } })
    expect(
      planRestore(states([...log, ...sequenced(restore, 6)]), "block", "x", 3, context()),
    ).toEqual([])
    expect(planRestore(states(log), "block", "never", 3, context())).toBeNull()
  })
})

describe("rolling up", () => {
  const typed = (text: string, at: number, device = "tab"): RuminateEvent => ({
    id: `t${at}`,
    batch: `b${at}`,
    device,
    at,
    v: 1,
    base_seq: at === 0 ? 7 : 99,
    entity: "block",
    entity_id: "x",
    action: "update",
    patch: { text },
  })

  it("coalesces a typing run to its last event, keeping what the run began from", () => {
    const run = [typed("h", 0), typed("he", 150), typed("hel", 300)]
    const out = coalesceTyping(run)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: "t300", patch: { text: "hel" }, base_seq: 7 })
  })

  it("ends a run at a pause, at another device, and at anything structural", () => {
    expect(coalesceTyping([typed("a", 0), typed("ab", 60_000)])).toHaveLength(2)
    expect(coalesceTyping([typed("a", 0), typed("ab", 100, "phone")])).toHaveLength(2)
    const retype = { ...typed("", 50), id: "s", patch: { type: "h1" } } as RuminateEvent
    expect(coalesceTyping([typed("a", 0), retype, typed("ab", 100)])).toHaveLength(3)
  })

  it("nets a run to the last value of each field, and tells clearing props from leaving them", () => {
    const [net] = netChanges([
      typed("a", 0),
      { ...typed("", 1), id: "p", patch: { props: null } } as RuminateEvent,
      typed("final", 2),
    ])
    expect(net).toMatchObject({
      set: { text: "final", props: null },
      deleted: null,
      last_event: "t2",
    })
    expect("type" in net.set).toBe(false)
  })
})

describe("the envelope", () => {
  it("carries the writer's zone when the context names one, and nothing when it does not", () => {
    const [withZone] = opsToEvents(snapshot, [{ op: "setText", id: "a", text: "A!" }], context())
    expect(withZone.tz).toBe(60)
    const { tz: _tz, ...bare } = context()
    const [without] = opsToEvents(snapshot, [{ op: "setText", id: "a", text: "A!" }], bare)
    expect("tz" in without).toBe(false)
  })

  it("drops an op on what the snapshot does not hold, as the store always dropped it", () => {
    const events = opsToEvents(
      snapshot,
      [
        { op: "setText", id: "ghost", text: "boo" },
        { op: "delete", id: "ghost" },
        { op: "unlink", source: "note", destination: "ghost" },
      ],
      context(),
    )
    expect(events).toEqual([])
  })
})

describe("the stamp", () => {
  /** A context that stamps as the runtime does: each event ticks the clock. */
  const stamping = (now = 1_000): EventContext => {
    let last: Hlc | null = null
    return {
      ...context("dev.tab", now),
      stamp: () => encodeHlc((last = tickHlc(last, now, "dev.tab"))),
    }
  }

  it("gives each event of a batch its own stamp, rising in the order made", () => {
    const events = opsToEvents(
      snapshot,
      [
        { op: "create", id: "b", type: "text", text: "", props: null, notesId: "note" },
        { op: "link", source: "note", destination: "b", sortKey: "a1" },
        { op: "setText", id: "a", text: "A!" },
      ],
      stamping(),
    )
    const stamps = events.map((e) => e.hlc as string)
    expect(stamps.map(decodeHlc)).toEqual([
      { ms: 1_000, counter: 0, device: "dev.tab" },
      { ms: 1_000, counter: 1, device: "dev.tab" },
      { ms: 1_000, counter: 2, device: "dev.tab" },
    ])
    expect([...stamps].sort()).toEqual(stamps)
  })

  it("leaves an event unstamped when the context mints none", () => {
    const [bare] = opsToEvents(snapshot, [{ op: "setText", id: "a", text: "A!" }], context())
    expect("hlc" in bare).toBe(false)
  })

  it("is the event's own when it has one", () => {
    const [event] = opsToEvents(snapshot, [{ op: "setText", id: "a", text: "A!" }], stamping())
    expect(eventStamp({ ...event, seq: 7 })).toBe(event.hlc)
  })

  it("derives an old event's from its at and its seq, the same on every reader", () => {
    const [old] = sequenced(
      opsToEvents(snapshot, [{ op: "setText", id: "a", text: "A!" }], context("tab", 1_234.9)),
      42,
    )
    // The seq is padded to 15 digits, so seq 10 sorts after seq 9.
    expect(eventStamp(old)).toBe("000000000001234-0000-seq:000000000000042")
    expect(eventStamp({ ...old })).toBe(eventStamp(old))
    // A clock no stamp can hold is clamped, never thrown on: a log is forever.
    expect(decodeHlc(eventStamp({ ...old, at: -5 }))?.ms).toBe(0)
    expect(decodeHlc(eventStamp({ ...old, at: Number.NaN }))?.ms).toBe(0)
  })

  it("does not change what the fold makes: order is still seq", () => {
    const ops: Op[] = [{ op: "setText", id: "a", text: "A!" }]
    const stamped = sequenced(opsToEvents(snapshot, ops, stamping()), 4)
    const bare = sequenced(opsToEvents(snapshot, ops, context()), 4)
    expect(fold(stamped).blocks).toEqual(fold(bare).blocks)
  })
})

describe("parseEvent", () => {
  const good = {
    id: "evt_1",
    entity: "block",
    entity_id: "a",
    action: "update",
    patch: { text: "A" },
    batch: "bat_1",
    device: "dev.tab",
    at: 1_000,
    tz: 60,
    v: EVENT_VERSION,
  }

  it("takes a well-formed event field by field, and leaves `seq` and strangers behind", () => {
    const parsed = parseEvent({ ...good, seq: 99, actor: 7, origin: "mcp", extra: true })
    expect(parsed).toEqual(good)
    expect(parsed && "seq" in parsed).toBe(false)
  })

  it("wants every field on a create, any on an update, none on a delete", () => {
    const create = { ...good, action: "create", patch: { type: "text", text: "A", props: null } }
    expect(parseEvent(create)).toBeNull() // notes_id missing
    expect(parseEvent({ ...create, patch: { ...create.patch, notes_id: null } })).not.toBeNull()
    expect(parseEvent({ ...good, patch: {} })).toBeNull() // an update that changes nothing
    expect(parseEvent({ ...good, action: "delete", patch: {} })).not.toBeNull()
    expect(parseEvent({ ...good, action: "delete", patch: { text: "A" } })).toBeNull()
    expect(parseEvent({ ...good, action: "delete", patch: { deleted_at: 5 } })).not.toBeNull()
    expect(parseEvent({ ...good, patch: { deleted_at: 5 } })).toBeNull() // not on an update
  })

  it("refuses a field of the wrong type, an unknown field, and a key that does not match its link", () => {
    expect(parseEvent({ ...good, patch: { text: 5 } })).toBeNull()
    expect(parseEvent({ ...good, patch: { colour: "red" } })).toBeNull()
    expect(parseEvent({ ...good, entity: "view", patch: { pinned: "yes" } })).toBeNull()
    const link = {
      ...good,
      entity: "link",
      entity_id: linkEntityId("a", "b"),
      action: "create",
      patch: { source_id: "a", destination_id: "b", kind: "child", sort_key: "a0" },
    }
    expect(parseEvent(link)).not.toBeNull()
    expect(parseEvent({ ...link, entity_id: linkEntityId("a", "c") })).toBeNull()
  })

  it("lets a view's create leave out the stack, which came later, and checks it when named", () => {
    const create = {
      ...good,
      entity: "view",
      action: "create",
      patch: { root_id: "n", filter: null, sort: null, pinned: true, sort_key: null },
    }
    expect(parseEvent(create)).not.toBeNull()
    expect(parseEvent({ ...create, patch: { ...create.patch, stack: "a.b" } })).not.toBeNull()
    expect(parseEvent({ ...create, patch: { ...create.patch, stack: 5 } })).toBeNull()
    const { pinned: _, ...unpinned } = create.patch
    expect(parseEvent({ ...create, patch: unpinned })).toBeNull()
    expect(parseEvent({ ...good, entity: "view", patch: { stack: null } })).not.toBeNull()
  })

  it("refuses an envelope it cannot store: a wrong version, a zone no clock has, a restore with no reference", () => {
    expect(parseEvent({ ...good, v: 2 })).toBeNull()
    expect(parseEvent({ ...good, tz: 2_000 })).toBeNull()
    expect(parseEvent({ ...good, tz: null })).not.toBeNull()
    expect(parseEvent({ ...good, at: "yesterday" })).toBeNull()
    expect(parseEvent({ ...good, id: "" })).toBeNull()
    expect(parseEvent({ ...good, action: "restore" })).toBeNull()
    expect(parseEvent({ ...good, action: "restore", ref_seq: 4 })).toMatchObject({ ref_seq: 4 })
    expect(parseEvent({ ...good, action: "restore", ref_seq: null })).not.toBeNull()
    expect(parseEvent({ ...good, base_seq: 1.5 })).toBeNull()
  })

  it("takes a stamp when one is sent, and an event without one as it is", () => {
    const hlc = "000000000001000-0003-dev.tab"
    expect(parseEvent({ ...good, hlc })).toEqual({ ...good, hlc })
    expect(parseEvent({ ...good, hlc: null })).toEqual(good)
    expect(parseEvent({ ...good, hlc: "yesterday" })).toBeNull()
    expect(parseEvent({ ...good, hlc: 1_000 })).toBeNull()
    expect(parseEvent({ ...good, hlc: `000000000001000-0003-${"x".repeat(100)}` })).toBeNull()
  })

  it("a payload is all or nothing, and bounded", () => {
    expect(parseEventsPayload({ events: [good], cursor: "c1" })).toEqual({
      events: [good],
      cursor: "c1",
    })
    expect(parseEventsPayload({ events: [good] })).toEqual({ events: [good] })
    expect(parseEventsPayload({ events: [good, { ...good, v: 0 }] })).toBeNull()
    expect(parseEventsPayload({ events: [good], cursor: 1 })).toBeNull()
    expect(parseEventsPayload({ events: "many" })).toBeNull()
    expect(parseEventsPayload(null)).toBeNull()
    expect(
      parseEventsPayload({ events: Array.from({ length: MAX_EVENTS_PER_PUT + 1 }, () => good) }),
    ).toBeNull()
  })
})

describe("rowsToEvents", () => {
  const held = (rows: {
    nodes?: NodeRow[]
    links?: LinkRow[]
    views?: ViewRow[]
  }): CurrentRows => ({
    nodes: new Map((rows.nodes ?? []).map((row) => [row.id, row])),
    links: new Map(
      (rows.links ?? []).map((row) => [linkEntityId(row.source_id, row.destination_id), row]),
    ),
    views: new Map((rows.views ?? []).map((row) => [row.id, row])),
  })
  const ctx = { batch: "apd", device: "tab", now: 9_000 }
  const a: NodeRow = { id: "a", type: "text", text: "A", props: null, updated_at: 100, seq: 7 }
  const dead: NodeRow = { ...a, deleted_at: 100 }
  const terse = (events: RuminateEvent[]) =>
    events.map((e) => [`${e.entity}.${e.action}`, e.patch, e.at])

  it("a row the replica does not hold is a create — dead on arrival if it arrives dead", () => {
    const events = rowsToEvents(
      held({}),
      {
        nodes: [
          { ...a, notes_id: "note" },
          { ...dead, id: "b" },
        ],
        links: [],
      },
      ctx,
    )
    expect(terse(events)).toEqual([
      ["block.create", { type: "text", text: "A", props: null, notes_id: "note" }, 100],
      [
        "block.create",
        { type: "text", text: "A", props: null, notes_id: null, deleted_at: 100 },
        100,
      ],
    ])
    expect(events.map((e) => e.id)).toEqual(["apd:0", "apd:1"])
  })

  it("last writer wins: a stale row, and a row that changes nothing, are no event at all", () => {
    const current = held({ nodes: [{ ...a, updated_at: 500 }] })
    expect(
      rowsToEvents(current, { nodes: [{ ...a, text: "older", updated_at: 400 }], links: [] }, ctx),
    ).toEqual([])
    expect(rowsToEvents(current, { nodes: [{ ...a, updated_at: 900 }], links: [] }, ctx)).toEqual(
      [],
    )
  })

  it("an update carries only what differs, and what the writer believed it was changing", () => {
    const [event] = rowsToEvents(
      held({ nodes: [a] }),
      { nodes: [{ ...a, text: "A!", updated_at: 200 }], links: [] },
      ctx,
    )
    expect(event).toMatchObject({ action: "update", patch: { text: "A!" }, base_seq: 7, at: 200 })
  })

  it("a delete keeps the last words; a restore sets what differs; an edit under a tombstone stays under it", () => {
    const deleting = rowsToEvents(
      held({ nodes: [a] }),
      { nodes: [{ ...a, text: "last", updated_at: 300, deleted_at: 300 }], links: [] },
      ctx,
    )
    expect(terse(deleting)).toEqual([
      ["block.update", { text: "last" }, 300],
      ["block.delete", { deleted_at: 300 }, 300],
    ])
    const restoring = rowsToEvents(
      held({ nodes: [dead] }),
      { nodes: [{ ...a, text: "back", updated_at: 400 }], links: [] },
      ctx,
    )
    expect(terse(restoring)).toEqual([["block.restore", { text: "back" }, 400]])
    const under = rowsToEvents(
      held({ nodes: [dead] }),
      { nodes: [{ ...dead, text: "edited", updated_at: 400 }], links: [] },
      ctx,
    )
    expect(terse(under)).toEqual([["block.update", { text: "edited" }, 400]])
  })

  it("a row pushed without a note id says nothing about it; one that names it sets it", () => {
    const current = held({ nodes: [{ ...a, notes_id: "note" }] })
    expect(rowsToEvents(current, { nodes: [{ ...a, updated_at: 200 }], links: [] }, ctx)).toEqual(
      [],
    )
    const [event] = rowsToEvents(
      current,
      { nodes: [{ ...a, notes_id: "other", updated_at: 200 }], links: [] },
      ctx,
    )
    expect(event.patch).toEqual({ notes_id: "other" })
  })

  it("orders as the row planner did — delete channels, nodes, views, links — stamping the channels now", () => {
    const link: LinkRow = {
      source_id: "note",
      destination_id: "a",
      kind: "child",
      sort_key: "a0",
      updated_at: 100,
      seq: 8,
    }
    const view: ViewRow = {
      id: "v",
      root_id: "note",
      filter: null,
      sort: null,
      pinned: false,
      sort_key: null,
      updated_at: 100,
    }
    const events = rowsToEvents(
      held({ nodes: [a, { ...a, id: "gone" }], links: [link] }),
      {
        nodes: [{ ...a, text: "A2", updated_at: 200 }],
        links: [{ ...link, sort_key: "a5", updated_at: 200 }],
        views: [{ ...view, pinned: true }],
        deleteNodes: ["gone", "never-held"],
        deleteLinks: [["note", "a", "child"]],
      },
      ctx,
    )
    expect(terse(events)).toEqual([
      ["link.delete", {}, 9_000],
      ["block.delete", {}, 9_000],
      ["block.update", { text: "A2" }, 200],
      [
        "view.create",
        { root_id: "note", filter: null, sort: null, pinned: true, sort_key: null },
        100,
      ],
      ["link.update", { sort_key: "a5" }, 200],
    ])
  })
})

describe("the fold by stamp", () => {
  /** A seeded shuffle (mulberry32), so a failure names its seed. */
  const shuffled = <T>(items: readonly T[], seed: number): T[] => {
    let a = seed >>> 0
    const random = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  const graphOfRows = (log: RuminateEvent[]): GraphSnapshot => {
    const rows = projectRows(fold(log))
    return buildGraphSnapshot(rows.nodes, rows.links)
  }

  /** The sample corpus as the replica would log it, then a day of edits:
   * text, type and props, a reorder, a move out and back (a link revived
   * over its tombstone), a delete, and view changes. In order: each batch's
   * `at` is after the one before. */
  function sampleLog(): RuminateEvent[] {
    const graph = sampleGraph()
    const nodes = [...graph.nodes.values()].map((node) => ({ ...node, updated_at: 1 }))
    const links = [...graph.childLinks.values()].flat().map((link) => ({ ...link, updated_at: 1 }))
    const views: never[] = []
    const empty: CurrentRows = { nodes: new Map(), links: new Map(), views: new Map() }
    let log = sequenced(
      rowsToEvents(empty, { nodes, links, views }, { batch: "seed", device: "replica", now: 1 }),
    )
    const note = [...graph.nodes.values()].find(
      (node) => node.type === "note" && childIdsOf(graph, node.id).length >= 3,
    )!.id
    const [first, second, third] = childIdsOf(graph, note)
    const batches: Op[][] = [
      [{ op: "setText", id: first, text: "edited" }],
      [{ op: "link", source: note, destination: second, sortKey: "zz" }],
      [{ op: "unlink", source: note, destination: first }],
      [{ op: "delete", id: third }],
      [{ op: "link", source: note, destination: first, sortKey: "a0" }],
      [
        { op: "setType", id: second, type: "h1" },
        { op: "setProps", id: note, props: '{"status":"done"}' },
      ],
    ]
    batches.forEach((ops, i) => {
      const events = opsToEvents(graphOfRows(log), ops, context("tab", 100 + i * 10))
      log = [...log, ...sequenced(events, log.length + 1)]
    })
    return log
  }

  it("gives the fold by seq's graph for an in-order log", () => {
    const log = sampleLog()
    const byStamp = foldByStamp(log)
    expect(toGraphSnapshot(byStamp)).toEqual(graphOfRows(log))
  })

  it("gives one state whatever the order, and when every event comes twice", () => {
    const log = sampleLog()
    const want = foldByStamp(log)
    for (let seed = 1; seed <= 20; seed++) {
      expect(foldByStamp(shuffled(log, seed)), `seed ${seed}`).toEqual(want)
      expect(foldByStamp(shuffled([...log, ...log], seed)), `seed ${seed}`).toEqual(want)
    }
  })

  it("continues from a state it built, so a state plus the rest is the state", () => {
    const log = shuffled(sampleLog(), 7)
    const half = Math.floor(log.length / 2)
    expect(foldByStamp(log.slice(half), foldByStamp(log.slice(0, half)))).toEqual(foldByStamp(log))
  })

  const stamped = (
    id: string,
    hlc: string | undefined,
    seq: number,
    action: "create" | "update" | "delete" | "restore",
    patch: object,
  ): RuminateEvent =>
    ({
      id,
      seq,
      ...(hlc === undefined ? {} : { hlc }),
      batch: id,
      device: "tab",
      at: 1,
      v: 1,
      entity: "block",
      entity_id: "x",
      action,
      patch,
    }) as unknown as RuminateEvent
  const hlc = (ms: number, device: string) => encodeHlc({ ms, counter: 0, device })
  const create = stamped("c", hlc(1, "a"), 1, "create", {
    type: "text",
    text: "one",
    props: null,
    notes_id: null,
  })

  it("keeps two devices' changes to two fields of one block, and the higher stamp on one field", () => {
    const log = [
      create,
      stamped("phone-text", hlc(5, "phone"), 2, "update", { text: "from the phone" }),
      stamped("laptop-type", hlc(6, "laptop"), 3, "update", { type: "h1" }),
      stamped("laptop-text", hlc(4, "laptop"), 4, "update", { text: "older" }),
    ]
    for (const order of [log, [...log].reverse()]) {
      expect(toGraphSnapshot(foldByStamp(order)).nodes.get("x")).toMatchObject({
        type: "h1",
        text: "from the phone",
        // The pull cursor: the last event that touched it, as the replica's
        // row has it, though that event's stamp lost.
        seq: 4,
      })
    }
    // The fold by seq is unchanged: the last event in seq order still wins.
    expect(fold(log).blocks.get("x")?.fields.text).toBe("older")
    expect(stateAt(log, 2).blocks.get("x")?.fields.text).toBe("from the phone")
  })

  it("resolves liveness by stamp: a delete wins over an older restore, and an edit lands under it", () => {
    const log = [
      create,
      stamped("del", hlc(8, "phone"), 2, "delete", {}),
      stamped("restore", hlc(7, "laptop"), 3, "restore", { text: "back" }),
      stamped("typed", hlc(9, "laptop"), 4, "update", { text: "typed after" }),
    ]
    const state = foldByStamp([...log].reverse())
    expect(toGraphSnapshot(state).nodes.has("x")).toBe(false)
    expect(state.blocks.get("x")).toMatchObject({
      alive: false,
      deleted_at: 1,
      fields: { text: "typed after" },
    })
  })

  it("holds an event that comes before its create, and reads the block out once the create is in", () => {
    const early = stamped("early", hlc(5, "phone"), 2, "update", { text: "early" })
    expect(toGraphSnapshot(foldByStamp([early])).nodes.size).toBe(0)
    expect(toGraphSnapshot(foldByStamp([early, create])).nodes.get("x")?.text).toBe("early")
  })

  it("derives a stamp for an old event: its `at`, then its `seq`, even past a digit", () => {
    const old = (seq: number, at: number, text: string): RuminateEvent => ({
      ...stamped(`e${seq}`, undefined, seq, "update", { text }),
      at,
    })
    const base = { ...stamped("c", undefined, 1, "create", create.patch), at: 0 }
    const log = [base, old(9, 50, "nine"), old(10, 50, "ten"), old(11, 40, "eleven, older")]
    expect(toGraphSnapshot(foldByStamp([...log].reverse())).nodes.get("x")?.text).toBe("ten")
  })

  it("takes the seq of an event applied again once it is placed, in either order", () => {
    const { seq: _seq, ...unplaced } = create as RuminateEvent & { seq?: number }
    const placed = { ...create, seq: 42 }
    for (const order of [
      [unplaced, placed],
      [placed, unplaced],
    ]) {
      expect(foldByStamp(order as RuminateEvent[]).blocks.get("x")?.seq).toBe(42)
    }
  })
})
