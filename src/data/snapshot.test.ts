// tenant-guard: exempt — these tests read and plant raw snapshot rows on purpose.
import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import {
  eventStamp,
  foldByStamp,
  toGraphSnapshot,
  toViewRows,
  type LoggedEvent,
  type RuminateEvent,
} from "./events"
import { encodeHlc } from "./hlc"
import { docToOps } from "./ops"
import {
  encodeSnapshot,
  parseSnapshot,
  snapshotDue,
  SNAPSHOT_EVERY_EVENTS,
  SNAPSHOT_EVERY_MS,
  SNAPSHOT_ZERO_KEY,
} from "./snapshot"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore, testEventContext } from "./store-test-support"

const DAY = SNAPSHOT_EVERY_MS

/** Event `n` of another device's log, placed at seq n + 1: the first seven
 * create a block each, the rest edit them in turn. */
function pulled(n: number): LoggedEvent {
  const id = `blk_${n % 7}`
  return {
    id: `evt_p_${n}`,
    seq: n + 1,
    hlc: encodeHlc({ ms: 1_000 + n, counter: 0, device: "other.tab" }),
    batch: `bat_${n}`,
    device: "other.tab",
    at: 1_000 + n,
    v: 1,
    entity: "block",
    entity_id: id,
    ...(n < 7
      ? {
          action: "create",
          patch: { type: "paragraph", text: `t${n}`, props: null, notes_id: null },
        }
      : { action: "update", patch: { text: `t${n}` } }),
  } as LoggedEvent
}

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => pulled(from + i))

async function open(start = 100 * DAY) {
  const driver = createNodeSqlDriver()
  const clock = { now: start }
  const store = await openSqlNoteStore(driver, { now: () => clock.now })
  const snapshots = async () =>
    (await driver.exec("SELECT position, taken_at FROM snapshots ORDER BY id")).map((row) => ({
      position: Number(row.position),
      taken_at: Number(row.taken_at),
    }))
  return { driver, store, clock, snapshots }
}

describe("a snapshot", () => {
  it("round-trips the fold by stamp", () => {
    const state = foldByStamp([...range(0, 40), { ...pulled(3), action: "delete", patch: {} }])
    expect(parseSnapshot(encodeSnapshot(state))).toEqual(state)
  })

  it("does not parse when it is bad JSON, another version or the wrong shape", () => {
    const good = JSON.parse(encodeSnapshot(foldByStamp(range(0, 7)))) as {
      blocks: [string, object][]
    }
    expect(parseSnapshot("{")).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...good, v: 2 }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...good, links: {} }))).toBeNull()
    const [id, entity] = good.blocks[0]
    expect(
      parseSnapshot(JSON.stringify({ ...good, blocks: [[id, { ...entity, stamp: 1 }]] })),
    ).toBeNull()
  })

  it("is due at 1,000 events, or at 24 hours with anything new", () => {
    expect(snapshotDue(SNAPSHOT_EVERY_EVENTS - 1, 0, 1)).toBe(false)
    expect(snapshotDue(SNAPSHOT_EVERY_EVENTS, 0, 1)).toBe(true)
    expect(snapshotDue(1, 5, 5 + DAY - 1)).toBe(false)
    expect(snapshotDue(1, 5, 5 + DAY)).toBe(true)
    expect(snapshotDue(0, 5, 5 + 10 * DAY)).toBe(false)
  })
})

