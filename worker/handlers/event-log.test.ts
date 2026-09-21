// tenant-guard: exempt — raw reads below prove what the planned statements
// wrote, and the trigger specimens are meant to be refused.
import { describe, expect, it } from "vitest"
import eventsMigration from "../../migrations-spike/events.sql?raw"
import genesisMigration from "../../migrations-spike/events_genesis.sql?raw"
import {
  EVENT_VERSION,
  fold,
  linkEntityId,
  planRestoreSubtree,
  projectRows,
  type EventContext,
  type RuminateEvent,
} from "../../src/data/events"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import {
  appendEvents,
  parseEvent,
  planEventAppend,
  readEntityHistory,
  readEventsSince,
} from "./event-log"
import { corpusPut } from "./replica-corpus"
import { createTenantTestDriver } from "./sqlite-test-driver"

const identityOf = (id: number) => ({ id, login: `u${id}`, name: null })

async function open(): Promise<{ driver: SqlDriver; alice: TenantDb; bob: TenantDb }> {
  const driver = await createTenantTestDriver()
  await driver.execScript(eventsMigration)
  const alice = forTenant(driver, identityOf(111))
  const bob = forTenant(driver, identityOf(222))
  await ensureTenantMeta(alice)
  await ensureTenantMeta(bob)
  return { driver, alice, bob }
}

