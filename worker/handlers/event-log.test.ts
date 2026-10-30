// tenant-guard: exempt — raw reads below prove what the planned statements
// wrote, raw writes stand in for a writer that went AROUND the log, and the
// trigger specimens are meant to be refused.
import { describe, expect, it } from "vitest"
import {
  EVENT_VERSION,
  eventStamp,
  linkEntityId,
  projectRows,
  type RuminateEvent,
} from "../../src/data/events"
import { encodeHlc } from "../../src/data/hlc"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import migration0028 from "../../migrations/0028_events_log.sql?raw"
import migration0029 from "../../migrations/0029_backfill_delta_mat_values.sql?raw"
import migration0030 from "../../migrations/0030_genesis_unlogged_rows.sql?raw"
import migration0031 from "../../migrations/0031_drop_views.sql?raw"
import migration0032 from "../../migrations/0032_events_log_cache.sql?raw"
import {
  cacheRowKey,
  foldEventsToCache,
  groupCacheRows,
  rowsOfEntities,
  type CacheRow,
} from "../../src/data/cache-rows"
import {
  assembleLogState,
  editsOf,
  expandLog,
  foldKeys,
  keyEventStamp,
  type KeyEvent,
} from "../../src/data/key-events"
import {
  appendClientEvents,
  appendClientKeyEvents,
  appendEvents,
  corpusAt,
  planKeyAppend,
  readEvents,
  readKeyEvents,
  restoreSubtree,
  verifyLog,
  writeRows,
  type StoredKeyEvent,
} from "./event-log"
import { corpusPut } from "./replica-corpus"
import type { LinkRow, NodeRow } from "./replica-payload"
import { createTenantTestDriver } from "./sqlite-test-driver"

const identityOf = (id: number) => ({ id, login: `u${id}`, name: null })

async function open(
  options: { views?: boolean } = {},
): Promise<{ driver: SqlDriver; alice: TenantDb; bob: TenantDb }> {
  const driver = await createTenantTestDriver(options)
  const alice = forTenant(driver, identityOf(111))
  const bob = forTenant(driver, identityOf(222))
  await ensureTenantMeta(alice)
  await ensureTenantMeta(bob)
  return { driver, alice, bob }
}

/** A writer of old-shaped EVENTS, as a build before key events made them:
 * mints ids and stamps a clock that ticks once per event. */
function writer(device = "tab-1") {
  let n = 0
  let clock = 1_000
  const make = (
    entity: RuminateEvent["entity"],
    entityId: string,
    action: RuminateEvent["action"],
    patch: object,
    cause?: string,
  ): RuminateEvent =>
    ({
      id: `evt_${device}_${(n += 1)}`,
      batch: `b${n}`,
      device,
      ...(cause ? { cause } : {}),
      at: (clock += 10),
      v: EVENT_VERSION,
      entity,
      entity_id: entityId,
      action,
      patch,
    }) as RuminateEvent
  return {
    block: (id: string, type: string, text: string, notesId: string | null = "note") =>
      make("block", id, "create", { type, text, props: null, notes_id: notesId }),
    edit: (id: string, patch: object, cause?: string) => make("block", id, "update", patch, cause),
    remove: (id: string, cause?: string) => make("block", id, "delete", {}, cause),
    link: (source: string, destination: string, sortKey: string) =>
      make("link", linkEntityId(source, destination), "create", {
        source_id: source,
        destination_id: destination,
        kind: "child",
        sort_key: sortKey,
      }),
    move: (source: string, destination: string, sortKey: string) =>
      make("link", linkEntityId(source, destination), "update", { sort_key: sortKey }),
    unlink: (source: string, destination: string, cause?: string) =>
      make("link", linkEntityId(source, destination), "delete", {}, cause),
    view: (id: string, rootId: string, pinned: boolean) =>
      make("view", id, "create", {
        root_id: rootId,
        filter: null,
        sort: null,
        pinned,
        sort_key: null,
      }),
    editView: (id: string, patch: object) => make("view", id, "update", patch),
  }
}

/** An event as a device of this build stamps it: `ms`, counter 0, its device. */
const stampedAt = (event: RuminateEvent, ms: number): RuminateEvent => ({
  ...event,
  hlc: encodeHlc({ ms, counter: 0, device: event.device }),
})

const append = (tenant: TenantDb, events: RuminateEvent[], now = 5_000) =>
  appendEvents(tenant, events, { actor: tenant.userId, origin: "replica", now })

/** A writer of ROWS — what every real writer is. */
const node = (id: string, type: string, text: string, at: number, extra: Partial<NodeRow> = {}) =>
  ({ id, type, text, props: null, updated_at: at, notes_id: "note", ...extra }) as NodeRow
const child = (source: string, destination: string, sortKey: string, at: number): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: at,
})

/** The whole per-key log. */
const readLog = (tenant: TenantDb) => readKeyEvents(tenant, { limit: 100_000 })

/** The log as edits, tersely: `entity.action id` per run of rows of one
 * edit — the liveness row's action, or `update` for a run of sets. */
const edits = (log: StoredKeyEvent[]) => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const row of log) {
    const edit = row.event ?? row.id
    if (seen.has(edit)) continue
    seen.add(edit)
    const liveness = log.find((other) => (other.event ?? other.id) === edit && other.key === "")
    out.push(`${row.entity}.${liveness?.action ?? "update"} ${row.entity_id}`)
  }
  return out
}

/** The rows of the log, tersely: `action key=value`. */
const rows = (log: readonly KeyEvent[]) =>
  log.map(
    (row) =>
      `${row.action} ${row.key}${row.action === "set" ? `=${JSON.stringify(row.value)}` : ""}`,
  )

/** The rows of one edit. */
const rowsOf = (log: StoredKeyEvent[], edit: string) =>
  rows(log.filter((row) => (row.event ?? row.id) === edit))

/** Every row of a tenant's cache (docs/events-log-cache.md), raw. */
const cacheRows = async (driver: SqlDriver, userId = 111): Promise<CacheRow[]> =>
  (
    await driver.exec(
      "SELECT entity, entity_id, key, value, hlc, seq, updated_at FROM events_log_cache " +
        "WHERE user_id = ?1 ORDER BY entity, entity_id, key",
      [userId],
    )
  ).map((row) => ({
    entity: row.entity as CacheRow["entity"],
    entity_id: String(row.entity_id),
    key: String(row.key),
    value: row.value === null ? null : String(row.value),
    hlc: String(row.hlc),
    seq: row.seq === null ? null : Number(row.seq),
    updated_at: Number(row.updated_at),
  }))

/** The cache as every reader of the Worker reads it: entities, tombstones too. */
const cacheOf = async (driver: SqlDriver, userId = 111) =>
  rowsOfEntities(groupCacheRows(await cacheRows(driver, userId)).values())
const nodeOf = async (driver: SqlDriver, id: string) =>
  (await cacheOf(driver)).nodes.find((row) => row.id === id)
const linkOf = async (driver: SqlDriver, source: string, destination: string) =>
  (await cacheOf(driver)).links.find(
    (row) => row.source_id === source && row.destination_id === destination,
  )
/** A block's props as every reader of the Worker reads them: from its keys. */
const propsRaw = async (driver: SqlDriver, id: string) => (await nodeOf(driver, id))?.props ?? null
const propsOf = async (driver: SqlDriver, id: string) =>
  JSON.parse(String(await propsRaw(driver, id)))
/** A block's `props.*` rows of the cache, tersely: `key=value`. */
const keyRowsOf = async (driver: SqlDriver, id: string) =>
  (await cacheRows(driver))
    .filter((row) => row.entity === "block" && row.entity_id === id && row.key.startsWith("props."))
    .map((row) => `${row.key.slice(6)}=${row.value}`)

/** A write of nothing: what projects log rows appended around the Worker
 * into the cache (the watermark's catch-up, `catchUpStatements`). */
const catchUp = (tenant: TenantDb) =>
  writeRows(tenant, { nodes: [], links: [] }, { actor: tenant.userId, origin: "system" })

/** Old-shaped events as the old `events` table holds them: history from
 * before the cut-over, written by hand here since nothing writes it now. */
