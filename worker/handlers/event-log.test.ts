// tenant-guard: exempt — raw reads below prove what the planned statements
// wrote, raw writes stand in for a writer that went AROUND the log, and the
// trigger specimens are meant to be refused.
import { describe, expect, it } from "vitest"
import {
  EVENT_VERSION,
  fold,
  linkEntityId,
  projectRows,
  type RuminateEvent,
} from "../../src/data/events"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import {
  appendEvents,
  corpusAt,
  planEventAppend,
  planReconcile,
  readEvents,
  restoreSubtree,
  verifyLog,
  writeRows,
} from "./event-log"
import { corpusPullSince, corpusPut } from "./replica-corpus"
import type { LinkRow, NodeRow } from "./replica-payload"
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
    for (const statement of [planReconcile(ctx), ...planEventAppend(events, ctx)]) {
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
      if (/UPDATE (?:nodes|link|views)/.test(sql)) {
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
