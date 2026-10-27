// tenant-guard: exempt — raw reads below prove what the planned statements
// wrote, raw writes stand in for a writer that went AROUND the log, and the
// trigger specimens are meant to be refused.
import { describe, expect, it } from "vitest"
import {
  EVENT_VERSION,
  eventStamp,
  fold,
  foldByStamp,
  linkEntityId,
  projectRows,
  toViewRows,
  type RuminateEvent,
} from "../../src/data/events"
import { encodeHlc } from "../../src/data/hlc"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import migration0028 from "../../migrations/0028_events_log.sql?raw"
import { expandLog, type KeyEvent } from "../../src/data/key-events"
import {
  appendClientEvents,
  appendClientKeyEvents,
  appendEvents,
  corpusAt,
  planEventAppend,
  planLogFill,
  planReconcile,
  readEvents,
  readKeyEvents,
  restoreSubtree,
  setEventLogRollup,
  verifyLog,
  writeRows,
} from "./event-log"
import { corpusPullSince, corpusPut } from "./replica-corpus"
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

/** A writer of EVENTS: mints ids and stamps a clock that ticks once per event. */
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

/** The shape of the log, tersely: `seq entity.action id`. */
const shape = (events: RuminateEvent[]) =>
  events.map((event) => `${event.seq} ${event.entity}.${event.action} ${event.entity_id}`)

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

    const log = await readEvents(alice)
    expect(log.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 11, rejected: 0 })

    const [a] = await driver.exec("SELECT * FROM nodes WHERE user_id = 111 AND id = 'a'")
    expect(a).toMatchObject({ text: "Heading, edited", type: "text", props: null, seq: 11 })
    expect(a.deleted_at).not.toBeNull()
  })

  it("plans the same seven statements for one event or three hundred", () => {
    const w = writer()
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    const many = Array.from({ length: 300 }, (_, i) => w.block(`blk_${i}`, "text", `Block ${i}`))
    expect(planEventAppend([w.block("a", "text", "A")], ctx)).toHaveLength(7)
    expect(planEventAppend(many, ctx)).toHaveLength(7)
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
    // A limit so small every event is its own run: the hardest case for order.
    const statements = planEventAppend(events, ctx, 1)
    expect(statements).toHaveLength(7 * events.length)
    await alice.includingDeleted().batch(statements)
    expect(shape(await readEvents(alice)).map((line) => line.split(" ")[0])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ])
    const rows = await driver.exec(
      "SELECT id, text, seq, deleted_at IS NOT NULL AS dead FROM nodes WHERE user_id = 111 ORDER BY id",
    )
    expect(rows).toEqual([
      { id: "a", text: "A3", seq: 4, dead: 0 },
      { id: "b", text: "B", seq: 5, dead: 1 },
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
    expect([n, lo, hi]).toEqual([300, 2, 301])
  })

  it("a re-sent append adds nothing and regresses nothing", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const first = [w.block("a", "text", "first")]
    await append(alice, first)
    await append(alice, [w.edit("a", { text: "second" })])
    await append(alice, first)

    expect(await readEvents(alice)).toHaveLength(2)
    const [row] = await driver.exec("SELECT text, seq FROM nodes WHERE user_id = 111")
    expect(row).toEqual({ text: "second", seq: 2 })
  })

  it("sequences each tenant on its own, and shows neither the other's log", async () => {
    const { alice, bob } = await open()
    await append(alice, [writer("alice").block("a", "text", "alice's")])
    await append(bob, [
      writer("bob").block("b", "text", "b"),
      writer("bob2").block("c", "text", "c"),
    ])
    expect(shape(await readEvents(alice))).toEqual(["1 block.create a"])
    expect(shape(await readEvents(bob))).toEqual(["1 block.create b", "2 block.create c"])
  })

  it("is append-only: no update, and no delete without a recorded purge", async () => {
    const { driver, alice } = await open()
    await append(alice, [writer().block("a", "text", "A")])
    // (The test driver throws synchronously; `async` makes either a rejection.)
    await expect(
      (async () => driver.exec("UPDATE events SET patch = '{}' WHERE user_id = 111"))(),
    ).rejects.toThrow(/append-only/)
    await expect(
      (async () => driver.exec("DELETE FROM events WHERE user_id = 111"))(),
    ).rejects.toThrow(/append-only/)
    // Erasing an account is the one door: named, reasoned, and per tenant.
    await driver.exec(
      "INSERT INTO event_purges (user_id, reason, created_at) VALUES (111, 'account erasure', 1)",
    )
    await driver.exec("DELETE FROM events WHERE user_id = 111")
    expect(await readEvents(alice)).toEqual([])
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
      w.edit("a", { text: "B" }),
      w.link("note", "a", "a0"),
      w.move("note", "a", "a1"),
      w.view("v", "note", true),
      w.editView("v", { pinned: false }),
    ]
    for (const statement of [...planReconcile(ctx), ...planEventAppend(events, ctx)]) {
      const sql = statement.sql.replace(/:tenant\b/g, "111")
      const plan = await driver.exec(`EXPLAIN QUERY PLAN ${sql}`, statement.params ?? [])
      const details = (plan as { detail: string }[]).map((row) => row.detail)
      for (const detail of details) {
        const corpus = /^(?:SEARCH|SCAN) (?:nodes|link|views)\b/.test(detail)
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

    const log = await readEvents(alice)
    expect(shape(log)).toEqual([
      "1 block.create note",
      "2 block.create a",
      "3 link.create note|a|child",
      "4 block.update a",
      "5 block.update a",
      "6 block.delete a",
      "7 block.restore a",
      "8 link.update note|a|child",
    ])
    expect(log[3].patch).toEqual({ type: "h1", text: "A, retitled" })
    expect(log[4].patch).toEqual({ text: "last words" })
    expect(log[6].patch).toEqual({ text: "back" })
    expect(log[7].patch).toEqual({ sort_key: "a9" })
    // What the writer believed it was changing travels with the change.
    expect(log[3].base_seq).toBe(2)
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 8 })
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
    expect(pulled.cursor).toBe("4")
    expect(pulled.nodes.find((row) => row.id === "a")).toEqual({
      id: "a",
      type: "text",
      text: "A",
      props: null,
      updated_at: 900,
      deleted_at: 900,
      notes_id: "note",
      seq: 4,
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
    const log = await readEvents(alice)
    expect(log[0]).toMatchObject({
      actor: 111,
      origin: "replica",
      device: "tab-9",
      client: "build-abc",
      received_at: 1_000,
    })
    expect(log[1]).toMatchObject({ actor: 222, origin: "share", received_at: 2_000 })
  })

  it("stamps the browser's cursor in the same transaction as the events", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [], cursor: "c-1" })
    const [meta] = await driver.exec(
      "SELECT value FROM meta WHERE user_id = 111 AND key = 'replica_cursor'",
    )
    expect(meta.value).toBe("c-1")
  })
})

