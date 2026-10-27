// tenant-guard: exempt — these tests read and plant raw cache rows on purpose.
import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import { parse } from "../blocks/parse"
import { createBlockIndexer, type BlockHit } from "../utils/block-search"
import {
  eventStamp,
  linkEntityId,
  rowsToEvents,
  toGraphSnapshot,
  type LoggedEvent,
  type RowWrite,
  type RuminateEvent,
} from "./events"
import { derivedStamps } from "./fold-cache"
import { assembleStamped, foldKeysByStamp, type KeyEvent, type LoggedKeyEvent } from "./key-events"
import { docToGraph } from "./graph"
import { encodeHlc } from "./hlc"
import { createNotesBuilder } from "./note-meta"
import { docToOps } from "./ops"
import type { SqlDriver, SqlStatement } from "./sql-driver"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { CACHE_STAMPS_KEY, openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore, keyed } from "./store-test-support"

/**
 * The client's tables as a cache of the fold (docs/event-only-sync.md, "The
 * cache"): each batch and each pulled page updates the rows it names, by
 * stamp, in the same transaction as its append; reads are index lookups.
 */

/** A driver that records what it is asked, and can fail the next batch. */
function recording() {
  const inner = createNodeSqlDriver()
  const reads: { sql: string; params: unknown[] }[] = []
  const batches: SqlStatement[][] = []
  let failNext = false
  const driver: SqlDriver = {
    ...inner,
    exec: (sql, params = []) => {
      reads.push({ sql, params })
      return inner.exec(sql, params)
    },
    batch: (statements) => {
      batches.push([...statements])
      if (failNext) {
        failNext = false
        return inner.batch([...statements, { sql: "INSERT INTO no_such_table VALUES (1)" }])
      }
      return inner.batch(statements)
    },
  }
  return {
    driver,
    inner,
    reads,
    batches,
    failNextBatch: () => {
      failNext = true
    },
  }
}

/** The replica's log built from row writes, as the Worker's row door derives
 * it (`rowsToEvents`): what a pull brings, and the whole log to fold. */
function logBuilder() {
  const held = {
    nodes: new Map<string, NodeRow>(),
    links: new Map<string, LinkRow>(),
    views: new Map<string, ViewRow>(),
  }
  const log: LoggedEvent[] = []
  return {
    push(write: RowWrite): LoggedKeyEvent[] {
      const events = rowsToEvents(held, write, {
        batch: `bat_${log.length}`,
        device: "dev.tab",
        now: 0,
      })
      const placed = events.map((event, i) => ({ ...event, seq: log.length + i + 1 }))
      log.push(...placed)
      for (const node of write.nodes) held.nodes.set(node.id, node)
      for (const view of write.views ?? []) held.views.set(view.id, view)
      for (const link of write.links) {
        held.links.set(linkEntityId(link.source_id, link.destination_id, link.kind), link)
      }
      return keyed(placed)
    },
    get log() {
      return keyed(log)
    },
  }
}

/** Event `n` of another device's log, at seq n + 1: the first three create a
 * block each, the rest edit them in turn. Per key, as the pull serves it. */
const pulled = (...ns: number[]): LoggedKeyEvent[] => keyed(ns.map(pulledEvent))
function pulledEvent(n: number): LoggedEvent {
  const id = `blk_${n % 3}`
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
    ...(n < 3
      ? {
          action: "create",
          patch: { type: "paragraph", text: `t${n}`, props: null, notes_id: null },
        }
      : { action: "update", patch: { text: `t${n}` } }),
  } as LoggedEvent
}

const NOTE_A = [
  "- [ ] buy milk",
  "  id:: blk_aaaaaaaaaa",
  "- grocery run",
  "  id:: blk_bbbbbbbbbb",
  "",
].join("\n")