async function insertOldEvents(driver: SqlDriver, events: readonly RuminateEvent[]) {
  for (const [i, event] of events.entries()) {
    await driver.exec(
      "INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, origin, " +
        "device, cause, actor, at, tz, hlc, received_at, append) " +
        "VALUES (111, ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'replica', ?8, ?9, 111, ?10, NULL, ?11, ?10, 'old')",
      [
        i + 1,
        event.id,
        event.entity,
        event.entity_id,
        event.action,
        JSON.stringify(event.patch),
        event.batch,
        event.device,
        event.cause ?? null,
        event.at,
        event.hlc ?? null,
      ],
    )
  }
  return events.map((event, i) => ({ ...event, seq: i + 1 }))
}

describe("appending events", () => {
  it("projects an append into the cache, logs view events as history — and the fold agrees with the cache", async () => {
    const { driver, alice } = await open()
    const w = writer()
    await append(alice, [
      w.block("note", "note", "Ideas", null),
      w.block("a", "h1", "Heading"),
      w.link("note", "a", "a0"),
      w.view("v1", "note", true),
    ])
    await append(alice, [
      w.edit("a", { text: "Heading, edited" }),
      w.edit("a", { type: "text", props: '{"k":1}' }),
      w.move("note", "a", "a5"),
      w.editView("v1", { pinned: false, filter: "type:todo" }),
    ])
    await append(alice, [w.edit("a", { props: null }), w.unlink("note", "a"), w.remove("a")])

    const log = await readLog(alice)
    expect(log.map((row) => row.seq)).toEqual(log.map((_, i) => i + 1))
    expect(log).toHaveLength(28)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 28, drift: [] })

    const a = await nodeOf(driver, "a")
    expect(a).toMatchObject({ text: "Heading, edited", type: "text", props: null, seq: 28 })
    expect(a?.deleted_at).toBeDefined()
    // A view event projects nothing: the cache holds blocks and links.
    expect((await cacheRows(driver)).some((row) => row.entity_id === "v1")).toBe(false)
  })

  it("plans the same three statements for one event or three hundred", () => {
    // The log insert, the cache upsert, then the watermark.
    const w = writer()
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    const many = Array.from({ length: 300 }, (_, i) => w.block(`blk_${i}`, "text", `Block ${i}`))
    expect(planKeyAppend(expandLog([w.block("a", "text", "A")]), ctx)).toHaveLength(3)
    expect(planKeyAppend(expandLog(many), ctx)).toHaveLength(3)
  })

  it("cuts an append that would not fit one bound value into runs that do, in one batch", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const events = [
      w.block("a", "text", "A"),
      w.edit("a", { text: "A2" }),
      w.block("b", "text", "B"),
      w.edit("a", { text: "A3" }),
      w.remove("b"),
    ]
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    // A limit so small every edit is its own run: the hardest case for order.
    const statements = planKeyAppend(expandLog(events), ctx, 1)
    expect(statements).toHaveLength(2 * events.length + 1)
    await alice.includingDeleted().batch(statements)
    expect((await readLog(alice)).map((row) => row.seq)).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1),
    )
    const rows = (await cacheOf(driver)).nodes.map((row) => ({
      id: row.id,
      text: row.text,
      seq: row.seq,
      dead: row.deleted_at === undefined ? 0 : 1,
    }))
    expect(rows).toEqual([
      { id: "a", text: "A3", seq: 10, dead: 0 },
      { id: "b", text: "B", seq: 11, dead: 1 },
    ])
    expect((await verifyLog(alice)).ok).toBe(true)
  })

  it("appends three hundred blocks in one batch, contiguously sequenced", async () => {
    const { driver, alice } = await open()
    const w = writer()
    await append(alice, [w.block("note", "note", "N", null)])
    await append(
      alice,
      Array.from({ length: 300 }, (_, i) => w.block(`blk_${i}`, "text", `Block ${i}`)),
    )
    const [{ n, lo, hi }] = await driver.exec(
      "SELECT COUNT(DISTINCT entity_id) AS n, MIN(seq) AS lo, MAX(seq) AS hi " +
        "FROM events_log_cache WHERE user_id = 111 AND entity = 'block' AND entity_id LIKE 'blk_%'",
    )
    // Four rows per block (its create, type, text and note id), each cache
    // row at the seq of the event that set it.
    expect([n, lo, hi]).toEqual([300, 5, 1204])
  })

  it("a re-sent append adds nothing and regresses nothing", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const first = [w.block("a", "text", "first")]
    await append(alice, first)
    await append(alice, [w.edit("a", { text: "second" })])
    await append(alice, first)

    expect(await readLog(alice)).toHaveLength(5)
    expect(await nodeOf(driver, "a")).toMatchObject({ text: "second", seq: 5 })
  })

  it("sequences each tenant on its own, and shows neither the other's log", async () => {
    const { alice, bob } = await open()
    await append(alice, [writer("alice").block("a", "text", "alice's")])
    await append(bob, [
      writer("bob").block("b", "text", "b"),
      writer("bob2").block("c", "text", "c"),
    ])
    expect(edits(await readLog(alice))).toEqual(["block.create a"])
    expect(edits(await readLog(bob))).toEqual(["block.create b", "block.create c"])
    expect((await readLog(bob)).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it("is append-only: no update, and no delete without a recorded purge", async () => {
    const { driver, alice } = await open()
    await append(alice, [writer().block("a", "text", "A")])
    // (The test driver throws synchronously; `async` makes either a rejection.)
    await expect(
      (async () => driver.exec("UPDATE events_log SET value = '{}' WHERE user_id = 111"))(),
    ).rejects.toThrow(/append-only/)
    await expect(
      (async () => driver.exec("DELETE FROM events_log WHERE user_id = 111"))(),
    ).rejects.toThrow(/append-only/)
    // Erasing an account is the one door: named, reasoned, and per tenant.
    await driver.exec(
      "INSERT INTO event_purges (user_id, reason, created_at) VALUES (111, 'account erasure', 1)",
    )
    await driver.exec("DELETE FROM events_log WHERE user_id = 111")
    expect(await readLog(alice)).toEqual([])
  })

  it("writes nothing to the old log, which still serves what it held", async () => {
    const { driver, alice } = await open()
    const w = writer("old")
    await insertOldEvents(driver, [w.block("h", "text", "from before the cut-over")])
    await append(alice, [writer().block("a", "text", "A")])
    const old = await readEvents(alice)
    expect(old.map((event) => `${event.seq} ${event.entity_id}`)).toEqual(["1 h"])
    expect(await readEvents(alice, { entity: "block", entityId: "a" })).toEqual([])
  })
})

describe("what a push costs", () => {
  // D1 bills rows READ, and a push happens every couple of seconds of typing.
  // A statement that walks the tenant's whole corpus to change one row is
  // invisible in tests and in review — it returns the right answer — so the
  // plans themselves are pinned: every touch of a corpus table is a seek on
  // more than the tenant, or a range above the log's maximum (reconcile).
  it("never walks a tenant's rows: every corpus lookup is a key seek", async () => {
    const { driver } = await open()
    const ctx = { actor: 111, origin: "replica" as const, client: null, now: 1, appendId: "b" }
    const w = writer()
    const events = [
      w.block("a", "text", "A"),
      w.edit("a", { text: "B", props: '{"k":1}' }),
      w.link("note", "a", "a0"),
      w.move("note", "a", "a1"),
      w.view("v", "note", true),
      w.editView("v", { pinned: false }),
    ]
    for (const statement of planKeyAppend(expandLog(events), ctx)) {
      const sql = statement.sql.replace(/:tenant\b/g, "111")
      const plan = await driver.exec(`EXPLAIN QUERY PLAN ${sql}`, statement.params ?? [])
      const details = (plan as { detail: string }[]).map((row) => row.detail)
      for (const detail of details) {
        const corpus = /^(?:SEARCH|SCAN) (?:events_log_cache|nodes|link|delta_mat_values)\b/.test(
          detail,
        )
        if (!corpus) continue
        expect(detail, sql.slice(0, 40)).toMatch(/^SEARCH/)
        expect(detail, sql.slice(0, 40)).not.toMatch(/\(user_id=\?\)$/)
      }
    }
  })
})

describe("every writer's rows become events", () => {
  it("names what happened to each row: create, update, delete, restore — and nothing for a stale one", async () => {
    const { alice } = await open()
    await corpusPut(alice, {
      nodes: [node("note", "note", "N", 100, { notes_id: undefined }), node("a", "text", "A", 100)],
      links: [child("note", "a", "a0", 100)],
    })
    await corpusPut(alice, { nodes: [node("a", "h1", "A, retitled", 200)], links: [] })
    // Stale (older `updated_at`), and a re-push of what is already held: no events.
    await corpusPut(alice, { nodes: [node("a", "text", "stale", 150)], links: [] })
    await corpusPut(alice, { nodes: [node("a", "h1", "A, retitled", 200)], links: [] })
    // Typed and deleted within one push window: the last text is kept, under the tombstone.
    await corpusPut(alice, {
      nodes: [node("a", "h1", "last words", 300, { deleted_at: 300 })],
      links: [],
    })
    await corpusPut(alice, { nodes: [node("a", "h1", "back", 400)], links: [] })
    await corpusPut(alice, { nodes: [], links: [child("note", "a", "a9", 500)] })

    const log = await readLog(alice)
    const made = edits(log)
    expect(made).toEqual([
      "block.create note",
      "block.create a",
      "link.create note|a|child",
      "block.update a",
      "block.update a",
      "block.delete a",
      "block.restore a",
      "link.update note|a|child",
    ])
    const ids = [...new Set(log.map((row) => row.event ?? row.id))]
    expect(rowsOf(log, ids[3])).toEqual(['set type="h1"', 'set text="A, retitled"'])
    expect(rowsOf(log, ids[4])).toEqual(['set text="last words"'])
    expect(rowsOf(log, ids[6])).toEqual(["restore ", 'set text="back"'])
    expect(rowsOf(log, ids[7])).toEqual(['set sort_key="a9"'])
    // What the writer believed it was changing travels with the change: the
    // row's seq as it stood, its last key row's.
    expect(log.find((row) => row.event === ids[3])?.base_seq).toBe(8)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 20 })
  })

  it("keeps the entities as the row planner left them", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, {
      nodes: [node("note", "note", "N", 100, { notes_id: undefined }), node("a", "text", "A", 110)],
      links: [child("note", "a", "a0", 110)],
      deleteNodes: [],
    })
    await corpusPut(alice, { nodes: [], links: [], deleteNodes: ["a"] }, 900)
    const pulled = await cacheOf(driver)
    expect(pulled.nodes.find((row) => row.id === "a")).toEqual({
      id: "a",
      type: "text",
      text: "A",
      props: null,
      updated_at: 900,
      deleted_at: 900,
      notes_id: "note",
      seq: 14,
    })
    // No cascade: the link to a deleted block is retained, for a restore to use.
    expect(pulled.links[0].deleted_at).toBeUndefined()
  })

  it("records who wrote, through which door, from what — a grantee in an owner's log included", async () => {
    const { alice } = await open()
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [] }, 1_000, {
      device: "tab-9",
      client: "build-abc",
    })
    await writeRows(
      alice,
      { nodes: [node("a", "text", "A, by a grantee", 200)], links: [] },
      { actor: 222, origin: "share", device: "share", now: 2_000 },
    )
    const log = await readLog(alice)
    expect(log[0]).toMatchObject({
      actor: 111,
      origin: "replica",
      device: "tab-9",
      client: "build-abc",
      received_at: 1_000,
    })
    expect(log[4]).toMatchObject({ actor: 222, origin: "share", received_at: 2_000 })
  })

  it("stamps the browser's cursor in the same transaction as the events", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [], cursor: "c-1" })
    const [meta] = await driver.exec(
      "SELECT value FROM meta WHERE user_id = 111 AND key = 'replica_cursor'",
    )
    expect(meta.value).toBe("c-1")
  })

  it("a block's props set and unset round-trip: the rows door, the pull, the key rows", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, {
      nodes: [
        node("note", "note", "N", 100, { notes_id: undefined }),
        node("a", "image", "A", 100, { props: '{"size":40,"align":"left","nested":{"x":[1]}}' }),
      ],
      links: [child("note", "a", "a0", 100)],
    })
    expect(await propsRaw(driver, "a")).toBe('{"align":"left","nested":{"x":[1]},"size":40}')
    expect(await keyRowsOf(driver, "a")).toEqual(['align="left"', 'nested={"x":[1]}', "size=40"])
    // One key unset, one changed, by a whole-props writer.
    await corpusPut(
      alice,
      {
        nodes: [node("a", "image", "A", 200, { props: '{"size":50,"nested":{"x":[1]}}' })],
        links: [],
      },
      2_000,
    )
    expect(await propsOf(driver, "a")).toEqual({ nested: { x: [1] }, size: 50 })
    // The unset key keeps its row, with no value: the tombstone of a key.
    expect(await keyRowsOf(driver, "a")).toEqual(["align=null", 'nested={"x":[1]}', "size=50"])
    // Every key gone: the column reads as none.
    await corpusPut(
      alice,
      { nodes: [node("a", "image", "A", 300, { props: null })], links: [] },
      3_000,
    )
    expect(await propsRaw(driver, "a")).toBeNull()
    expect(await keyRowsOf(driver, "a")).toEqual(["align=null", "nested=null", "size=null"])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, drift: [] })
  })
})