describe("a client's own events", () => {
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
        [made[0].id, 1],
        [made[1].id, 2],
      ],
    })
    const log = await readEvents(alice)
    expect(log[1]).toMatchObject({
      cause: "paste",
      tz: 60,
      device: "dev.tab",
      client: "2026-W41.abc",
      origin: "replica",
      actor: 111,
      received_at: 5_000,
    })
    expect(log[0].tz).toBeNull()
    // The projection follows, as for any append; the fold agrees.
    const pulled = await corpusPullSince(alice, 0)
    expect(pulled.nodes.map((row) => [row.id, row.text, row.seq])).toEqual([
      ["note", "N", 1],
      ["a", "A", 2],
    ])
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 2 })
  })

  it("drops what is stale by stamp — what would set no field — and keeps what sets one", async () => {
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
    expect(shape(await readEvents(alice))).toEqual([
      "1 block.create a",
      "2 block.update a",
      "3 block.update a",
      "4 block.update a",
    ])
    const [row] = await driver.exec("SELECT type, text FROM nodes WHERE user_id = 111")
    expect(row).toEqual({ type: "h1", text: "A, after" })
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
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 3 })
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
    const rows = await driver.exec("SELECT seq, hlc FROM events WHERE user_id = 111 ORDER BY seq")
    expect(rows).toEqual([
      { seq: 1, hlc: "000000000001010-0000-dev.tab" },
      { seq: 2, hlc: null },
    ])
    const log = await readEvents(alice)
    expect(log[0].hlc).toBe(stamped.hlc)
    expect("hlc" in log[1]).toBe(false)
    // The reader derives the missing one from what every reader holds alike.
    expect(eventStamp(log[1])).toBe(`000000000001020-0000-seq:000000000000002`)
    // Nothing resolves by it yet: the projection is as it was.
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 2 })
  })

  it("reconciles first, like every write: a tenant's genesis can be its first push of events", async () => {
    const { driver, alice } = await open()
    // A row written around the log — the old Worker, before this one.
    await driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, notes_id, seq) " +
        "VALUES (111, 'old', 'text', 'before the log', NULL, 50, NULL, NULL, 7)",
    )
    const w = writer("dev.tab")
    await client(alice, [w.block("a", "text", "A")])
    expect(shape(await readEvents(alice))).toEqual(["7 block.create old", "8 block.create a"])
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })
})