describe("the store's snapshots", () => {
  it("writes none for an empty log, and the first with the first event", async () => {
    const { store, snapshots } = await open()
    expect(await snapshots()).toEqual([])
    await store.applyPulledEvents([pulled(0)])
    expect(await snapshots()).toEqual([{ position: 1, taken_at: 100 * DAY }])
  })

  it("writes the next once 1,000 events are past the newest", async () => {
    const { store, snapshots } = await open()
    await store.applyPulledEvents([pulled(0)])
    await store.applyPulledEvents(range(1, SNAPSHOT_EVERY_EVENTS - 1))
    expect(await snapshots()).toHaveLength(1)
    await store.applyPulledEvents([pulled(SNAPSHOT_EVERY_EVENTS)])
    expect((await snapshots()).map((s) => s.position)).toEqual([1, SNAPSHOT_EVERY_EVENTS + 1])
  })

  it("writes the next once the newest is 24 hours old, after a batch or at open", async () => {
    const { driver, store, clock, snapshots } = await open()
    await store.applyPulledEvents([pulled(0)])
    clock.now += DAY - 1
    await store.applyPulledEvents([pulled(1)])
    expect(await snapshots()).toHaveLength(1)
    clock.now += 1
    await store.applyPulledEvents([pulled(2)])
    expect((await snapshots()).map((s) => s.position)).toEqual([1, 3])

    // A quiet day writes nothing; a day with an event writes at the next open.
    clock.now += DAY
    await openSqlNoteStore(driver, { now: () => clock.now })
    expect(await snapshots()).toHaveLength(2)
    await store.applyPulledEvents([pulled(3)])
    clock.now += DAY
    await openSqlNoteStore(driver, { now: () => clock.now })
    expect((await snapshots()).map((s) => s.position)).toEqual([3, 4])
  })

  it("keeps only the 2 newest", async () => {
    const { store, clock, snapshots } = await open()
    for (let n = 0; n < 4; n++) {
      await store.applyPulledEvents([pulled(n)])
      clock.now += DAY
    }
    expect((await snapshots()).map((s) => s.position)).toEqual([3, 4])
  })

  it("folds the newest snapshot that parses, then the tail, to the fold of the whole log", async () => {
    const { driver, store, clock } = await open()
    const log = range(0, 30)
    await store.applyPulledEvents(log.slice(0, 10))
    clock.now += DAY
    await store.applyPulledEvents(log.slice(10, 20))
    await store.applyPulledEvents(log.slice(20))
    const whole = foldByStamp(log)
    expect(await store.loadFold()).toEqual(whole)

    // The newest does not parse: the one before it, and a longer tail.
    await driver.exec("UPDATE snapshots SET state = '{' WHERE id = (SELECT MAX(id) FROM snapshots)")
    expect(await store.loadFold()).toEqual(whole)
    // It really is the one before: plant a block in it, and the fold has it.
    const planted = foldByStamp([
      ...log.slice(0, 10),
      { ...pulled(0), id: "evt_planted", entity_id: "blk_planted" },
    ])
    await driver.exec("UPDATE snapshots SET state = ? WHERE id = (SELECT MIN(id) FROM snapshots)", [
      encodeSnapshot(planted),
    ])
    expect((await store.loadFold()).blocks.has("blk_planted")).toBe(true)

    // None parses, or none is there: the whole log.
    await driver.exec("UPDATE snapshots SET state = 'null'")
    expect(await store.loadFold()).toEqual(whole)
    await driver.exec("DELETE FROM snapshots")
    expect(await store.loadFold()).toEqual(whole)
  })

  it("keeps a keystroke that coalesces away an event the newest snapshot took", async () => {
    const { store, clock, snapshots } = await open()
    let counter = 0
    const stamp = () => encodeHlc({ ms: 5_000, counter: (counter += 1), device: "dev.tab" })
    const ctx = () => testEventContext({ stamp, device: "dev.tab" })
    const doc = { ...parse("- x\n  id:: blk_aaaaaaaaaa\n"), props: null }
    await applyOpsToStore(store, docToOps("a", doc, await store.getGraph()), ctx())
    clock.now += DAY
    const typed = { op: "setText", id: "blk_aaaaaaaaaa" } as const
    await applyOpsToStore(store, [{ ...typed, text: "xy" }], ctx())
    expect(await snapshots()).toHaveLength(2)
    // The run coalesces: "xy", which the snapshot holds, goes; "xyz" lands
    // past the snapshot's position, not in the place of "xy".
    await applyOpsToStore(store, [{ ...typed, text: "xyz" }], ctx())
    expect(await store.unpushedEvents()).toHaveLength(counter - 1)
    expect(toGraphSnapshot(await store.loadFold()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("xyz")
  })

  it("gives an event pushed after the snapshot took it its seq, as the whole log does", async () => {
    const { store, snapshots } = await open()
    let counter = 0
    const stamp = () => encodeHlc({ ms: 5_000, counter: (counter += 1), device: "dev.tab" })
    const ctx = () => testEventContext({ stamp, device: "dev.tab" })
    const doc = { ...parse("- one\n  id:: blk_aaaaaaaaaa\n"), props: null }
    await applyOpsToStore(store, docToOps("a", doc, await store.getGraph()), ctx())
    expect(await snapshots()).toHaveLength(1)
    const queued: RuminateEvent[] = await store.unpushedEvents()
    await store.markEventsPushed(queued.map((event, i) => [event.id, 50 + i] as const))
    await applyOpsToStore(store, [{ op: "setText", id: "blk_aaaaaaaaaa", text: "two" }], ctx())

    // The whole log, without the provisional seq `eventLog` gives a pending event.
    const log = (await store.eventLog()).map(({ pending, ...event }) =>
      pending ? { ...event, seq: undefined } : event,
    )
    const fold = await store.loadFold()
    expect(fold).toEqual(foldByStamp(log))
    expect(fold.blocks.get("a")?.seq).toBeGreaterThanOrEqual(50)
    expect(toGraphSnapshot(fold).nodes.get("blk_aaaaaaaaaa")?.text).toBe("two")
  })
})

describe("snapshot 0", () => {
  /** A store as an older build left it: rows the log does not hold (pulled
   * as rows), an edit that is in the log, a snapshot of that log, and no
   * snapshot 0 flag. Then the open of this build. */
  async function upgraded() {
    const opened = await open()
    const { driver, store, clock } = opened
    await store.applyPull({
      nodes: [
        { id: "a", type: "note", text: "A", props: null, updated_at: 10, seq: 3 },
        { id: "b", type: "paragraph", text: "b", props: null, updated_at: 20, seq: 4 },
        {
          id: "c",
          type: "paragraph",
          text: "c",
          props: null,
          updated_at: 30,
          deleted_at: 30,
          seq: 6,
        },
      ],
      links: [
        {
          source_id: "a",
          destination_id: "b",
          kind: "child",
          sort_key: "a0",
          updated_at: 20,
          seq: 4,
        },
        {
          source_id: "a",
          destination_id: "c",
          kind: "child",
          sort_key: "a1",
          updated_at: 30,
          deleted_at: 30,
          seq: 6,
        },
      ],
      views: [
        {
          id: "vw_a",
          root_id: "a",
          filter: null,
          sort: null,
          pinned: true,
          sort_key: "a0",
          updated_at: 10,
          seq: 5,
        },
      ],
      deleteNodes: [],
      deleteLinks: [],
    })
    await applyOpsToStore(store, [{ op: "setText", id: "b", text: "bee" }], testEventContext())
    expect(await opened.snapshots()).toHaveLength(1)
    await driver.exec("DELETE FROM meta WHERE key = ?", [SNAPSHOT_ZERO_KEY])
    clock.now += 1
    const reopened = await openSqlNoteStore(driver, { now: () => clock.now })
    return { ...opened, store: reopened }
  }

  const newest = async (driver: Awaited<ReturnType<typeof open>>["driver"]) => {
    const [row] = await driver.exec("SELECT state FROM snapshots ORDER BY id DESC LIMIT 1")
    const state = parseSnapshot(String(row.state))
    if (!state) throw new Error("the newest snapshot does not parse")
    return state
  }

  it("equals getGraph() of the tables, every field stamped from its row", async () => {
    const { driver, store, snapshots } = await upgraded()
    // Written beside the snapshot of the log, at the last position.
    expect(await snapshots()).toEqual([
      { position: 1, taken_at: 100 * DAY },
      { position: 1, taken_at: 100 * DAY + 1 },
    ])
    const zero = await newest(driver)
    expect(toGraphSnapshot(zero)).toEqual(await store.getGraph())
    expect(toViewRows(zero)).toEqual((await store.getAllRows()).views)
    expect(toGraphSnapshot(await store.loadFold())).toEqual(await store.getGraph())

    // The stamp an old event at the row's updated_at and seq derives.
    const derived = (at: number, seq?: number) => eventStamp({ at, seq } as RuminateEvent)
    expect(zero.blocks.get("a")?.stamps).toEqual({
      type: derived(10, 3),
      text: derived(10, 3),
      props: derived(10, 3),
      notes_id: derived(10, 3),
      alive: derived(10, 3),
    })
    expect(zero.views.get("vw_a")?.stamps.pinned).toBe(derived(10, 5))
    // A tombstone is held, dead, from its deleted_at.
    expect(zero.blocks.get("c")).toMatchObject({ alive: false, deleted_at: 30, created: true })
  })

  it("runs once, though a snapshot of the log was already there", async () => {
    const { driver, store, clock, snapshots } = await upgraded()
    const flag = await store.getMeta(SNAPSHOT_ZERO_KEY)
    expect(flag).toBe(String(100 * DAY + 1))
    // A row the log does not hold lands, and the next open does not fold it.
    await store.applyPull({
      nodes: [{ id: "d", type: "paragraph", text: "d", props: null, updated_at: 40 }],
      links: [],
      views: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    const before = await snapshots()
    clock.now += 1
    const reopened = await openSqlNoteStore(driver, { now: () => clock.now })
    expect(await snapshots()).toEqual(before)
    expect(await reopened.getMeta(SNAPSHOT_ZERO_KEY)).toBe(flag)
    expect((await newest(driver)).blocks.has("d")).toBe(false)
  })

  it("sets the flag and writes nothing for an empty store", async () => {
    const { store, snapshots } = await open()
    expect(await store.getMeta(SNAPSHOT_ZERO_KEY)).toBe(String(100 * DAY))
    expect(await snapshots()).toEqual([])
  })

  it("is kept by a reload, and the events after it apply", async () => {
    const { driver, store, clock } = await upgraded()
    await applyOpsToStore(store, [{ op: "setText", id: "a", text: "Ay" }], testEventContext())
    clock.now += 1
    const reopened = await openSqlNoteStore(driver, { now: () => clock.now })
    const fold = toGraphSnapshot(await reopened.loadFold())
    expect(fold).toEqual(await reopened.getGraph())
    expect(fold.nodes.get("a")?.text).toBe("Ay")
    expect(fold.nodes.get("b")?.text).toBe("bee")
  })
})