describe("a client's own events, old-shaped", () => {
  const client = (tenant: TenantDb, events: RuminateEvent[], now = 5_000) =>
    appendClientEvents(tenant, events, {
      actor: tenant.userId,
      origin: "replica",
      client: "2026-W41.abc",
      now,
    })

  it("lands as it was made — cause, base, zone and all — and answers each event's seq", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.tab")
    const made = [w.block("note", "note", "N", null), w.block("a", "text", "A")]
    made[1] = { ...made[1], cause: "paste", tz: 60, base_seq: null }
    const landed = await client(alice, made)
    expect(landed).toEqual({
      appended: 2,
      stale: 0,
      seqs: [
        [made[0].id, 4],
        [made[1].id, 8],
      ],
    })
    const log = await readLog(alice)
    expect(log[4]).toMatchObject({
      cause: "paste",
      tz: 60,
      device: "dev.tab",
      client: "2026-W41.abc",
      origin: "replica",
      actor: 111,
      received_at: 5_000,
      event: made[1].id,
    })
    expect(log[0].tz ?? null).toBeNull()
    expect(log[0].event_seq).toBeUndefined()
    // The projection follows, as for any append; the fold agrees.
    const pulled = await cacheOf(driver)
    expect(
      pulled.nodes
        .map((row) => [row.id, row.text, row.seq])
        .sort((x, y) => Number(x[2]) - Number(y[2])),
    ).toEqual([
      ["note", "N", 4],
      ["a", "A", 8],
    ])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 8 })
  })

  it("drops what is stale by stamp, per key, and keeps what sets one", async () => {
    const { driver, alice } = await open()
    const a = writer("dev.a")
    const b = writer("dev.b")
    await client(alice, [stampedAt(a.block("a", "text", "A"), 1_000)])
    // Another device edited the text since, through the row door, at 2000.
    await corpusPut(alice, { nodes: [node("a", "text", "A, elsewhere", 2_000)], links: [] }, 2_000)

    // An offline device's older text: behind the text's stamp.
    const stale = stampedAt(b.edit("a", { text: "A, offline" }), 1_500)
    // Its older change to ANOTHER field: that field's stamp is older still.
    const type = stampedAt(b.edit("a", { type: "h1" }), 1_200)
    const fresh = stampedAt(b.edit("a", { text: "A, after" }), 2_500)
    // A create behind every stamp the row holds sets nothing either.
    const again = stampedAt(b.block("a", "text", "A, again"), 900)
    const landed = await client(alice, [stale, type, fresh, again])
    expect(landed.stale).toBe(2)
    expect(landed.appended).toBe(2)
    expect(landed.seqs.map(([id]) => id)).toEqual([type.id, fresh.id])
    expect(edits(await readLog(alice))).toEqual([
      "block.create a",
      "block.update a",
      "block.update a",
      "block.update a",
    ])
    expect(await nodeOf(driver, "a")).toMatchObject({ type: "h1", text: "A, after" })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("keeps the key an older whole-props patch changed beside a newer change to another", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.a")
    await client(alice, [
      stampedAt(
        {
          ...w.block("a", "image", "A"),
          patch: { ...w.block("x", "image", "A").patch, props: '{"align":"left","size":40}' },
        } as RuminateEvent,
        1_000,
      ),
    ])
    await client(alice, [
      stampedAt(
        { ...w.edit("a", { props: '{"align":"left","size":80}' }), device: "phone" },
        2_000,
      ),
    ])
    const late = await client(alice, [
      stampedAt(w.edit("a", { props: '{"align":"right","size":40}' }), 1_500),
    ])
    // The patch's size is behind the phone's; its alignment is not.
    expect(late).toMatchObject({ appended: 1, stale: 0 })
    expect(await propsOf(driver, "a")).toEqual({ align: "right", size: 80 })
    expect(rowsOf(await readLog(alice), late.seqs[0][0])).toEqual(['set props.align="right"'])
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("is idempotent: a re-sent push appends nothing, projects nothing, and answers the same seqs", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.tab")
    const made = [w.block("a", "text", "A"), w.edit("a", { text: "A!" })]
    const first = await client(alice, made)
    // Something else landed in between; the re-send must not lay the old
    // net change over it.
    await corpusPut(alice, { nodes: [node("a", "text", "A, elsewhere", 9_000)], links: [] })
    const second = await client(alice, made)
    expect(second).toEqual({ appended: 0, stale: 0, seqs: first.seqs })
    expect((await nodeOf(driver, "a"))?.text).toBe("A, elsewhere")
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 6 })
  })

  it("answers an event that reads as no change with the log's end, so the client clears it", async () => {
    const { alice } = await open()
    const w = writer("dev.tab")
    await client(alice, [
      {
        ...w.block("a", "text", "A"),
        patch: { type: "text", text: "A", props: '{"k":1,"j":2}', notes_id: "note" },
      } as RuminateEvent,
    ])
    const reorder = w.edit("a", { props: '{"j":2,"k":1}' })
    const landed = await client(alice, [reorder])
    expect(landed).toEqual({ appended: 0, stale: 0, seqs: [[reorder.id, 6]] })
    expect(await readLog(alice)).toHaveLength(6)
  })

  it("carries the browser's cursor in the same transaction, like a push of rows", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.tab")
    await appendClientEvents(
      alice,
      [w.block("a", "text", "A")],
      { actor: 111, origin: "replica", now: 1 },
      [
        {
          sql:
            "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', ?1) " +
            "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
          params: ["c-7"],
        },
      ],
    )
    const [meta] = await driver.exec(
      "SELECT value FROM meta WHERE user_id = 111 AND key = 'replica_cursor'",
    )
    expect(meta.value).toBe("c-7")
  })

  it("stores each event's stamp and serves it back; an event without one is served without", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.tab")
    const stamped = { ...w.block("a", "text", "A"), hlc: "000000000001010-0000-dev.tab" }
    const old = w.edit("a", { text: "A!" }) // a build before stamps
    await client(alice, [stamped, old])
    const rows = await driver.exec(
      "SELECT seq, hlc FROM events_log WHERE user_id = 111 ORDER BY seq",
    )
    expect(rows).toEqual([
      { seq: 1, hlc: "000000000001010-0000-dev.tab" },
      { seq: 2, hlc: "000000000001010-0000-dev.tab" },
      { seq: 3, hlc: "000000000001010-0000-dev.tab" },
      { seq: 4, hlc: "000000000001010-0000-dev.tab" },
      { seq: 5, hlc: null },
    ])
    const log = await readLog(alice)
    expect(log[0].hlc).toBe(stamped.hlc)
    expect("hlc" in log[4]).toBe(false)
    // The reader derives the missing one from what every reader holds alike:
    // the row's own place in the log.
    expect(keyEventStamp(log[4])).toBe(`000000000001020-0000-seq:000000000000005`)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 5 })
  })

  it("does not reconcile: a row written around the log stays out of it", async () => {
    const { driver, alice } = await open()
    // A row written around the log — a statement run in the console. Until
    // migration 0030 every write recorded it first; that cost four scans of
    // the whole log on every pull and push, and genesis now runs once, in
    // the migration (the tests of "genesis" below).
    await driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, updated_at, deleted_at, notes_id, seq) " +
        "VALUES (111, 'old', 'text', 'before the log', 50, NULL, NULL, 7)",
    )
    const w = writer("dev.tab")
    await client(alice, [w.block("a", "text", "A")])
    expect(edits(await readLog(alice))).toEqual(["block.create a"])
  })
})

