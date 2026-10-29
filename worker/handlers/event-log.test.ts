// tenant-guard: exempt — raw reads below prove what the planned statements
// wrote, raw writes stand in for a writer that went AROUND the log, and the
// trigger specimens are meant to be refused.
import { describe, expect, it } from "vitest"
import {
  EVENT_VERSION,
  eventStamp,
  linkEntityId,
  projectRows,
  toViewRows,
  type RuminateEvent,
} from "../../src/data/events"
import { encodeHlc } from "../../src/data/hlc"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import migration0028 from "../../migrations/0028_events_log.sql?raw"
import migration0029 from "../../migrations/0029_backfill_delta_mat_values.sql?raw"
import migration0030 from "../../migrations/0030_genesis_unlogged_rows.sql?raw"
import {
  assembleLogState,
  assembleStamped,
  editsOf,
  expandLog,
  foldKeys,
  foldKeysByStamp,
  keyEventStamp,
  type KeyEvent,
} from "../../src/data/key-events"
import { nodePropsSql } from "../../src/data/node-props-sql"
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
import { corpusPullFull, corpusPullSince, corpusPut } from "./replica-corpus"
import type { LinkRow, NodeRow, ViewRow } from "./replica-payload"
import { createTenantTestDriver } from "./sqlite-test-driver"

const identityOf = (id: number) => ({ id, login: `u${id}`, name: null })