/** A writer: mints ids and stamps a clock that ticks once per event. */
function writer(device = "tab-1") {
  let n = 0
  let clock = 1_000
  const ctx = (cause?: string): EventContext => ({
    batch: `b${n}`,
    device,
    cause,
    at: (clock += 10),
    mintId: () => `evt_${device}_${(n += 1)}`,
  })
  const make = (
    entity: RuminateEvent["entity"],
    entityId: string,
    action: RuminateEvent["action"],
    patch: object,
    cause?: string,
  ): RuminateEvent => {
    const c = ctx(cause)
    return {
      id: c.mintId(),
      batch: c.batch,
      device,
      ...(cause ? { cause } : {}),
      at: c.at,
      v: EVENT_VERSION,
      entity,
      entity_id: entityId,
      action,
      patch,
    } as RuminateEvent
  }
  return {
    ctx,
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

let appendCount = 0
const append = (tenant: TenantDb, events: RuminateEvent[]) =>
  appendEvents(tenant, events, {
    appendId: `append-${(appendCount += 1)}`,
    actor: tenant.userId,
    now: 5_000,
  })

/** The projection tables as plain rows, in a stable order, for comparison. */
async function tables(driver: SqlDriver, userId: number) {
  const nodes = await driver.exec(
    "SELECT id, type, text, props, notes_id, updated_at, deleted_at, seq FROM nodes WHERE user_id = ?1 ORDER BY id",
    [userId],
  )
  const links = await driver.exec(
    "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq FROM link WHERE user_id = ?1 ORDER BY source_id, destination_id",
    [userId],
  )
  const views = await driver.exec(
    "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq FROM views WHERE user_id = ?1 ORDER BY id",
    [userId],
  )
  return { nodes, links, views }
}

/** What folding the log says those tables should hold, in the same shape. */
function folded(events: RuminateEvent[]) {
  const rows = projectRows(fold(events))
  const nul = <T>(value: T | undefined) => value ?? null
  return {
    nodes: rows.nodes
      .map((n) => ({
        id: n.id,
        type: n.type,
        text: n.text,
        props: n.props,
        notes_id: nul(n.notes_id),
        updated_at: n.updated_at,
        deleted_at: nul(n.deleted_at),
        seq: nul(n.seq),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    links: rows.links
      .map((l) => ({
        source_id: l.source_id,
        destination_id: l.destination_id,
        kind: l.kind,
        sort_key: l.sort_key,
        updated_at: l.updated_at,
        deleted_at: nul(l.deleted_at),
        seq: nul(l.seq),
      }))
      .sort((a, b) =>
        `${a.source_id}|${a.destination_id}` < `${b.source_id}|${b.destination_id}` ? -1 : 1,
      ),
    views: rows.views
      .map((v) => ({
        id: v.id,
        root_id: v.root_id,
        filter: v.filter,
        sort: v.sort,
        pinned: v.pinned ? 1 : 0,
        sort_key: v.sort_key,
        updated_at: v.updated_at,
        deleted_at: nul(v.deleted_at),
        seq: nul(v.seq),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  }
}

describe("parseEvent", () => {
  const good = writer().block("a", "text", "A")

  it("accepts a well-formed event and sheds the sequence only the replica may assign", () => {
    expect(parseEvent({ ...good, seq: 999 })).toEqual(good)
  })

  it("keeps patch fields it does not know, for a later upcast to read", () => {
    const newer = { ...good, patch: { ...good.patch, colour: "red" } }
    expect(parseEvent(newer)).toEqual(newer)
  })

  it("refuses what it cannot file", () => {
    expect(parseEvent(null)).toBeNull()
    expect(parseEvent({ ...good, entity: "note" })).toBeNull()
    expect(parseEvent({ ...good, action: "move" })).toBeNull()
    expect(parseEvent({ ...good, id: "" })).toBeNull()
    expect(parseEvent({ ...good, patch: [] })).toBeNull()
    expect(parseEvent({ ...good, at: "yesterday" })).toBeNull()
  })
})

describe("the event log over the real D1 schema", () => {
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

    const log = await readEventsSince(alice, 0)
    expect(log.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(await tables(driver, 111)).toEqual(folded(log))

    const a = (await tables(driver, 111)).nodes.find((node) => node.id === "a")
    expect(a).toMatchObject({ text: "Heading, edited", type: "text", props: null, seq: 11 })
    expect(a?.deleted_at).not.toBeNull()
  })

  it("plans the same seven statements for one event or three hundred", () => {
    const w = writer()
    const ctx = { appendId: "x", actor: 111, now: 1 }
    const one = planEventAppend([w.block("a", "text", "A")], ctx)
    const many = planEventAppend(
      Array.from({ length: 300 }, (_, i) => w.block(`blk_${i}`, "text", `Block ${i}`)),
      ctx,
    )
    expect(one).toHaveLength(7)
    expect(many).toHaveLength(7)
    expect(planEventAppend([], ctx)).toEqual([])
  })

  it("appends three hundred blocks in one batch, contiguously sequenced", async () => {
    const { driver, alice } = await open()
    const w = writer()
    await append(alice, [w.block("note", "note", "N", null)])
    const blocks = Array.from({ length: 300 }, (_, i) => w.block(`blk_${i}`, "text", `Block ${i}`))
    await append(alice, blocks)
    const [{ n, lo, hi }] = await driver.exec(
      "SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM nodes WHERE user_id = 111 AND id LIKE 'blk_%'",
    )
    expect([n, lo, hi]).toEqual([300, 2, 301])
  })

  it("a retried push appends nothing and regresses nothing", async () => {
    const { driver, alice } = await open()
    const w = writer()
    const first = [w.block("a", "text", "first")]
    await append(alice, first)
    await append(alice, [w.edit("a", { text: "second" })])
    // The keepalive flush's response was lost; the client sends `first` again.
    await append(alice, first)

    expect(await readEventsSince(alice, 0)).toHaveLength(2)
    const [row] = (await tables(driver, 111)).nodes
    expect(row).toMatchObject({ text: "second", seq: 2 })
  })

  it("sequences each tenant on its own, and shows neither the other's log", async () => {
    const { alice, bob } = await open()
    await append(alice, [writer("alice").block("a", "text", "alice's")])
    await append(bob, [
      writer("bob").block("b", "text", "bob's"),
      writer("bob2").block("c", "text", "c"),
    ])
    expect((await readEventsSince(alice, 0)).map((e) => [e.seq, e.entity_id])).toEqual([[1, "a"]])
    expect((await readEventsSince(bob, 0)).map((e) => [e.seq, e.entity_id])).toEqual([
      [1, "b"],
      [2, "c"],
    ])
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
    expect(await readEventsSince(alice, 0)).toEqual([])
  })

  // The incident of 2026-09-19, replayed. A heading and two bullets, typed
  // during a call; then fifteen seconds of ordinary edits that emptied them.
  // Under row LWW the text survived only in D1 Time Travel. Here it is a
  // query, and putting it back is an append.
  it("keeps what the 19 September wipe destroyed, and restores it by appending", async () => {
    const { driver, alice } = await open()
    const w = writer("tester-tab")
    const first = "First point from the call, a full sentence of it, typed as the meeting went on"
    const second =
      "Second point from the call, longer than the first, with a trailing thought at the end"
    await append(alice, [
      w.block("note", "note", "Ideas", null),
      w.block("section", "h1", "A section heading"),
      w.link("note", "section", "a1"),
      w.block("call", "h1", "Call notes"),
      w.link("section", "call", "aG"),
      w.block("b1", "ul", first),
      w.link("call", "b1", "a0"),
      w.block("b2", "ul", second),
      w.link("call", "b2", "a0V"),
    ])
    const before = Math.max(...(await readEventsSince(alice, 0)).map((e) => e.seq ?? 0))

    // 10:06:30–10:06:45 UTC, as the rows recorded it.
    await append(alice, [
      w.edit("b2", { text: " " }, "deleteBackward"),
      w.unlink("call", "b2", "deleteBlock"),
      w.edit("b1", { text: "", type: "text" }, "stripMarker"),
      w.unlink("call", "b1", "backspaceEmpty"),
      w.unlink("section", "call", "outdent"),
      w.link("note", "call", "a3"),
      w.edit("call", { type: "text", text: "" }, "stripMarker"),
    ])
    const wiped = (await tables(driver, 111)).nodes
    expect(wiped.find((n) => n.id === "b1")?.text).toBe("")
    expect(wiped.find((n) => n.id === "call")?.text).toBe("")

    // Diagnosis is a read: what happened to this block, in what order, and why.
    const history = await readEntityHistory(alice, "block", "b1")
    expect(
      history.map((e) => [e.action, e.cause ?? null, (e.patch as { text?: string }).text]),
    ).toEqual([
      ["create", null, first],
      ["update", "stripMarker", ""],
    ])

    // Recovery is an append: restore the section to the moment before.
    const log = await readEventsSince(alice, 0)
    const restore = planRestoreSubtree(log, "call", before, w.ctx("restore"))
    expect(restore.every((event) => event.action === "restore")).toBe(true)
    await append(alice, restore)

    const after = await tables(driver, 111)
    expect(after.nodes.find((n) => n.id === "call")).toMatchObject({
      type: "h1",
      text: "Call notes",
      deleted_at: null,
    })
    expect(after.nodes.find((n) => n.id === "b1")).toMatchObject({ type: "ul", text: first })
    expect(after.nodes.find((n) => n.id === "b2")).toMatchObject({ type: "ul", text: second })
    const live = after.links
      .filter((l) => l.deleted_at === null)
      .map((l) => `${l.source_id}>${l.destination_id}`)
    expect(live).toEqual(expect.arrayContaining(["section>call", "call>b1", "call>b2"]))
    // …and the log still says the wipe happened: nothing was rewound.
    expect(after).toEqual(folded(await readEventsSince(alice, 0)))
  })

  it("genesis: seeds the log from existing rows, and the next event continues their sequence", async () => {
    const driver = await createTenantTestDriver()
    const alice = forTenant(driver, identityOf(111))
    await ensureTenantMeta(alice)
    // A corpus written the old way, rows and last-writer-wins, tombstone included.
    await corpusPut(alice, {
      nodes: [
        { id: "note", type: "note", text: "N", props: '{"x":1}', updated_at: 100 },
        { id: "a", type: "text", text: "A", props: null, updated_at: 110, notes_id: "note" },
        {
          id: "gone",
          type: "text",
          text: "was here",
          props: null,
          updated_at: 120,
          deleted_at: 120,
          notes_id: "note",
        },
      ],
      links: [
        { source_id: "note", destination_id: "a", kind: "child", sort_key: "a0", updated_at: 110 },
      ],
      views: [
        {
          id: "v",
          root_id: "note",
          filter: null,
          sort: "text:desc",
          pinned: true,
          sort_key: "a0",
          updated_at: 130,
        },
      ],
    })
    const rowsBefore = await tables(driver, 111)

    await driver.execScript(eventsMigration)
    await driver.execScript(genesisMigration)

    const log = await readEventsSince(alice, 0)
    expect(log).toHaveLength(5)
    expect(folded(log)).toEqual(rowsBefore)

    await append(alice, [writer().edit("a", { text: "A, edited" })])
    const [row] = (await tables(driver, 111)).nodes.filter((n) => n.id === "a")
    expect(row).toMatchObject({ text: "A, edited", seq: 6 })
    expect(await tables(driver, 111)).toEqual(folded(await readEventsSince(alice, 0)))
  })
})