describe("genesis (migration 0030)", () => {
  /** A row that reached the tables around the log — the Worker before the
   * log, a hand-run statement in the console. */
  const stray = (driver: SqlDriver, id: string, text: string, seq: number, deletedAt?: number) =>
    driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, updated_at, deleted_at, notes_id, seq) " +
        "VALUES (111, ?1, 'text', ?2, ?3, ?4, 'note', ?3) " +
        "ON CONFLICT (user_id, id) DO UPDATE SET text = excluded.text, seq = excluded.seq, " +
        "updated_at = excluded.updated_at",
      [id, text, seq, deletedAt ?? null],
    )

  it("records every row the log has no event for, once, as a snapshot — views too, before 0031 drops them", async () => {
    // Production's order: 0030 runs while `views` is there, then 0031.
    const { driver, alice } = await open({ views: true })
    await stray(driver, "old-1", "from before the log", 1)
    await stray(driver, "old-2", "deleted before the log", 2, 2)
    await driver.exec(
      "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq) " +
        "VALUES (111, 'note', 'old-1', 'child', 'a0', 3, NULL, 3)",
    )
    await driver.exec(
      "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq) " +
        "VALUES (111, 'v', 'note', NULL, 'text:desc', 1, 'a0', 4, NULL, 4)",
    )
    // The keys a block held, written around the log beside it.
    await driver.exec(
      "INSERT INTO delta_mat_values (user_id, block_id, key, value, hlc, seq, updated_at) " +
        "VALUES (111, 'old-1', 'size', '40', 'x', 1, 1)",
    )

    await driver.execScript(migration0030)
    await corpusPut(alice, { nodes: [node("new", "text", "the first write", 50)], links: [] })

    const log = await readLog(alice)
    expect(edits(log)).toEqual([
      "block.create old-1",
      "block.create old-2",
      "link.create note|old-1|child",
      "view.create v",
      "block.create new",
    ])
    expect(rowsOf(log, log[0].event as string)).toEqual([
      "create ",
      'set type="text"',
      'set text="from before the log"',
      'set notes_id="note"',
      "set props.size=40",
    ])
    expect(log[0]).toMatchObject({ cause: "snapshot", origin: "system", batch: "snapshot" })
    expect(log[5]).toMatchObject({ action: "create", value: 2 })
    // Each snapshotted row of the OLD table takes the seq of its last row,
    // under one stamp — the one the row derives without stamps — on every
    // row of it. The Worker writes the old table no more: the write of
    // `new` reached the cache alone.
    const seqs = await driver.exec(
      "SELECT id, seq, stamps FROM nodes WHERE user_id = 111 ORDER BY id",
    )
    expect(seqs).toEqual([
      { id: "old-1", seq: 5, stamps: null },
      { id: "old-2", seq: 9, stamps: null },
    ])
    expect(await nodeOf(driver, "new")).toMatchObject({ text: "the first write", seq: 25 })
    // …and the next write projected the snapshot into the cache, each
    // register at the snapshot's one stamp.
    expect(await nodeOf(driver, "old-1")).toMatchObject({
      text: "from before the log",
      props: '{"size":40}',
      seq: 5,
    })
    expect(new Set(log.slice(0, 5).map((row) => row.hlc))).toEqual(
      new Set([eventStamp({ at: 1, seq: 5 } as RuminateEvent)]),
    )
    expect(await driver.exec("SELECT seq FROM link WHERE user_id = 111")).toEqual([{ seq: 14 }])
    expect(await driver.exec("SELECT seq FROM views WHERE user_id = 111")).toEqual([{ seq: 21 }])
    expect(await driver.exec("SELECT hlc, seq FROM delta_mat_values WHERE user_id = 111")).toEqual([
      { hlc: eventStamp({ at: 1, seq: 5 } as RuminateEvent), seq: 5 },
    ])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 25 })

    // 0031 drops the table; the view's events stay in the log as history.
    await driver.execScript(migration0031)
    expect(await driver.exec("SELECT name FROM sqlite_master WHERE name = 'views'")).toEqual([])
    expect(edits(await readLog(alice))).toContain("view.create v")
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 25 })
  })

  it("runs once: a row written around the log after it is not recorded by a write", async () => {
    const { driver, alice } = await open({ views: true })
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [] })
    await driver.execScript(migration0030)
    expect(edits(await readLog(alice))).toEqual(["block.create a"])
    await stray(driver, "b", "another", 20)
    await corpusPut(alice, { nodes: [node("c", "text", "C", 100)], links: [] })
    expect(edits(await readLog(alice))).toEqual(["block.create a", "block.create c"])
    // The migration again finds the row the log does not know, and nothing else.
    await driver.execScript(migration0030)
    expect(edits(await readLog(alice))).toEqual([
      "block.create a",
      "block.create c",
      "block.create b",
    ])
    // The snapshot's rows sit above the watermark until the next write
    // projects them (`catchUpStatements`); verify says so meanwhile.
    expect(await verifyLog(alice)).toMatchObject({ ok: false, behind: 4 })
    await catchUp(alice)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, behind: 0, drift: [] })
    expect(await nodeOf(driver, "b")).toMatchObject({ text: "another", seq: 12 })
  })

  it("verify names drift it cannot heal: a row changed without taking a sequence", async () => {
    const { driver, alice } = await open({ views: true })
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [] })
    await driver.exec(
      "UPDATE events_log_cache SET value = '\"edited in the console\"' " +
        "WHERE user_id = 111 AND key = 'text'",
    )
    const verdict = await verifyLog(alice)
    expect(verdict.ok).toBe(false)
    expect(verdict.drift).toEqual(["block a text: value"])
  })

  it("verify names a key changed without taking a sequence, and a row the log does not hold", async () => {
    const { driver, alice } = await open({ views: true })
    await corpusPut(alice, {
      nodes: [node("a", "image", "A", 100, { props: '{"size":40}' })],
      links: [],
    })
    await driver.exec(
      "UPDATE events_log_cache SET value = '50' WHERE user_id = 111 AND key = 'props.size'",
    )
    await driver.exec(
      "INSERT INTO events_log_cache (user_id, entity, entity_id, key, value, hlc, seq, updated_at) " +
        "VALUES (111, 'block', 'a', 'props.ghost', '1', 'x', 1, 1)",
    )
    const verdict = await verifyLog(alice)
    expect(verdict.ok).toBe(false)
    expect(verdict.drift).toEqual([
      "block a props.size: value",
      "block a props.ghost: only in the cache",
    ])
  })
})