async function open(): Promise<{ driver: SqlDriver; alice: TenantDb; bob: TenantDb }> {
  const driver = await createTenantTestDriver()
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

/** A block's props as every reader of the Worker reads them: from its keys. */
const PROPS_OF = nodePropsSql("nodes.id", "tenant").replace(/:tenant\b/g, "111")
const propsRaw = async (driver: SqlDriver, id: string) =>
  (
    await driver.exec(`SELECT ${PROPS_OF} AS props FROM nodes WHERE user_id = 111 AND id = ?1`, [
      id,
    ])
  )[0]?.props as string | null
const propsOf = async (driver: SqlDriver, id: string) =>
  JSON.parse(String(await propsRaw(driver, id)))

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
  it("projects an append into nodes, link and views — and the fold agrees with the tables", async () => {
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
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 28, rejected: 0 })

    const [a] = await driver.exec(
      `SELECT nodes.*, ${PROPS_OF} AS props FROM nodes WHERE user_id = 111 AND id = 'a'`,
    )
    expect(a).toMatchObject({ text: "Heading, edited", type: "text", props: null, seq: 28 })
    expect(a.deleted_at).not.toBeNull()
    // The column stays as a mirror of the keys, written beside every change.
    expect(await verifyLog(alice)).toMatchObject({ mirror: [] })
  })

  it("plans the same eight statements for one event or three hundred", () => {
    const w = writer()
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    const many = Array.from({ length: 300 }, (_, i) => w.block(`blk_${i}`, "text", `Block ${i}`))
    expect(planKeyAppend(expandLog([w.block("a", "text", "A")]), ctx)).toHaveLength(8)
    expect(planKeyAppend(expandLog(many), ctx)).toHaveLength(8)
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
    expect(statements).toHaveLength(8 * events.length)
    await alice.includingDeleted().batch(statements)
    expect((await readLog(alice)).map((row) => row.seq)).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1),
    )
    const rows = await driver.exec(
      "SELECT id, text, seq, deleted_at IS NOT NULL AS dead FROM nodes WHERE user_id = 111 ORDER BY id",
    )
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
      "SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM nodes WHERE user_id = 111 AND id LIKE 'blk_%'",
    )
    // Four rows per block (its create, type, text and note id): each row
    // takes the seq of its last.
    expect([n, lo, hi]).toEqual([300, 8, 1204])
  })

  it("a re-sent append adds nothing and regresses nothing", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const first = [w.block("a", "text", "first")]
    await append(alice, first)
    await append(alice, [w.edit("a", { text: "second" })])
    await append(alice, first)

    expect(await readLog(alice)).toHaveLength(5)
    const [row] = await driver.exec("SELECT text, seq FROM nodes WHERE user_id = 111")
    expect(row).toEqual({ text: "second", seq: 5 })
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
        const corpus = /^(?:SEARCH|SCAN) (?:nodes|link|views|delta_mat_values)\b/.test(detail)
        if (!corpus) continue
        expect(detail, sql.slice(0, 40)).toMatch(/^SEARCH/)
        expect(detail, sql.slice(0, 40)).not.toMatch(/\(user_id=\?\)$/)
      }
      // …and an UPDATE is driven FROM its changes, one seek each — not from
      // the table, re-scanning the JSON for every row it finds (n² reads,
      // which returns the right rows and which D1 bills for).
      if (/UPDATE (?:nodes|link|views)\b[\s\S]*\bFROM j\b/.test(sql)) {
        const loops = details.filter((detail) =>
          /^(?:SCAN|SEARCH) (?:j|nodes|link|views)\b/.test(detail),
        )
        expect(loops[0], sql.slice(0, 60)).toMatch(/^SCAN j\b/)
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

  it("keeps the rows a pull serves exactly as the row planner left them", async () => {
    const { alice } = await open()
    await corpusPut(alice, {
      nodes: [node("note", "note", "N", 100, { notes_id: undefined }), node("a", "text", "A", 110)],
      links: [child("note", "a", "a0", 110)],
      deleteNodes: [],
    })
    await corpusPut(alice, { nodes: [], links: [], deleteNodes: ["a"] }, 900)
    const pulled = await corpusPullSince(alice, 0)
    expect(pulled.cursor).toBe("14")
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
    const pulled = await corpusPullFull(alice)
    expect(pulled.nodes.find((row) => row.id === "a")?.props).toBe(
      '{"align":"left","nested":{"x":[1]},"size":40}',
    )
    expect((pulled.delta_mat_values ?? []).map((row) => `${row.key}=${row.value}`).sort()).toEqual([
      'align="left"',
      'nested={"x":[1]}',
      "size=40",
    ])
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
    // The mirror column says the same, for a build that reads it.
    expect(await driver.exec("SELECT props FROM nodes WHERE user_id = 111 AND id = 'a'")).toEqual([
      { props: '{"nested":{"x":[1]},"size":50}' },
    ])
    const since = await corpusPullSince(alice, Number(pulled.cursor))
    expect(since.nodes.map((row) => [row.id, row.props])).toEqual([
      ["a", '{"nested":{"x":[1]},"size":50}'],
    ])
    expect((since.delta_mat_values ?? []).map((row) => `${row.key}=${row.value}`).sort()).toEqual([
      "align=null",
      "size=50",
    ])
    // Every key gone: the column reads as none.
    await corpusPut(
      alice,
      { nodes: [node("a", "image", "A", 300, { props: null })], links: [] },
      3_000,
    )
    expect(await propsRaw(driver, "a")).toBeNull()
    expect(
      await driver.exec("SELECT key, value FROM delta_mat_values WHERE user_id = 111 ORDER BY key"),
    ).toEqual([
      { key: "align", value: null },
      { key: "nested", value: null },
      { key: "size", value: null },
    ])
    expect(await verifyLog(alice)).toMatchObject({
      ok: true,
      deltaMatValues: [],
      mirror: [],
      drift: { nodes: [] },
    })
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
    const { alice } = await open()
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
    const pulled = await corpusPullSince(alice, 0)
    expect(pulled.nodes.map((row) => [row.id, row.text, row.seq])).toEqual([
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
    const [row] = await driver.exec("SELECT type, text FROM nodes WHERE user_id = 111")
    expect(row).toEqual({ type: "h1", text: "A, after" })
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
    const { alice } = await open()
    const w = writer("dev.tab")
    const made = [w.block("a", "text", "A"), w.edit("a", { text: "A!" })]
    const first = await client(alice, made)
    // Something else landed in between; the re-send must not lay the old
    // net change over it.
    await corpusPut(alice, { nodes: [node("a", "text", "A, elsewhere", 9_000)], links: [] })
    const second = await client(alice, made)
    expect(second).toEqual({ appended: 0, stale: 0, seqs: first.seqs })
    const pulled = await corpusPullSince(alice, 0)
    expect(pulled.nodes[0].text).toBe("A, elsewhere")
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

  it("records every row the log has no event for, once, as a snapshot", async () => {
    const { driver, alice } = await open()
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
    // Each snapshotted row takes the seq of its last row, under one stamp —
    // the one the row derives without stamps — on every row of it.
    const seqs = await driver.exec(
      "SELECT id, seq, stamps FROM nodes WHERE user_id = 111 ORDER BY id",
    )
    expect(seqs).toEqual([
      { id: "new", seq: 25, stamps: expect.any(String) },
      { id: "old-1", seq: 5, stamps: null },
      { id: "old-2", seq: 9, stamps: null },
    ])
    expect(new Set(log.slice(0, 5).map((row) => row.hlc))).toEqual(
      new Set([eventStamp({ at: 1, seq: 5 } as RuminateEvent)]),
    )
    expect(await driver.exec("SELECT seq FROM link WHERE user_id = 111")).toEqual([{ seq: 14 }])
    expect(await driver.exec("SELECT seq FROM views WHERE user_id = 111")).toEqual([{ seq: 21 }])
    expect(await driver.exec("SELECT hlc, seq FROM delta_mat_values WHERE user_id = 111")).toEqual([
      { hlc: eventStamp({ at: 1, seq: 5 } as RuminateEvent), seq: 5 },
    ])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 25 })
  })

  it("runs once: a row written around the log after it is not recorded by a write", async () => {
    const { driver, alice } = await open()
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
    expect((await verifyLog(alice)).ok).toBe(true)
  })

  it("verify names drift it cannot heal: a row changed without taking a sequence", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [] })
    await driver.exec("UPDATE nodes SET text = 'edited in the console' WHERE user_id = 111")
    const verdict = await verifyLog(alice)
    expect(verdict.ok).toBe(false)
    expect(verdict.drift.nodes).toEqual(["a"])
  })

  it("verify names a key changed without taking a sequence", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, {
      nodes: [node("a", "image", "A", 100, { props: '{"size":40}' })],
      links: [],
    })
    await driver.exec("UPDATE delta_mat_values SET value = '50' WHERE user_id = 111")
    const verdict = await verifyLog(alice)
    expect(verdict.ok).toBe(false)
    expect(verdict.deltaMatValues).toEqual(["a size"])
    expect(verdict.drift.nodes).toEqual(["a"])
    // …and the mirror column no longer says what the keys say.
    expect(verdict.mirror).toEqual(["a"])
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
    const wiped = await driver.exec(
      "SELECT id, text FROM nodes WHERE user_id = 111 AND id IN ('call', 'b1')",
    )
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

    const after = await driver.exec(
      "SELECT id, type, text, deleted_at FROM nodes WHERE user_id = 111 AND id IN ('call', 'b1', 'b2') ORDER BY id",
    )
    expect(after).toEqual([
      { id: "b1", type: "ul", text: first, deleted_at: null },
      { id: "b2", type: "ul", text: second, deleted_at: null },
      { id: "call", type: "h1", text: "Call notes", deleted_at: null },
    ])
    const live = await driver.exec(
      "SELECT source_id || '>' || destination_id AS edge FROM link WHERE user_id = 111 AND deleted_at IS NULL ORDER BY edge",
    )
    expect(live.map((row) => row.edge)).toEqual(
      expect.arrayContaining(["section>call", "call>b1", "call>b2"]),
    )
    // The restore is in the log as what it was — nothing was rewound — and
    // the rows it touched carry fresh seqs, so every device pulls them.
    const tail = (await readLog(alice)).filter((row) => row.seq > afterWipe)
    expect(tail.every((row) => row.cause === "restore")).toBe(true)
    expect(
      tail
        .filter((row) => row.key === "")
        .every((row) => row.action === "restore" && row.ref_seq === before),
    ).toBe(true)
    expect((await corpusPullSince(alice, afterWipe)).nodes.map((row) => row.id).sort()).toEqual([
      "b1",
      "b2",
      "call",
    ])
    expect((await verifyLog(alice)).ok).toBe(true)
    // …and restoring again is nothing: it is already there.
    expect(
      (await restoreSubtree(alice, "call", before, { actor: 111, origin: "system" })).events,
    ).toBe(0)
  })
})