describe("the cache", () => {
  it("is the fold of the log, after local batches and pulled pages", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    const builder = logBuilder()
    await store.applyPulledEvents(builder.push(docToGraph("note-a", NOTE_A, 10)))
    await applyOpsToStore(store, [{ op: "setText", id: "blk_aaaaaaaaaa", text: "buy oat milk" }])

    const log = (await store.eventLog()).map(({ pending, ...event }) =>
      pending ? { ...event, seq: undefined } : event,
    )
    const fold = assembleStamped(foldKeysByStamp(log as KeyEvent[]))
    expect(await store.getGraph()).toEqual(toGraphSnapshot(fold))
    expect(await store.foldOfLog()).toEqual(fold)
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("buy oat milk")
  })

  it("a batch writes exactly the rows it names", async () => {
    const { driver } = recording()
    const store = await openSqlNoteStore(driver)
    await store.applyPulledEvents(pulled(0, 1, 2))
    const rows = async () =>
      new Map(
        (await driver.exec("SELECT id, text, updated_at, seq, stamps FROM nodes")).map((row) => [
          String(row.id),
          JSON.stringify(row),
        ]),
      )
    const before = await rows()

    await store.applyPulledEvents(pulled(3, 6))
    const after = await rows()
    const changed = [...after.keys()].filter((id) => after.get(id) !== before.get(id))
    expect(changed).toEqual(["blk_0"])
    expect((await store.getGraph()).nodes.get("blk_0")?.text).toBe("t6")
  })

  it("gives a row no seq until one of its events is placed", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    const doc = { ...parse("- local\n  id:: blk_aaaaaaaaaa\n"), props: null }
    await applyOpsToStore(store, docToOps("a", doc, await store.getGraph()))
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")).not.toHaveProperty("seq")
    expect((await store.getAllRows()).nodes.every((row) => row.seq === undefined)).toBe(true)
  })

  it("a failed batch rolls back the append and the rows together", async () => {
    const { driver, failNextBatch } = recording()
    const store = await openSqlNoteStore(driver)
    await store.applyPulledEvents(pulled(0))
    const before = { rows: await store.getAllRows(), log: await store.eventLog() }

    failNextBatch()
    await expect(store.applyPulledEvents(pulled(3))).rejects.toThrow()
    expect(await store.getAllRows()).toEqual(before.rows)
    expect(await store.eventLog()).toEqual(before.log)
  })

  it("a page out of order gives the same rows, and an event sent again changes nothing", async () => {
    const events = pulled(...Array.from({ length: 12 }, (_, n) => n))
    const inOrder = await openSqlNoteStore(createNodeSqlDriver())
    await inOrder.applyPulledEvents(events)
    const shuffled = await openSqlNoteStore(createNodeSqlDriver())
    await shuffled.applyPulledEvents([...events].reverse().slice(0, 6))
    await shuffled.applyPulledEvents([...events].reverse().slice(6))
    const nodes = async (store: typeof inOrder) =>
      (await store.getAllRows()).nodes.sort((a, b) => a.id.localeCompare(b.id))
    expect(await nodes(shuffled)).toEqual(await nodes(inOrder))

    await inOrder.applyPulledEvents(events.slice(4, 8))
    expect(await nodes(inOrder)).toEqual(await nodes(shuffled))
  })

  it("holds an entity an update reached before its create, and reads it only once created", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    await store.applyPulledEvents(pulled(3)) // an update of blk_0, before its create
    expect((await store.getGraph()).nodes.has("blk_0")).toBe(false)
    expect((await store.getAllRows()).nodes).toEqual([])

    await store.applyPulledEvents(pulled(0)) // the create, with an older stamp
    expect((await store.getGraph()).nodes.get("blk_0")).toMatchObject({
      type: "paragraph",
      text: "t3",
    })
  })

  it("keeps a keystroke that coalesces away an earlier one, as the fold of what the log keeps", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    const doc = { ...parse("- x\n  id:: blk_aaaaaaaaaa\n"), props: null }
    await applyOpsToStore(store, docToOps("a", doc, await store.getGraph()))
    const typed = { op: "setText", id: "blk_aaaaaaaaaa" } as const
    await applyOpsToStore(store, [{ ...typed, text: "xy" }])
    await applyOpsToStore(store, [{ ...typed, text: "xyz" }])
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("xyz")
    const fold = assembleStamped(foldKeysByStamp(await store.unpushedEvents()))
    expect(toGraphSnapshot(fold).nodes.get("blk_aaaaaaaaaa")?.text).toBe("xyz")
  })

  it("gives a row the seq its pushed events take, never backwards", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    const doc = { ...parse("- one\n  id:: blk_aaaaaaaaaa\n"), props: null }
    await applyOpsToStore(store, docToOps("a", doc, await store.getGraph()))
    const queued: KeyEvent[] = await store.unpushedEvents()
    await store.markEventsPushed(queued.map((event, i) => [event.id, 50 + i] as const))
    // A later local edit, still unplaced, keeps the row's seq.
    await applyOpsToStore(store, [{ op: "setText", id: "blk_aaaaaaaaaa", text: "two" }])
    const node = (await store.getGraph()).nodes.get("blk_aaaaaaaaaa")
    expect(node?.text).toBe("two")
    expect(node?.seq).toBeGreaterThanOrEqual(50)
  })
})