describe("a past moment", () => {
  async function seeded() {
    const opened = await open()
    const { alice } = opened
    await corpusPut(
      alice,
      {
        nodes: [
          node("note", "note", "N", 100, { notes_id: undefined }),
          node("a", "text", "one", 100),
        ],
        links: [child("note", "a", "a0", 100)],
      },
      1_000,
    )
    await corpusPut(alice, { nodes: [node("a", "text", "two", 200)], links: [] }, 2_000)
    await corpusPut(
      alice,
      { nodes: [node("a", "text", "", 300, { deleted_at: 300 })], links: [] },
      3_000,
    )
    return opened
  }

  it("is served by seq, and by the replica's clock", async () => {
    const { alice } = await seeded()
    const textAt = async (moment: { seq: number } | { at: number }) => {
      const corpus = await corpusAt(alice, moment)
      const a = corpus.nodes.find((row) => row.id === "a")
      return [corpus.seq, a?.text, a?.deleted_at ?? null]
    }
    expect(await textAt({ seq: 13 })).toEqual([13, "one", null])
    expect(await textAt({ seq: 14 })).toEqual([14, "two", null])
    expect(await textAt({ at: 2_500 })).toEqual([14, "two", null])
    expect(await textAt({ at: 9_999 })).toEqual([16, "", 300])
  })

  it("answers a moment before the log began with the beginning, and says so", async () => {
    const { alice } = await seeded()
    const corpus = await corpusAt(alice, { at: 1 })
    expect(corpus.earliest).toEqual({ seq: 13, received_at: 1_000 })
    expect(corpus.seq).toBe(13)
    expect(corpus.latest).toBe(16)
    const prefix = await readKeyEvents(alice, { upTo: 13 })
    expect(projectRows(assembleLogState(foldKeys(prefix))).nodes).toEqual(corpus.nodes)
  })

  it("has a history per entity", async () => {
    const { alice } = await seeded()
    const history = await readKeyEvents(alice, { entity: "block", entityId: "a" })
    expect(rows(history)).toEqual([
      "create ",
      'set type="text"',
      'set text="one"',
      'set notes_id="note"',
      'set text="two"',
      'set text=""',
      "delete ",
    ])
  })
})

// The incident of 2026-09-19, replayed through the door it came in by: a
// browser pushing rows. A heading and two bullets, typed during a call; then
// fifteen seconds of ordinary edits that emptied them. Under row LWW the text
// survived only in D1 Time Travel. Here it is a read, and putting it back is
// an append.
describe("the 19 September wipe", () => {
  it("keeps what was destroyed, and restores it by appending", async () => {
    const { driver, alice } = await open()
    const first = "First point from the call, a full sentence of it, typed as the meeting went on"
    const second = "Second point from the call, longer than the first, with a trailing thought"
    await corpusPut(alice, {
      nodes: [
        node("note", "note", "Ideas", 100, { notes_id: undefined }),
        node("section", "h1", "A section heading", 100),
        node("call", "h1", "Call notes", 110),
        node("b1", "ul", first, 120),
        node("b2", "ul", second, 130),
      ],
      links: [
        child("note", "section", "a1", 100),
        child("section", "call", "aG", 110),
        child("call", "b1", "a0", 120),
        child("call", "b2", "a0V", 130),
      ],
    })
    const before = (await readLog(alice)).at(-1)?.seq as number

    // 10:06:30–10:06:45 UTC, as the rows recorded it — push by push.
    const dead = (link: LinkRow, at: number): LinkRow => ({
      ...link,
      updated_at: at,
      deleted_at: at,
    })
    await corpusPut(alice, { nodes: [node("b2", "ul", " ", 200)], links: [] })
    await corpusPut(alice, { nodes: [], links: [dead(child("call", "b2", "a0V", 0), 210)] })
    await corpusPut(alice, { nodes: [node("b1", "text", "", 220)], links: [] })
    await corpusPut(alice, {
      nodes: [],
      links: [
        dead(child("call", "b1", "a0", 0), 230),
        dead(child("section", "call", "aG", 0), 240),
        child("note", "call", "a3", 240),
      ],
    })
    await corpusPut(alice, { nodes: [node("call", "text", "", 250)], links: [] })
    const wiped = (await cacheOf(driver)).nodes.filter((row) => ["call", "b1"].includes(row.id))
    expect(wiped.map((row) => row.text)).toEqual(["", ""])
    const afterWipe = (await readLog(alice)).at(-1)?.seq as number

    // Diagnosis is a read: what happened to this block, in what order.
    const history = await readKeyEvents(alice, { entity: "block", entityId: "b1" })
    expect(rows(history)).toEqual([
      "create ",
      'set type="ul"',
      `set text=${JSON.stringify(first)}`,
      'set notes_id="note"',
      'set type="text"',
      'set text=""',
    ])

    // Recovery is an append: restore the section to the moment before.
    const restored = await restoreSubtree(alice, "call", before, {
      actor: 111,
      origin: "system",
      now: 9_000,
    })
    expect(restored.events).toBe(6)

    const restoredRows = await cacheOf(driver)
    const after = restoredRows.nodes
      .filter((row) => ["call", "b1", "b2"].includes(row.id))
      .map((row) => ({
        id: row.id,
        type: row.type,
        text: row.text,
        deleted_at: row.deleted_at ?? null,
      }))
    expect(after).toEqual([
      { id: "b1", type: "ul", text: first, deleted_at: null },
      { id: "b2", type: "ul", text: second, deleted_at: null },
      { id: "call", type: "h1", text: "Call notes", deleted_at: null },
    ])
    const live = restoredRows.links
      .filter((row) => row.deleted_at === undefined)
      .map((row) => `${row.source_id}>${row.destination_id}`)
    expect(live).toEqual(expect.arrayContaining(["section>call", "call>b1", "call>b2"]))
    // The restore is in the log as what it was — nothing was rewound — and
    // the rows it touched carry fresh seqs, so every device pulls them.
    const tail = (await readLog(alice)).filter((row) => row.seq > afterWipe)
    expect(tail.every((row) => row.cause === "restore")).toBe(true)
    expect(
      tail
        .filter((row) => row.key === "")
        .every((row) => row.action === "restore" && row.ref_seq === before),
    ).toBe(true)
    expect(
      restoredRows.nodes
        .filter((row) => (row.seq ?? 0) > afterWipe)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["b1", "b2", "call"])
    expect((await verifyLog(alice)).ok).toBe(true)
    // …and restoring again is nothing: it is already there.
    expect(
      (await restoreSubtree(alice, "call", before, { actor: 111, origin: "system" })).events,
    ).toBe(0)
  })
})