describe("by stamp", () => {
  /** The projections as compared across orders: everything but `seq`, which
   * is the order the events arrived in, and `legacy`. */
  const tables = async (driver: SqlDriver) => {
    const read = async (sql: string) =>
      (await driver.exec(sql)).map((row): Record<string, unknown> => {
        const { legacy: _, ...stamps } = JSON.parse(String(row.stamps)) as Record<string, unknown>
        return { ...row, stamps }
      })
    return {
      nodes: await read(
        `SELECT id, type, text, ${PROPS_OF} AS props, updated_at, deleted_at, notes_id, stamps ` +
          "FROM nodes WHERE user_id = 111 ORDER BY id",
      ),
      links: await read(
        "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, stamps " +
          "FROM link WHERE user_id = 111 ORDER BY source_id, destination_id",
      ),
      views: await read(
        "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, stamps " +
          "FROM views WHERE user_id = 111 ORDER BY id",
      ),
    }
  }

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
    const results = []
    for (const order of orders) {
      const { driver, alice } = await open()
      for (const events of order) await append(alice, events)
      expect(await verifyLog(alice)).toMatchObject({ ok: true, rejected: 0 })
      results.push(await tables(driver))
    }
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])

    const block = results[0].nodes.find((row) => row.id === "a")
    expect(block).toMatchObject({
      type: "h1",
      text: "A, by a",
      props: null,
    })
    expect(block?.deleted_at).not.toBeNull()
    expect(results[0].links[0]).toMatchObject({ sort_key: "a5" })
    expect(results[0].links[0].deleted_at).not.toBeNull()
    expect(results[0].views[0]).toMatchObject({ pinned: 0, filter: "type:todo" })
  })

  it("keeps both of two devices' changes to two fields of one block", async () => {
    const { driver, alice } = await open()
    const a = writer("dev.a")
    const b = writer("dev.b")
    await append(alice, [stampedAt(a.block("a", "text", "A"), 1_000)])
    await append(alice, [stampedAt(a.edit("a", { text: "A, by a" }), 2_000)])
    // B changed the type before A's edit, and its push arrives after it.
    await append(alice, [stampedAt(b.edit("a", { type: "h1" }), 1_500)])
    const [row] = await driver.exec("SELECT type, text, seq FROM nodes WHERE user_id = 111")
    expect(row).toEqual({ type: "h1", text: "A, by a", seq: 6 })
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
    const before = await driver.exec("SELECT * FROM nodes WHERE user_id = 111")
    await append(alice, [...first, ...edit])
    expect(await driver.exec("SELECT * FROM nodes WHERE user_id = 111")).toEqual(before)
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
    const [row] = await driver.exec("SELECT stamps FROM nodes WHERE user_id = 111 AND id = 'blk_9'")
    // Each register's stamp is its own row's: the create's, the type's, the
    // text's, the note id's, in the order they were appended.
    const at = (seq: number) => `001792540800123-0000-seq:${String(seq).padStart(15, "0")}`
    expect(keyEventStamp(log[39])).toBe(at(40))
    expect(JSON.parse(String(row.stamps))).toEqual({
      alive: at(37),
      type: at(38),
      text: at(39),
      notes_id: at(40),
      props: at(37),
    })
  })

  it("keeps what the old rule made of a row from before stamps, and resolves by stamp from there", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.old")
    // Folded by seq, as the projection was before 0025: an edit from a clock
    // that ran behind still landed. By stamp it would not have. The rows are
    // the old log's, mirrored per key by 0028 (`event_seq`).
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
    await driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, updated_at, notes_id, seq) " +
        "VALUES (111, 'a', 'text', 'by the old rule', 1000, 'note', 2)",
    )
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 5 })

    // Each field of the row resolves by the stamp of its last event: (1000, seq 2).
    const n = writer("dev.new")
    await append(alice, [
      stampedAt(n.edit("a", { type: "h1" }), 1_500),
      stampedAt(n.edit("a", { text: "behind the row" }), 900),
    ])
    const [row] = await driver.exec("SELECT type, text, stamps FROM nodes WHERE user_id = 111")
    expect(row).toMatchObject({ type: "h1", text: "by the old rule" })
    const held = eventStamp({ at: 1_000, seq: 2 } as RuminateEvent)
    expect(JSON.parse(String(row.stamps))).toEqual({
      type: encodeHlc({ ms: 1_500, counter: 0, device: "dev.new" }),
      text: held,
      props: held,
      notes_id: held,
      alive: held,
      legacy: 2,
    })
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 7 })
  })

  it("stamps what the row door derives with the replica's clock, after what the rows held", async () => {
    const { alice } = await open()
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
    const pulled = await corpusPullSince(alice, 0)
    expect(pulled.nodes[0].text).toBe("A, by an agent")
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })
})

