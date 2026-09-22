import { describe, expect, it } from "vitest"
import {
  coalesceTyping,
  fold,
  historyOf,
  linkEntityId,
  netChanges,
  opsToEvents,
  planRestore,
  rowsToEvents,
  stateAt,
  viewChangeToEvent,
  type CurrentRows,
  type EventContext,
  type RuminateEvent,
} from "./events"
import { buildGraphSnapshot } from "./graph"
import type { Op } from "./ops"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { ViewRow } from "./views"

function context(device = "tab", at = 1_000): EventContext {
  let n = 0
  return { batch: "b1", device, at, cause: "test", mintId: () => `evt_${device}_${at}_${(n += 1)}` }
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
    const restore = planRestore(log, "block", "x", 3, context("tab", 40)) as RuminateEvent[]
    expect(restore).toHaveLength(1)
    expect(restore[0]).toMatchObject({ action: "restore", ref_seq: 3, patch: { text: "kept" } })
    const after = fold([...log, ...sequenced(restore, 6)])
    expect(after.blocks.get("x")).toMatchObject({ deleted: false, fields: { text: "kept" } })
    expect(planRestore([...log, ...sequenced(restore, 6)], "block", "x", 3, context())).toEqual([])
    expect(planRestore(log, "block", "never", 3, context())).toBeNull()
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

describe("viewChangeToEvent", () => {
  const view: ViewRow = {
    id: "v",
    root_id: "note",
    filter: null,
    sort: null,
    pinned: false,
    sort_key: null,
    updated_at: 1,
    seq: 4,
  }
  it("names the four things that can happen to a view", () => {
    const ctx = context()
    expect(viewChangeToEvent(undefined, view, ctx)?.action).toBe("create")
    expect(viewChangeToEvent(view, { ...view, pinned: true }, ctx)).toMatchObject({
      action: "update",
      patch: { pinned: true },
      base_seq: 4,
    })
    expect(viewChangeToEvent(view, { ...view, deleted_at: 9 }, ctx)?.action).toBe("delete")
    expect(viewChangeToEvent({ ...view, deleted_at: 9 }, view, ctx)?.action).toBe("restore")
    expect(viewChangeToEvent(view, { ...view }, ctx)).toBeNull()
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