describe("by stamp", () => {
  /** The cache as compared across orders: every register's value and stamp
   * — everything but `seq`, which is the order the events arrived in. */
  const tables = async (driver: SqlDriver) => ({
    rows: (await cacheRows(driver)).map(({ seq: _seq, ...row }) => row),
    ...(await cacheOf(driver)),
  })

  it("lands the same events in any order as the same tables", async () => {
    const a = writer("dev.a")
    const b = writer("dev.b")
    const made = [
      stampedAt(a.block("note", "note", "N", null), 1_000),
      stampedAt(a.block("a", "text", "A"), 1_000),
      stampedAt(a.link("note", "a", "a0"), 1_000),
      stampedAt(a.view("v", "note", true), 1_000),
    ]
    // (A whole-props patch is read per key against the row as it stands
    // when it arrives — "these are all the keys" — so two patches naming
    // different keys land as their order has it; the key door does not.)
    const fromA = [
      stampedAt(a.edit("a", { text: "A, by a" }), 3_000),
      stampedAt(a.move("note", "a", "a5"), 3_000),
      stampedAt(a.editView("v", { pinned: false }), 3_000),
    ]
    const fromB = [
      stampedAt(b.edit("a", { text: "A, by b", type: "h1" }), 2_000),
      stampedAt(b.remove("a"), 2_500),
      stampedAt(b.unlink("note", "a"), 2_000),
      stampedAt(b.editView("v", { filter: "type:todo" }), 2_000),
    ]
    const orders = [
      [made, fromA, fromB],
      [made, fromB, fromA],
      [made, [...fromA, ...fromB].reverse()],
    ]
    const results: Awaited<ReturnType<typeof tables>>[] = []
    for (const order of orders) {
      const { driver, alice } = await open()
      for (const events of order) await append(alice, events)
      expect(await verifyLog(alice)).toMatchObject({ ok: true, drift: [] })
      results.push(await tables(driver))
    }
    const sansSeq = (read: (typeof results)[number]) => ({
      rows: read.rows,
      nodes: read.nodes.map(({ seq: _seq, ...row }) => row),
      links: read.links.map(({ seq: _seq, ...row }) => row),
    })
    expect(sansSeq(results[1])).toEqual(sansSeq(results[0]))
    expect(sansSeq(results[2])).toEqual(sansSeq(results[0]))

    const block = results[0].nodes.find((row) => row.id === "a")
    expect(block).toMatchObject({
      type: "h1",
      text: "A, by a",
      props: null,
    })
    expect(block?.deleted_at).toBeDefined()
    expect(results[0].links[0]).toMatchObject({ sort_key: "a5" })
    expect(results[0].links[0].deleted_at).toBeDefined()
  })

  it("keeps both of two devices' changes to two fields of one block", async () => {
    const { driver, alice } = await open()
    const a = writer("dev.a")
    const b = writer("dev.b")
    await append(alice, [stampedAt(a.block("a", "text", "A"), 1_000)])
    await append(alice, [stampedAt(a.edit("a", { text: "A, by a" }), 2_000)])
    // B changed the type before A's edit, and its push arrives after it.
    await append(alice, [stampedAt(b.edit("a", { type: "h1" }), 1_500)])
    expect(await nodeOf(driver, "a")).toMatchObject({ type: "h1", text: "A, by a", seq: 6 })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("changes nothing for a re-sent event", async () => {
    const { driver, alice } = await open()
    const a = writer("dev.a")
    const b = writer("dev.b")
    const first = [stampedAt(a.block("a", "text", "A"), 1_000)]
    const edit = [stampedAt(a.edit("a", { text: "A, by a" }), 3_000)]
    await append(alice, first)
    await append(alice, edit)
    await append(alice, [stampedAt(b.edit("a", { type: "h1" }), 2_000)])
    const before = await cacheRows(driver)
    await append(alice, [...first, ...edit])
    expect(await cacheRows(driver)).toEqual(before)
    expect(await readLog(alice)).toHaveLength(6)
  })

  it("derives the stamp of a row that holds none as keyEventStamp does", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const blocks = Array.from({ length: 10 }, (_, i) => w.block(`blk_${i}`, "text", `B${i}`))
    blocks[9] = { ...blocks[9], at: 1_792_540_800_123 }
    await append(alice, blocks)
    const log = await readLog(alice)
    expect(log[39].hlc).toBeUndefined()
    // Each register's stamp is its own row's: the create's, the type's, the
    // text's, the note id's, in the order they were appended.
    const at = (seq: number) => `001792540800123-0000-seq:${String(seq).padStart(15, "0")}`
    expect(keyEventStamp(log[39])).toBe(at(40))
    const stamps = Object.fromEntries(
      (await cacheRows(driver))
        .filter((row) => row.entity_id === "blk_9")
        .map((row) => [row.key, row.hlc]),
    )
    expect(stamps).toEqual({
      deleted: at(37),
      type: at(38),
      text: at(39),
      notes_id: at(40),
    })
  })

  it("projects log rows appended around the Worker on the next write, by the stamp each derives", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.old")
    // Two rows from before stamps, written into the log around the Worker
    // (a hand-run statement, the Worker before the cache in the deploy
    // window). The old projection folded by seq, so the edit from a clock
    // that ran behind landed; the cache is the fold by stamp, where it
    // does not. On production of 2026-10-28 the two agreed on every
    // register (docs/events-log-cache.md).
    const legacy = [
      { ...w.block("a", "text", "A"), at: 2_000, seq: 1 },
      { ...w.edit("a", { text: "by the old rule" }), at: 1_000, seq: 2 },
    ]
    for (const [i, row] of expandLog(legacy).entries()) {
      await driver.exec(
        "INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, batch, " +
          "origin, device, actor, at, received_at, append, event_id, event_seq) " +
          "VALUES (111, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'b', 'replica', ?8, 111, ?9, ?9, 'old', ?10, ?11)",
        [
          i + 1,
          row.id,
          row.entity,
          row.entity_id,
          row.action,
          row.key,
          JSON.stringify(row.value ?? null),
          row.device,
          row.at,
          row.event ?? null,
          row.event_seq ?? null,
        ],
      )
    }
    // Nothing projected yet: the cache is behind the log by those rows.
    expect(await verifyLog(alice)).toMatchObject({ ok: false, behind: 5, keyEvents: 5 })
    expect(await nodeOf(driver, "a")).toBeUndefined()

    // The next write projects them, each register at the stamp its row
    // derives (`keyEventStamp`: the OLD log's seq for a mirrored row).
    const n = writer("dev.new")
    await append(alice, [stampedAt(n.edit("a", { type: "h1" }), 2_500)])
    expect(await nodeOf(driver, "a")).toMatchObject({ type: "h1", text: "A" })
    const held = Object.fromEntries(
      (await cacheRows(driver))
        .filter((row) => row.entity_id === "a")
        .map((row) => [row.key, row.hlc]),
    )
    expect(held).toEqual({
      deleted: eventStamp({ at: 2_000, seq: 1 } as RuminateEvent),
      type: encodeHlc({ ms: 2_500, counter: 0, device: "dev.new" }),
      text: eventStamp({ at: 2_000, seq: 1 } as RuminateEvent),
      notes_id: eventStamp({ at: 2_000, seq: 1 } as RuminateEvent),
    })
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 6, behind: 0, drift: [] })
    // An edit behind every stamp the row holds sets nothing.
    await append(alice, [stampedAt(n.edit("a", { text: "behind the row" }), 900)])
    expect(await nodeOf(driver, "a")).toMatchObject({ text: "A" })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("stamps what the row door derives with the replica's clock, after what the rows held", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.fast")
    // A device whose clock runs ahead of the replica's.
    await append(alice, [stampedAt(w.block("a", "text", "A"), 9_000_000)])
    await writeRows(
      alice,
      { nodes: [node("a", "text", "A, by an agent", 9_000_100)], links: [] },
      { actor: 111, origin: "mcp", device: "agent", now: 5_000 },
    )
    const log = await readLog(alice)
    expect(log[4].hlc).toBe(encodeHlc({ ms: 9_000_000, counter: 1, device: "server:mcp" }))
    expect((await nodeOf(driver, "a"))?.text).toBe("A, by an agent")
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })
})