describe("a view's stack (migrations/0027)", () => {
  const viewRow = (at: number, extra: Partial<ViewRow> = {}): ViewRow => ({
    id: "v",
    root_id: "note",
    filter: null,
    sort: null,
    pinned: true,
    sort_key: null,
    updated_at: at,
    ...extra,
  })
  const stackOf = async (driver: SqlDriver) =>
    (await driver.exec("SELECT stack FROM views WHERE user_id = 111 AND id = 'v'"))[0]?.stack

  it("is set by an update, kept by an update that does not name it, and pulled", async () => {
    const { driver, alice } = await open()
    const w = writer()
    // A create as every client before the field writes it: no `stack`.
    await append(alice, [w.view("v", "note", true)])
    expect(await stackOf(driver)).toBeNull()
    await append(alice, [w.editView("v", { stack: "corpus_root:tasks" })])
    // An older client changes another field and says nothing of the stack.
    await append(alice, [w.editView("v", { filter: "type:todo" })])
    expect(await stackOf(driver)).toBe("corpus_root:tasks")

    const pulled = await corpusPullSince(alice, 0)
    expect(pulled.views[0]).toMatchObject({ filter: "type:todo", stack: "corpus_root:tasks" })
    expect(await verifyLog(alice)).toMatchObject({ ok: true, rejected: 0 })

    await append(alice, [w.editView("v", { stack: null })])
    expect(await stackOf(driver)).toBeNull()
    expect((await corpusPullSince(alice, 0)).views[0]).not.toHaveProperty("stack")
    expect(await verifyLog(alice)).toMatchObject({ ok: true, rejected: 0 })
  })

  it("is kept by a row pushed without it, and cleared by a row that says null", async () => {
    const { driver, alice } = await open()
    const ctx = { actor: 111, origin: "replica" as const, device: "tab", now: 5_000 }
    await writeRows(alice, { nodes: [], links: [], views: [viewRow(1_000, { stack: "a.b" })] }, ctx)
    expect(await stackOf(driver)).toBe("a.b")
    // A client that predates 0027 pushes the row it holds, without a stack.
    await writeRows(
      alice,
      { nodes: [], links: [], views: [viewRow(2_000, { filter: "type:todo" })] },
      ctx,
    )
    expect(await stackOf(driver)).toBe("a.b")
    const update = (await readLog(alice)).at(-1)!
    expect(update).toMatchObject({ action: "set", key: "filter", value: "type:todo" })
    await writeRows(alice, { nodes: [], links: [], views: [viewRow(3_000, { stack: null })] }, ctx)
    expect(await stackOf(driver)).toBeNull()
    expect(await verifyLog(alice)).toMatchObject({ ok: true, rejected: 0 })
  })

  it("is set on a row from before the field by any event that names it", async () => {
    const { driver, alice } = await open()
    const a = writer("dev.a")
    await append(alice, [stampedAt(a.view("v", "note", true), 5_000)])
    // The stamps a row projected before 0027 holds: none for `stack`.
    await driver.exec(
      "UPDATE views SET stamps = json_remove(stamps, '$.stack') WHERE user_id = 111 AND id = 'v'",
    )
    // Behind every stamp the row holds, but the first to name the stack.
    const b = writer("dev.b")
    await append(alice, [stampedAt(b.editView("v", { stack: "x", filter: "old" }), 4_000)])
    const [row] = await driver.exec(
      "SELECT filter, stack, stamps FROM views WHERE user_id = 111 AND id = 'v'",
    )
    expect(row).toMatchObject({ filter: null, stack: "x" })
    expect(JSON.parse(String(row.stamps)).stack).toBe(
      encodeHlc({ ms: 4_000, counter: 0, device: "dev.b" }),
    )
    expect(await verifyLog(alice)).toMatchObject({ ok: true, rejected: 0 })
  })

  it("lands the same in any order, and the client's fold agrees with the tables", async () => {
    const a = writer("dev.a")
    const b = writer("dev.b")
    const create = [stampedAt(a.view("v", "note", true), 1_000)]
    const edits = [
      stampedAt(a.editView("v", { stack: "by.a" }), 3_000),
      stampedAt(b.editView("v", { stack: "by.b", sort: "text:asc" }), 2_000),
      stampedAt(b.editView("v", { filter: "type:todo" }), 4_000),
    ]
    const results = []
    for (const order of [edits, [...edits].reverse()]) {
      const { driver, alice } = await open()
      await append(alice, create)
      for (const event of order) await append(alice, [event])
      expect(await verifyLog(alice)).toMatchObject({ ok: true, rejected: 0 })
      const views = (await corpusPullSince(alice, 0)).views
      const folded = toViewRows(assembleStamped(foldKeysByStamp(await readLog(alice))))
      expect(folded.map(({ seq: _, ...row }) => row)).toEqual(
        views.map(({ seq: _, ...row }) => row),
      )
      results.push(
        await driver.exec("SELECT filter, sort, stack FROM views WHERE user_id = 111 AND id = 'v'"),
      )
    }
    expect(results[0]).toEqual([{ filter: "type:todo", sort: "text:asc", stack: "by.a" }])
    expect(results[1]).toEqual(results[0])
  })
})