describe("reconcile", () => {
  /** A row that reached the tables around the log — the old Worker during a
   * deploy, a hand-run statement in the console. */
  const stray = (driver: SqlDriver, id: string, text: string, seq: number, deletedAt?: number) =>
    driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, notes_id, seq) " +
        "VALUES (111, ?1, 'text', ?2, NULL, ?3, ?4, 'note', ?3) " +
        "ON CONFLICT (user_id, id) DO UPDATE SET text = excluded.text, seq = excluded.seq, " +
        "updated_at = excluded.updated_at",
      [id, text, seq, deletedAt ?? null],
    )

  it("genesis: a tenant's first write seeds the log from the corpus it already has", async () => {
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

    await corpusPut(alice, { nodes: [node("new", "text", "the first write", 50)], links: [] })

    const log = await readEvents(alice)
    expect(shape(log)).toEqual([
      "1 block.create old-1",
      "2 block.create old-2",
      "3 link.create note|old-1|child",
      "4 view.create v",
      "5 block.create new",
    ])
    expect(log[0]).toMatchObject({ cause: "snapshot", origin: "system" })
    // Snapshots take the seq their rows already held: no cursor moved.
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 5 })
  })

  it("heals: a row written around the log is recorded by the next write", async () => {
    const { driver, alice } = await open()
    await corpusPut(alice, { nodes: [node("a", "text", "A", 100)], links: [] })
    await stray(driver, "a", "changed behind the log's back", 2)
    expect((await verifyLog(alice)).ok).toBe(true) // verify reconciles first…
    expect(shape(await readEvents(alice))).toEqual(["1 block.create a", "2 block.create a"])

    await stray(driver, "b", "another", 3)
    await corpusPut(alice, { nodes: [node("c", "text", "C", 100)], links: [] })
    expect(shape(await readEvents(alice))).toEqual([
      "1 block.create a",
      "2 block.create a",
      "3 block.create b",
      "4 block.create c",
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
    expect(await textAt({ seq: 3 })).toEqual([3, "one", null])
    expect(await textAt({ seq: 4 })).toEqual([4, "two", null])
    expect(await textAt({ at: 2_500 })).toEqual([4, "two", null])
    expect(await textAt({ at: 9_999 })).toEqual([6, "", 300])
  })

  it("answers a moment before the log began with the beginning, and says so", async () => {
    const { alice } = await seeded()
    const corpus = await corpusAt(alice, { at: 1 })
    expect(corpus.earliest).toEqual({ seq: 3, received_at: 1_000 })
    expect(corpus.seq).toBe(3)
    expect(corpus.latest).toBe(6)
    expect(projectRows(fold(await readEvents(alice, { upTo: 3 }))).nodes).toEqual(corpus.nodes)
  })

  it("has a history per entity", async () => {
    const { alice } = await seeded()
    const history = await readEvents(alice, { entity: "block", entityId: "a" })
    expect(history.map((event) => [event.action, (event.patch as { text?: string }).text])).toEqual(
      [
        ["create", "one"],
        ["update", "two"],
        ["update", ""],
        ["delete", undefined],
      ],
    )
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
    const before = (await readEvents(alice)).at(-1)?.seq as number

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

    // Diagnosis is a read: what happened to this block, in what order.
    const history = await readEvents(alice, { entity: "block", entityId: "b1" })
    expect(history.map((event) => [event.action, event.patch])).toEqual([
      ["create", { type: "ul", text: first, props: null, notes_id: "note" }],
      ["update", { type: "text", text: "" }],
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
    const tail = (await readEvents(alice)).slice(-6)
    expect(tail.every((event) => event.action === "restore" && event.ref_seq === before)).toBe(true)
    expect((await corpusPullSince(alice, before + 8)).nodes.map((row) => row.id).sort()).toEqual([
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
        "SELECT id, type, text, props, updated_at, deleted_at, notes_id, stamps FROM nodes " +
          "WHERE user_id = 111 ORDER BY id",
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
    expect(block).toMatchObject({ type: "h1", text: "A, by a" })
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
    expect(row).toEqual({ type: "h1", text: "A, by a", seq: 3 })
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
    expect(await readEvents(alice)).toHaveLength(3)
  })

  it("derives the stamp of an event that holds none as eventStamp does", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const blocks = Array.from({ length: 10 }, (_, i) => w.block(`blk_${i}`, "text", `B${i}`))
    blocks[9] = { ...blocks[9], at: 1_792_540_800_123 }
    await append(alice, blocks)
    const log = await readEvents(alice)
    expect(log[9].hlc).toBeUndefined()
    const [row] = await driver.exec("SELECT stamps FROM nodes WHERE user_id = 111 AND id = 'blk_9'")
    const want = eventStamp(log[9])
    expect(want).toBe("001792540800123-0000-seq:000000000000010")
    expect(JSON.parse(String(row.stamps))).toEqual({
      type: want,
      text: want,
      props: want,
      notes_id: want,
      alive: want,
    })
  })

  it("keeps what the old rule made of a row from before stamps, and resolves by stamp from there", async () => {
    const { driver, alice } = await open()
    const w = writer("dev.old")
    // Folded by seq, as the projection was before 0025: an edit from a clock
    // that ran behind still landed. By stamp it would not have.
    const legacy = [
      { ...w.block("a", "text", "A"), at: 2_000 },
      { ...w.edit("a", { text: "by the old rule" }), at: 1_000 },
    ]
    for (const [i, event] of legacy.entries()) {
      await driver.exec(
        "INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, batch, origin, " +
          "device, actor, at, received_at, append) " +
          "VALUES (111, ?1, ?2, ?3, ?4, ?5, ?6, 'b', 'replica', ?7, 111, ?8, ?8, 'old')",
        [
          i + 1,
          event.id,
          event.entity,
          event.entity_id,
          event.action,
          JSON.stringify(event.patch),
          event.device,
          event.at,
        ],
      )
    }
    await driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, props, updated_at, notes_id, seq) " +
        "VALUES (111, 'a', 'text', 'by the old rule', NULL, 1000, 'note', 2)",
    )
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 2 })

    // Each field of the row resolves by the stamp of its last event: (1000, seq 2).
    const n = writer("dev.new")
    await append(alice, [
      stampedAt(n.edit("a", { type: "h1" }), 1_500),
      stampedAt(n.edit("a", { text: "behind the row" }), 900),
    ])
    const [row] = await driver.exec("SELECT type, text, stamps FROM nodes WHERE user_id = 111")
    expect(row).toMatchObject({ type: "h1", text: "by the old rule" })
    const held = eventStamp({ ...legacy[1], seq: 2 })
    expect(JSON.parse(String(row.stamps))).toEqual({
      type: encodeHlc({ ms: 1_500, counter: 0, device: "dev.new" }),
      text: held,
      props: held,
      notes_id: held,
      alive: held,
      legacy: 2,
    })
    expect(await verifyLog(alice)).toMatchObject({ ok: true, events: 4 })
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
    const log = await readEvents(alice)
    expect(log[1].hlc).toBe(encodeHlc({ ms: 9_000_000, counter: 1, device: "server:mcp" }))
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
    const update = (await readEvents(alice)).at(-1)!
    expect(update.patch).toEqual({ filter: "type:todo" })
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
      const folded = toViewRows(foldByStamp(await readEvents(alice)))
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
  const propsOf = async (driver: SqlDriver, id: string) =>
    JSON.parse(
      String(
        (await driver.exec("SELECT props FROM nodes WHERE user_id = 111 AND id = ?1", [id]))[0]
          .props,
      ),
    )
  const keyRows = (driver: SqlDriver) =>
    driver.exec(
      "SELECT id, entity_id, action, key, value, event_id, event_seq FROM events_log " +
        "WHERE user_id = 111 ORDER BY seq",
    )

  it("the migration's backfill, the Worker's fill and expandLog read an old log alike", async () => {
    const w = writer()
    const old = [
      w.block("note", "note", "N", null),
      w.block("a", "image", "A"),
      w.edit("a", { props: '{"size":40,"align":"left"}' }),
      w.link("note", "a", "a0"),
      w.view("v1", "note", true),
      w.edit("a", { text: "A!", props: '{"align":"left","size":50,"nested":{"x":1},"bad key":1}' }),
      w.editView("v1", { pinned: false, stack: "[]" }),
      w.edit("a", { props: null }),
      w.remove("a"),
    ]
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    // Three tenants with the same old log and no per-key rows: one read by
    // the migration's statement, one by the Worker's fill, one in TypeScript.
    const read = async (how: "migration" | "fill") => {
      const { driver, alice } = await open()
      await alice.includingDeleted().batch(planEventAppend(old, ctx))
      await driver.exec("DELETE FROM events_log WHERE user_id = 111")
      if (how === "migration") {
        await driver.execScript(
          migration0028.slice(migration0028.indexOf("INSERT INTO events_log")),
        )
      } else {
        await alice.includingDeleted().batch(planLogFill({ now: 2, appendId: "fill" }))
      }
      const rows = await keyRows(driver)
      return rows.map((row) => `${row.id} ${row.action} ${row.key} ${row.value} ${row.event_seq}`)
    }
    const log = await (async () => {
      const { alice } = await open()
      await alice.includingDeleted().batch(planEventAppend(old, ctx))
      return readEvents(alice)
    })()
    const inTs = expandLog(log).map(
      (row) =>
        `${row.id} ${row.action} ${row.key} ${JSON.stringify(row.value ?? null)} ${row.event_seq}`,
    )
    const byMigration = await read("migration")
    expect(byMigration).toEqual(inTs)
    expect(await read("fill")).toEqual(inTs)
    expect(inTs).toContain('evt_tab-1_6#1 set props.nested {"x":1} 6')
    expect(inTs).toContain("evt_tab-1_8#2 unset props.size null 8")
    expect(inTs.some((line) => line.includes("bad key"))).toBe(false)
  })

  it("lands a client's key events in both logs, projects per key, and verify passes", async () => {
    const { driver, alice } = await open()
    const dev = keyWriter("dev.a")
    const landed = await client(alice, [
      ...dev.block("note", {}),
      ...dev.block("a", { align: "left", size: 40 }),
    ])
    expect(landed.stale).toBe(0)
    expect(landed.seqs.map(([, seq, eventSeq]) => [seq, eventSeq])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 2],
      [6, 2],
      [7, 2],
      [8, 2],
      [9, 2],
      [10, 2],
    ])
    // The old log holds one event per gesture, with the props assembled.
    expect(shape(await readEvents(alice))).toEqual(["1 block.create note", "2 block.create a"])
    const [, created] = await readEvents(alice)
    expect(JSON.parse(String((created.patch as { props?: string }).props))).toEqual({
      align: "left",
      size: 40,
    })
    expect(await propsOf(driver, "a")).toEqual({ align: "left", size: 40 })
    expect(
      await driver.exec("SELECT key, value FROM block_values WHERE user_id = 111 ORDER BY key"),
    ).toEqual([
      { key: "align", value: '"left"' },
      { key: "size", value: "40" },
    ])
    expect(await verifyLog(alice)).toMatchObject({
      ok: true,
      rollup: "new",
      events: 2,
      keyEvents: 10,
      logs: [],
    })
    // A re-sent push appends nothing and answers the same seqs.
    const again = await client(alice, dev.block("a", { align: "left", size: 40 }).slice(0, 0))
    expect(again.appended).toBe(0)
  })

  it("two devices offline on two keys of one block both keep their change — per key, where whole props would lose one", async () => {
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
    // The old log, written beside, reads the same: each event's props is
    // the row's props with that key changed.
    const old = await readEvents(alice)
    expect(JSON.parse(String((old.at(-1)!.patch as { props?: string }).props))).toEqual({
      align: "right",
      size: 80,
    })
    const verdict = await verifyLog(alice)
    expect(verdict).toMatchObject({ ok: true, logs: [], blockValues: [] })
    // The same two edits through the old door, as whole-props patches: the
    // laptop's older patch would set no field and is dropped.
    const { driver: driver2, alice: bob } = await open()
    const w = writer("dev.a")
    await client(bob, [
      ...keyWriter("dev.a").block("note", {}),
      ...keyWriter("dev.a").block("b", { align: "left", size: 40 }),
    ])
    await appendClientEvents(
      bob,
      [
        stampedAt(
          { ...w.edit("b", { props: '{"align":"left","size":80}' }), device: "phone" },
          2_000,
        ),
      ],
      { actor: 111, origin: "replica" },
    )
    const dropped = await appendClientEvents(
      bob,
      [stampedAt(w.edit("b", { props: '{"align":"right","size":40}' }), 1_500)],
      { actor: 111, origin: "replica" },
    )
    expect(dropped.stale).toBe(1)
    expect(await propsOf(driver2, "b")).toEqual({ align: "left", size: 80 })
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
    expect(
      (await driver.exec("SELECT props FROM nodes WHERE user_id = 111 AND id = 'a'"))[0].props,
    ).toBeNull()
    expect(
      await driver.exec(
        "SELECT key, value FROM block_values WHERE user_id = 111 AND block_id = 'a'",
      ),
    ).toEqual([{ key: "size", value: null }])
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("the row door and the key door write the same two logs, and verify passes with both", async () => {
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
    expect(await verifyLog(alice)).toMatchObject({ ok: true, logs: [] })
    // A restore reads per key too.
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
    await restoreSubtree(alice, "a", 4, { actor: 111, origin: "replica", now: 11_000 })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("seeds block_values once from the per-key fold, so a tenant from before the log verifies", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const ctx = { appendId: "x", actor: 111, origin: "replica" as const, client: null, now: 1 }
    // A tenant as the deploy finds it: an old log, projected by the old
    // rule, and the per-key table empty.
    await alice
      .includingDeleted()
      .batch(
        planEventAppend(
          [
            w.block("note", "note", "N", null),
            w.block("a", "image", "A"),
            w.edit("a", { props: '{"size":40}' }),
            w.edit("a", { props: '{"size":40,"align":"left"}' }),
          ],
          ctx,
        ),
      )
    await driver.exec("DELETE FROM events_log WHERE user_id = 111")
    expect(await driver.exec("SELECT COUNT(*) AS n FROM block_values WHERE user_id = 111")).toEqual(
      [{ n: 0 }],
    )
    expect(await verifyLog(alice)).toMatchObject({ ok: true, keyEvents: 10 })
    expect(
      await driver.exec("SELECT key, value FROM block_values WHERE user_id = 111 ORDER BY key"),
    ).toEqual([
      { key: "align", value: '"left"' },
      { key: "size", value: "40" },
    ])
    expect(
      await driver.exec(
        "SELECT value FROM meta WHERE user_id = 111 AND key = 'block_values_seeded'",
      ),
    ).toHaveLength(1)
    // A later key event projects from the seeded keys.
    const dev = keyWriter("dev.a")
    dev.at(9_000)
    await client(alice, [dev.row("block", "a", "unset", "props.size", null)])
    expect(await propsOf(driver, "a")).toEqual({ align: "left" })
    expect(await verifyLog(alice)).toMatchObject({ ok: true })
  })

  it("under the old rollup the old events project as before, both logs are still written, and verify passes", async () => {
    setEventLogRollup("old")
    try {
      const { driver, alice } = await open()
      const dev = keyWriter("dev.a")
      await client(alice, [
        ...dev.block("note", {}),
        ...dev.block("a", { align: "left", size: 40 }),
      ])
      dev.at(2_000)
      await client(alice, [dev.row("block", "a", "set", "props.size", 80)])
      expect(await propsOf(driver, "a")).toEqual({ align: "left", size: 80 })
      expect((await keyRows(driver)).length).toBe(11)
      expect(await verifyLog(alice)).toMatchObject({ ok: true, rollup: "old", logs: [] })
      // A whole-props stale check: an older edit to another key is dropped,
      // as the old rule has it.
      const phone = keyWriter("phone")
      phone.at(1_500)
      const dropped = await client(alice, [phone.row("block", "a", "set", "props.align", "right")])
      expect(dropped.stale).toBe(1)
      expect(await propsOf(driver, "a")).toEqual({ align: "left", size: 80 })
    } finally {
      setEventLogRollup("new")
    }
  })

  it("serves the per-key log by its own seq, one entity's too", async () => {
    const { alice } = await open()
    const dev = keyWriter("dev.a")
    await client(alice, [...dev.block("note", {}), ...dev.block("a", { size: 40 })])
    const all = await readKeyEvents(alice)
    expect(all.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(all[0]).toMatchObject({
      origin: "replica",
      actor: 111,
      event: "key_dev.a_1",
      event_seq: 1,
    })
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
    expect(past.seq).toBe(2)
    expect(past.nodes.map((row) => row.id).sort()).toEqual(["a", "note"])
    expect(past.nodes.find((row) => row.id === "a")?.props).toBe('{"size":40}')
  })
})