describe("the per-key log", () => {
  /** A client's key events, as `opsToKeyEvents` would make them, stamped. */
  function keyWriter(device: string) {
    let n = 0
    let ms = 1_000
    const row = (
      entity: KeyEvent["entity"],
      entityId: string,
      action: KeyEvent["action"],
      key: string,
      value: unknown,
      at = ms,
    ): KeyEvent => ({
      id: `key_${device}_${(n += 1)}`,
      entity,
      entity_id: entityId,
      action,
      key,
      value,
      batch: `b_${device}`,
      device,
      at,
      hlc: encodeHlc({ ms: (ms += 1), counter: 0, device }),
      v: 2,
    })
    return {
      row,
      block: (id: string, props: Record<string, unknown>) => [
        row("block", id, "create", "", null),
        row("block", id, "set", "type", "image"),
        row("block", id, "set", "text", id),
        row("block", id, "set", "notes_id", "note"),
        ...Object.entries(props).map(([key, value]) =>
          row("block", id, "set", `props.${key}`, value),
        ),
      ],
      at: (when: number) => {
        ms = when
      },
    }
  }
  const client = (tenant: TenantDb, events: KeyEvent[], now = 5_000) =>
    appendClientKeyEvents(tenant, events, { actor: tenant.userId, origin: "replica", now })
  const keyRows = (driver: SqlDriver) =>
    driver.exec(
      "SELECT id, entity_id, action, key, value, event_id, event_seq FROM events_log " +
        "WHERE user_id = 111 ORDER BY seq",
    )

  it("every statement of the reconcile, the append and the migrations fits D1's compound SELECT limit", () => {
    // workerd caps a compound SELECT at five terms (SQLITE_LIMIT_COMPOUND_SELECT);
    // node:sqlite does not, so only this count stands between the suite and a
    // statement D1 refuses with "too many terms in compound SELECT".
    const terms = (sql: string) => sql.split(/\bUNION\b/i).length
    const ctx = { now: 1, appendId: "x", actor: 111, origin: "replica" as const, client: null }
    const w = writer()
    const events = expandLog([
      w.block("a", "image", "A"),
      w.edit("a", { props: '{"size":40}' }),
      w.link("note", "a", "a0"),
      w.view("v", "note", true),
    ])
    for (const statement of planKeyAppend(events, ctx)) {
      expect(terms(statement.sql)).toBeLessThanOrEqual(5)
    }
    for (const migration of [
      migration0028,
      migration0029,
      migration0030,
      migration0031,
      migration0032,
    ]) {
      for (const statement of migration.split(";")) {
        expect(terms(statement)).toBeLessThanOrEqual(5)
      }
    }
  })

  it("the migration's backfill and expandLog read an old log alike", async () => {
    const w = writer()
    const unicode = 'héllo — 日本語 🎉 "quoted" back\\slash'
    const old = [
      w.block("note", "note", "N", null),
      w.block("a", "image", "A"),
      w.edit("a", { props: '{"size":40,"align":"left"}' }),
      w.link("note", "a", "a0"),
      w.view("v1", "note", true),
      w.edit("a", { text: "A!", props: '{"align":"left","size":50,"nested":{"x":1},"bad key":1}' }),
      w.editView("v1", { pinned: false, stack: "[]" }),
      // The shapes a real log holds: a props patch that is an array, not an
      // object; odd keys; nulls; unicode; a very long value; keys reordered.
      w.edit("a", { props: '["not","an","object"]' }),
      w.edit("a", {
        props: JSON.stringify({
          "émoji🎉": 1,
          "": 2,
          "9starts": 3,
          "dotted.key": unicode,
          "d:2026-10-27": 4,
          gone: null,
          long: "x".repeat(20_000),
        }),
      }),
      w.edit("a", {
        props: JSON.stringify({
          long: "x".repeat(20_000),
          "d:2026-10-27": 4,
          "dotted.key": unicode,
        }),
      }),
      w.edit("a", { props: null }),
      w.remove("a"),
    ]
    const { driver } = await open()
    const placed = await insertOldEvents(driver, old)
    await driver.execScript(migration0028.slice(migration0028.indexOf("INSERT INTO events_log")))
    const byMigration = (await keyRows(driver)).map(
      (row) => `${row.id} ${row.action} ${row.key} ${row.value} ${row.event_seq}`,
    )
    const inTs = expandLog(placed).map(
      (row) =>
        `${row.id} ${row.action} ${row.key} ${JSON.stringify(row.value ?? null)} ${row.event_seq}`,
    )
    expect(byMigration).toEqual(inTs)
    expect(inTs).toContain('evt_tab-1_6#1 set props.nested {"x":1} 6')
    // An array is no object: every key is gone.
    expect(inTs).toContain("evt_tab-1_8#2 unset props.size null 8")
    expect(inTs).toContain(`evt_tab-1_9#1 set props.dotted.key ${JSON.stringify(unicode)} 9`)
    // The same keys in another order read as no change at all.
    expect(inTs.some((line) => line.startsWith("evt_tab-1_10#"))).toBe(false)
    expect(inTs).toContain("evt_tab-1_11#0 unset props.d:2026-10-27 null 11")
    expect(
      inTs.some(
        (line) => line.includes("bad key") || line.includes("émoji") || line.includes("9starts"),
      ),
    ).toBe(false)
  })

  it("lands a client's key events, projects per key, and verify passes", async () => {
    const { driver, alice } = await open()
    const dev = keyWriter("dev.a")
    const made = [...dev.block("note", {}), ...dev.block("a", { align: "left", size: 40 })]
    const landed = await client(alice, made)
    expect(landed.stale).toBe(0)
    expect(landed.seqs).toEqual(made.map((row, i) => [row.id, i + 1]))
    // Each row names its edit: the create's run.
    const log = await readLog(alice)
    expect(log.map((row) => row.event)).toEqual([
      ...made.slice(0, 4).map(() => made[0].id),
      ...made.slice(4).map(() => made[4].id),
    ])
    expect(await propsOf(driver, "a")).toEqual({ align: "left", size: 40 })
    expect(await keyRowsOf(driver, "a")).toEqual(['align="left"', "size=40"])
    // Ten rows of the log, ten of the cache: one per key set.
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 10, rows: 10, drift: [] })
    // A re-sent push appends nothing and answers the same seqs.
    const again = await client(alice, made)
    expect(again).toEqual({ appended: 0, stale: 0, seqs: landed.seqs })
  })

  it("two devices offline on two keys of one block both keep their change", async () => {
    const { driver, alice } = await open()
    const dev = keyWriter("dev.a")
    const phone = keyWriter("phone")
    await client(alice, [...dev.block("note", {}), ...dev.block("a", { align: "left", size: 40 })])
    // The phone sets the size at 2000 and pushes first; the laptop set the
    // alignment at 1500 and pushes after.
    phone.at(2_000)
    await client(alice, [phone.row("block", "a", "set", "props.size", 80)])
    dev.at(1_500)
    const late = await client(alice, [dev.row("block", "a", "set", "props.align", "right")])
    expect(late.stale).toBe(0)
    expect(await propsOf(driver, "a")).toEqual({ align: "right", size: 80 })
    expect(await verifyLog(alice)).toMatchObject({ ok: true, drift: [] })
    // Each key holds the stamp of the event that set it.
    const size = (await cacheRows(driver)).find(
      (row) => row.entity_id === "a" && row.key === "props.size",
    )
    expect(size?.hlc).toBe(encodeHlc({ ms: 2_001, counter: 0, device: "phone" }))
  })

  it("an unset is a tombstone of the key: an older set that arrives later loses to it", async () => {
    const { driver, alice } = await open()
    const dev = keyWriter("dev.a")
    const phone = keyWriter("phone")
    await client(alice, [...dev.block("note", {}), ...dev.block("a", { size: 40 })])
    dev.at(3_000)
    await client(alice, [dev.row("block", "a", "unset", "props.size", null)])
    phone.at(2_000)
    const late = await client(alice, [phone.row("block", "a", "set", "props.size", 50)])
    expect(late.stale).toBe(1)
    expect(await propsRaw(driver, "a")).toBeNull()
    expect(await keyRowsOf(driver, "a")).toEqual(["size=null"])
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("the row door and the key door write the same log, and verify passes with both", async () => {
    const { driver, alice } = await open()
    await corpusPut(
      alice,
      {
        nodes: [
          node("note", "note", "N", 100, { notes_id: undefined }),
          node("a", "image", "A", 100, { props: '{"size":40,"align":"left"}' }),
        ],
        links: [child("note", "a", "a0", 100)],
      },
      1_000,
    )
    const firstPut = (await readLog(alice)).at(-1)?.seq as number
    // An MCP-shaped write of the whole props reads as the keys that changed.
    await corpusPut(
      alice,
      { nodes: [node("a", "image", "A", 200, { props: '{"align":"left","size":60}' })], links: [] },
      2_000,
    )
    const rows = await keyRows(driver)
    expect(
      rows.filter((row) => row.entity_id === "a").map((row) => `${row.action} ${row.key}`),
    ).toEqual([
      "create ",
      "set type",
      "set text",
      "set notes_id",
      "set props.align",
      "set props.size",
      "set props.size",
    ])
    // Then a key event on top, from a client.
    const dev = keyWriter("dev.a")
    dev.at(9_000)
    await client(alice, [dev.row("block", "a", "set", "props.align", "right")])
    expect(await propsOf(driver, "a")).toEqual({ align: "right", size: 60 })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
    // A restore reads per key too: back to the first write's props.
    await corpusPut(
      alice,
      {
        nodes: [
          node("a", "image", "A", 300, { props: '{"align":"right","size":60}', deleted_at: 300 }),
        ],
        links: [],
      },
      10_000,
    )
    const restored = await restoreSubtree(alice, "a", firstPut, {
      actor: 111,
      origin: "replica",
      now: 11_000,
    })
    expect(restored.events).toBe(1)
    expect(await propsOf(driver, "a")).toEqual({ align: "left", size: 40 })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("migration 0032's backfill is the fold by stamp: the same cache the Worker keeps", async () => {
    const { driver, alice } = await open()
    // Every door and every shape: rows (derived stamps), old-shaped events
    // with and without a stamp, key events; sets, unsets, a delete with a
    // value and one without, a restore, a link unlinked and re-linked.
    await corpusPut(
      alice,
      {
        nodes: [
          node("note", "note", "N", 100, { notes_id: undefined }),
          node("a", "image", "A", 100, { props: '{"size":40,"align":"left"}' }),
          node("b", "text", "B", 100),
        ],
        links: [child("note", "a", "a0", 100), child("note", "b", "a1", 100)],
      },
      1_000,
    )
    const w = writer("dev.old")
    await append(alice, [
      stampedAt(w.edit("a", { props: '{"size":50}' }), 2_000),
      w.remove("b"),
      w.unlink("note", "b"),
    ])
    await append(alice, [stampedAt(w.link("note", "b", "a2"), 3_000)])
    const dev = keyWriter("dev.key")
    dev.at(4_000)
    await client(alice, [
      dev.row("block", "a", "unset", "props.size", null),
      dev.row("block", "a", "set", "text", "A!"),
      dev.row("block", "b", "restore", "", null),
      dev.row("block", "b", "delete", "", 4_500),
    ])
    const kept = await cacheRows(driver)
    expect(kept.length).toBeGreaterThan(20)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, drift: [] })

    // The cache gone, the backfill statement of 0032 run again by hand:
    // the rows come back as they were, register for register.
    await driver.exec("DELETE FROM events_log_cache WHERE user_id = 111")
    const backfill = migration0032.slice(migration0032.indexOf("INSERT INTO events_log_cache"))
    await driver.execScript(backfill)
    expect(await cacheRows(driver)).toEqual(kept)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, drift: [], behind: 0 })
    // …and it is the TypeScript fold, row for row.
    const fold = foldEventsToCache(await readLog(alice))
    for (const row of kept) {
      const want = fold.get(cacheRowKey(row.entity, row.entity_id, row.key))
      expect(want, `${row.entity} ${row.entity_id} ${row.key}`).toMatchObject({
        value: row.value,
        hlc: row.hlc,
        seq: row.seq,
        updated_at: row.updated_at,
      })
    }
    expect(fold.size).toBe(kept.length)
  })

  it("every write carries the watermark, and projects what was appended around the Worker", async () => {
    const { driver, alice } = await open()
    const dev = keyWriter("dev.a")
    await client(alice, [...dev.block("note", {}), ...dev.block("a", { size: 40 })])
    const watermark = async () =>
      (await driver.exec("SELECT value FROM meta WHERE user_id = 111 AND key = 'cache_seq'"))[0]
        ?.value
    expect(await watermark()).toBe("9")
    // A row written into the log around the Worker: a hand-run statement.
    await driver.exec(
      "INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, batch, " +
        "origin, device, actor, at, received_at, append, hlc) " +
        "VALUES (111, 10, 'by_hand', 'block', 'a', 'set', 'text', '\"by hand\"', 'b', 'system', " +
        "'console', 111, 9000, 9000, 'hand', '000000000009000-0000-console')",
    )
    expect(await verifyLog(alice)).toMatchObject({ ok: false, behind: 1 })
    expect(await nodeOf(driver, "a")).toMatchObject({ text: "a" })
    dev.at(9_500)
    await client(alice, [dev.row("block", "a", "set", "props.align", "left")])
    expect(await nodeOf(driver, "a")).toMatchObject({ text: "by hand", seq: 11 })
    expect(await watermark()).toBe("11")
    expect(await verifyLog(alice)).toMatchObject({ ok: true, behind: 0, drift: [] })
  })

  it("cuts an append into runs that fit without parting a create from its keys", async () => {
    const { driver, alice } = await open()
    const dev = keyWriter("dev.a")
    const events = [
      ...dev.block("note", {}),
      ...dev.block("a", { size: 40 }),
      dev.row("link", "note|a|child", "create", "", null),
      dev.row("link", "note|a|child", "set", "source_id", "note"),
      dev.row("link", "note|a|child", "set", "destination_id", "a"),
      dev.row("link", "note|a|child", "set", "kind", "child"),
      dev.row("link", "note|a|child", "set", "sort_key", "a0"),
    ]
    // Each row names its edit, as `appendKeyEvents` has it.
    const edits = editsOf(events)
    const named = events.map((event) => ({ ...event, event: edits.get(event.id) }))
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    // A limit so small every edit is its own run: the hardest case for order.
    const statements = planKeyAppend(named, ctx, 1)
    expect(statements).toHaveLength(2 * 3 + 1)
    await alice.includingDeleted().batch(statements)
    expect(await linkOf(driver, "note", "a")).toMatchObject({ sort_key: "a0" })
    expect((await readLog(alice)).map((row) => row.seq)).toEqual(events.map((_, i) => i + 1))
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 14 })
  })

  it("serves the per-key log by its own seq, one entity's too", async () => {
    const { alice } = await open()
    const dev = keyWriter("dev.a")
    await client(alice, [...dev.block("note", {}), ...dev.block("a", { size: 40 })])
    const all = await readLog(alice)
    expect(all.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(all[0]).toMatchObject({ origin: "replica", actor: 111, event: "key_dev.a_1" })
    expect(all[0].event_seq).toBeUndefined()
    const some = await readKeyEvents(alice, { since: 4, entity: "block", entityId: "a" })
    expect(some.map((row) => `${row.action} ${row.key}`)).toEqual([
      "create ",
      "set type",
      "set text",
      "set notes_id",
      "set props.size",
    ])
    // The log began with one append: a moment inside it is answered as its end.
    const past = await corpusAt(alice, { seq: 1 })
    expect(past.seq).toBe(9)
    expect(past.nodes.map((row) => row.id).sort()).toEqual(["a", "note"])
    expect(past.nodes.find((row) => row.id === "a")?.props).toBe('{"size":40}')
  })
})

// -----------------------------------------------------------------------------
// Nothing reads the old tables (migrations/0032)
// -----------------------------------------------------------------------------

describe("the cache", () => {
  it("no statement in the Worker or the browser store reads nodes, link or delta_mat_values", () => {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
      .process
    const { readdirSync, readFileSync } = proc?.getBuiltinModule?.("node:fs") as {
      readdirSync: (
        path: string,
        options: { withFileTypes: true },
      ) => { name: string; isDirectory(): boolean }[]
      readFileSync: (path: string, encoding: "utf8") => string
    }
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(path)
        else if (
          /\.tsx?$/.test(path) &&
          !/\.test\.tsx?$|test-support|sqlite-test-driver/.test(path)
        )
          files.push(path)
      }
    }
    walk("worker")
    walk("src/data")
    const offenders: string[] = []
    for (const path of files) {
      // The code, not its comments: a comment names a table in prose.
      const text = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
      for (const literal of text.match(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g) ?? []) {
        if (/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:nodes|link|delta_mat_values)\b/.test(literal)) {
          offenders.push(`${path}: ${literal.slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