// -----------------------------------------------------------------------------
// The per-key log (docs/event-sourcing.md, "Per-key events"; migrations/0028)
// -----------------------------------------------------------------------------

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
    for (const migration of [migration0028, migration0029, migration0030]) {
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
    expect(
      await driver.exec("SELECT key, value FROM delta_mat_values WHERE user_id = 111 ORDER BY key"),
    ).toEqual([
      { key: "align", value: '"left"' },
      { key: "size", value: "40" },
    ])
    expect(await verifyLog(alice)).toMatchObject({
      ok: true,
      keyEvents: 10,
      rows: { nodes: 2, deltaMatValues: 2 },
      deltaMatValues: [],
    })
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
    const verdict = await verifyLog(alice)
    expect(verdict).toMatchObject({ ok: true, deltaMatValues: [] })
    // The row's `props` stamp is the highest of its keys'.
    const [row] = await driver.exec("SELECT stamps FROM nodes WHERE user_id = 111 AND id = 'a'")
    expect(JSON.parse(String(row.stamps)).props).toBe(
      encodeHlc({ ms: 2_001, counter: 0, device: "phone" }),
    )
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
    expect(
      await driver.exec(
        "SELECT key, value FROM delta_mat_values WHERE user_id = 111 AND block_id = 'a'",
      ),
    ).toEqual([{ key: "size", value: null }])
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

  it("seeds a tenant's per-key stamps once from the fold, where the migration left one stamp per block", async () => {
    const { driver, alice } = await open()
    const w = writer()
    // A tenant as the cut-over finds it when it wrote nothing since 0028: its
    // history mirrored in the per-key log, a row projected by the old rule
    // with no stamps, and its keys backfilled by 0029 at the row's stamp.
    const old = [
      w.block("note", "note", "N", null),
      w.block("a", "image", "A"),
      w.edit("a", { props: '{"size":40}' }),
      w.edit("a", { props: '{"size":40,"align":"left"}' }),
    ]
    const placed = old.map((event, i) => ({ ...event, seq: i + 1 }))
    for (const [i, row] of expandLog(placed).entries()) {
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
    const at = placed[3].at
    await driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, updated_at, notes_id, seq) " +
        "VALUES (111, 'note', 'note', 'N', ?1, NULL, 1), (111, 'a', 'image', 'A', ?2, 'note', 4)",
      [placed[0].at, at],
    )
    const rowStamp = eventStamp({ at, seq: 4 } as RuminateEvent)
    await driver.exec(
      "INSERT INTO delta_mat_values (user_id, block_id, key, value, hlc, seq, updated_at) " +
        "VALUES (111, 'a', 'size', '40', ?1, 4, ?2), (111, 'a', 'align', '\"left\"', ?1, 4, ?2)",
      [rowStamp, at],
    )
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 10, deltaMatValues: [] })
    expect(
      await driver.exec(
        "SELECT value FROM meta WHERE user_id = 111 AND key = 'delta_mat_values_seeded'",
      ),
    ).toHaveLength(1)
    // A later key event projects from the keys, and the row's other keys
    // keep the stamp the row derives.
    const dev = keyWriter("dev.a")
    dev.at(9_000)
    await client(alice, [dev.row("block", "a", "unset", "props.size", null)])
    expect(await propsOf(driver, "a")).toEqual({ align: "left" })
    expect(
      await driver.exec(
        "SELECT key, value, hlc FROM delta_mat_values WHERE user_id = 111 ORDER BY key",
      ),
    ).toEqual([
      { key: "align", value: '"left"', hlc: rowStamp },
      { key: "size", value: null, hlc: encodeHlc({ ms: 9_001, counter: 0, device: "dev.a" }) },
    ])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, deltaMatValues: [] })
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
    expect(statements).toHaveLength(8 * 3)
    await alice.includingDeleted().batch(statements)
    expect(await driver.exec("SELECT sort_key FROM link WHERE user_id = 111")).toEqual([
      { sort_key: "a0" },
    ])
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
// Nothing reads `nodes.props` (migrations/0029)
// -----------------------------------------------------------------------------

describe("the cut-over", () => {
  it("no statement in the Worker or the browser store reads the props column of nodes", () => {
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
      // The code, not its comments: a comment names the column in prose.
      const text = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
      // Every string literal: a column named as `<alias>.props`, or `props`
      // bare in a column list, is a read of the column — unless it is the
      // mirror's write (an insert or update of `nodes`). `AS props` (the
      // derived column), `'props'` (a stamps key) and `props.` (a key
      // register) are not.
      for (const literal of text.match(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g) ?? []) {
        if (/INSERT INTO nodes \(|UPDATE nodes SET|props = CASE WHEN|excluded\.props/.test(literal))
          continue
        if (/\b[a-z_]+\.props\b/.test(literal) || /[(,]\s*props\s*[,)]/.test(literal)) {
          offenders.push(`${path}: ${literal.slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