describe("the read-outs agree (the two ES-4 differences)", () => {
  it("a row never placed has no seq, and a live link to a tombstone is in no read", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    await store.applyPull({
      nodes: [
        { id: "a", type: "note", text: "A", props: null, updated_at: 10, seq: 3 },
        {
          id: "c",
          type: "paragraph",
          text: "c",
          props: null,
          updated_at: 30,
          deleted_at: 30,
          seq: 6,
        },
        { id: "e", type: "paragraph", text: "e", props: null, updated_at: 25 },
      ],
      links: [
        {
          source_id: "a",
          destination_id: "c",
          kind: "child",
          sort_key: "a1",
          updated_at: 30,
          seq: 6,
        },
        { source_id: "a", destination_id: "e", kind: "child", sort_key: "a2", updated_at: 25 },
      ],
      views: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    const graph = await store.getGraph()
    expect(graph.childLinks.get("a")?.map((link) => link.destination_id)).toEqual(["e"])
    expect(graph.nodes.get("e")).not.toHaveProperty("seq")
    expect((await store.childLinksOf(["a"])).map((link) => link.destination_id)).toEqual(["e"])
    expect((await store.parentLinksOf(["c"])).length).toBe(0)

    const keys = {
      blocks: new Set(["a", "c", "e"]),
      links: new Set(["a|c|child", "a|e|child"]),
      views: new Set<string>(),
    }
    const cached = await store.getLiveRows(keys)
    expect(cached.nodes.map((row) => row.id).sort()).toEqual(["a", "e"])
    expect(cached.links.map((row) => row.destination_id)).toEqual(["e"])
  })
})

describe("lazy reads", () => {
  async function outline() {
    const rec = recording()
    const store = await openSqlNoteStore(rec.driver)
    const builder = logBuilder()
    await store.applyPulledEvents(builder.push(docToGraph("note-a", NOTE_A, 10)))
    await store.applyPulledEvents(
      builder.push(docToGraph("note-b", "- other\n  id:: blk_cccccccccc\n", 10)),
    )
    rec.reads.length = 0
    return { ...rec, store }
  }

  const plan = async (driver: SqlDriver, read: { sql: string; params: unknown[] }) =>
    (await driver.exec(`EXPLAIN QUERY PLAN ${read.sql}`, read.params as never))
      .map((row) => String(row.detail))
      .join(" | ")

  it("expands a block by its links by source, then its children by id, and reads no more", async () => {
    const { store, reads, inner } = await outline()
    const links = await store.childLinksOf(["note-a"])
    const children = await store.nodesOf(links.map((link) => link.destination_id))
    expect(children.map((node) => node.id)).toEqual(["blk_aaaaaaaaaa", "blk_bbbbbbbbbb"])
    expect(reads).toHaveLength(2)
    expect(reads[0].params).toEqual(["note-a"])
    expect(reads[1].params).toEqual(["blk_aaaaaaaaaa", "blk_bbbbbbbbbb"])
    expect(await plan(inner, reads[0])).toMatch(/USING (COVERING )?INDEX link_source/)
    expect(await plan(inner, reads[1])).toMatch(/USING INDEX sqlite_autoindex_nodes_1|PRIMARY KEY/)
  })

  it("reads an up pivot by destination", async () => {
    const { store, reads, inner } = await outline()
    const parents = await store.parentLinksOf(["blk_bbbbbbbbbb"])
    expect(parents.map((link) => link.source_id)).toEqual(["note-a"])
    expect(reads).toHaveLength(1)
    expect(await plan(inner, reads[0])).toMatch(/USING INDEX link_destination/)
  })
})

describe("the stamp fill", () => {
  /** A store as an older build left it: rows with no stamps, and no flag. */
  async function upgraded() {
    const driver = createNodeSqlDriver()
    const store = await openSqlNoteStore(driver)
    await store.applyPull({
      nodes: [
        { id: "a", type: "note", text: "A", props: null, updated_at: 10, seq: 3 },
        { id: "b", type: "paragraph", text: "b", props: null, updated_at: 20 },
      ],
      links: [
        { source_id: "a", destination_id: "b", kind: "child", sort_key: "a0", updated_at: 20 },
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
    for (const table of ["nodes", "link", "views"]) {
      await driver.exec(`UPDATE ${table} SET stamps = NULL`)
    }
    await driver.exec("DELETE FROM meta WHERE key = ?", [CACHE_STAMPS_KEY])
    return { driver, store: await openSqlNoteStore(driver) }
  }

  const stampsOf = async (driver: SqlDriver, table: string) =>
    (await driver.exec(`SELECT stamps FROM ${table}`)).map(
      (row) => JSON.parse(String(row.stamps)) as Record<string, string>,
    )

  it("gives each row the stamps its last event derives, as eventStamp spells them", async () => {
    const { driver } = await upgraded()
    const [node] = (await stampsOf(driver, "nodes")).slice(0, 1)
    expect(node).toEqual(JSON.parse(derivedStamps("block", { updated_at: 10, seq: 3 })))
    expect(node.text).toBe(eventStamp({ at: 10, seq: 3 } as RuminateEvent))
    const [link] = await stampsOf(driver, "link")
    expect(link).toEqual(JSON.parse(derivedStamps("link", { updated_at: 20 })))
    const [view] = await stampsOf(driver, "views")
    expect(view.pinned).toBe(eventStamp({ at: 10, seq: 5 } as RuminateEvent))
  })

  it("runs once: the flag alone decides", async () => {
    const { driver } = await upgraded()
    expect(
      await driver.exec("SELECT value FROM meta WHERE key = ?", [CACHE_STAMPS_KEY]),
    ).toHaveLength(1)
    await driver.exec("UPDATE nodes SET stamps = NULL")
    await openSqlNoteStore(driver)
    expect((await driver.exec("SELECT stamps FROM nodes"))[0].stamps).toBeNull()
  })

  it("lets the row's own last event apply again with no change", async () => {
    const { store } = await upgraded()
    const before = await store.getAllRows()
    await store.applyPulledEvents(
      keyed([
        {
          id: "evt_old",
          seq: 3,
          batch: "bat_old",
          device: "",
          at: 10,
          v: 1,
          entity: "block",
          entity_id: "a",
          action: "update",
          patch: { text: "A" },
        } as LoggedEvent,
      ]),
    )
    expect(await store.getAllRows()).toEqual(before)
  })
})

describe("search from the cache (ES-8)", () => {
  it("the note list and the block index from the cache equal those from the whole log's fold", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    const builder = logBuilder()
    await store.applyPulledEvents(builder.push(docToGraph("note-a", NOTE_A, 10)))
    const NOTE_B = ["- [ ] walk the dog", "  id:: blk_cccccccccc", ""].join("\n")
    await store.applyPulledEvents(builder.push(docToGraph("note-b", NOTE_B, 20)))
    const NOTE_A_EDITED = NOTE_A.replace("buy milk", "buy oat milk")
    await store.applyPulledEvents(builder.push(docToGraph("note-a", NOTE_A_EDITED, 30)))

    const fromCache = await store.getGraph()
    const fromWholeLog = toGraphSnapshot(assembleStamped(foldKeysByStamp(builder.log)))
    expect(fromCache).toEqual(fromWholeLog)

    // Nothing about search is stored: the note list and the block index are
    // read straight off each graph, and the two agree.
    const notesFromCache = createNotesBuilder()(fromCache)
    const notesFromWholeLog = createNotesBuilder()(fromWholeLog)
    expect(notesFromCache).toEqual(notesFromWholeLog)
    expect(notesFromCache.size).toBe(2)

    const byBlockId = (hits: readonly BlockHit[]) =>
      [...hits].sort((a, b) => a.blockId.localeCompare(b.blockId))
    const indexFromCache = createBlockIndexer()([...notesFromCache.values()], fromCache)
    const indexFromWholeLog = createBlockIndexer()([...notesFromWholeLog.values()], fromWholeLog)
    expect(byBlockId(indexFromCache.hits)).toEqual(byBlockId(indexFromWholeLog.hits))
    expect(indexFromCache.hits.map((hit) => hit.text)).toContain("buy oat milk")
  })
})
