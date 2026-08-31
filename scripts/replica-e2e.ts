/**
 * Live end-to-end check of the replica path against a REAL local D1 database
 * (schema v3 — corpus tables scoped by `user_id`, with soft deletes;
 * docs/multi-tenant-design.md, docs/graph-storage.md).
 *
 * What is real here: the handler (`worker/handlers/replica.ts` — routing,
 * `requireSession`, the control-plane tenancy resolve, the `TenantDb` mint and
 * its runtime guard), the planners, and every SQL statement, running against
 * the same `.wrangler/state` D1 database `wrangler dev` uses. `getPlatformProxy`
 * supplies the binding; the only stub is GitHub, whose `/user` call decides
 * which identity a token belongs to.
 *
 * (The Durable Object detour that used to require Miniflare here is gone: the
 * corpus lives in D1 again, and `getPlatformProxy` proxies a D1 binding
 * perfectly well. The retiring `CORPUS` binding is simply absent from this
 * env, which is exactly the state of the world after the DO→D1 import — the
 * import itself is covered by `worker/handlers/corpus-migration.test.ts`.)
 *
 * Prereq: npx wrangler d1 migrations apply ruminate --local
 * Run:    npx vite-node scripts/replica-e2e.ts
 */
import { strict as assert } from "node:assert"
import { getPlatformProxy } from "wrangler"
import { parse } from "../src/blocks/parse"
import { serialize } from "../src/blocks/serialize"
import { buildGraphSnapshot, docToGraph, rollup } from "../src/data/graph"
import { replica } from "../worker/handlers/replica"
import type {
  LinkRow,
  NodeRow,
  ReplicaChangesBody,
  ReplicaCorpusBody,
  ReplicaStatusBody,
} from "../worker/handlers/replica-payload"
import type { Env } from "../worker/types"

// The identities the GitHub stub vends, keyed by bearer token. The owner id
// matches wrangler.jsonc's ALLOWED_GITHUB_ID (and the 0003 allowlist seed);
// the guest is allowlisted by this script; the outsider is a valid GitHub
// account that must stay locked out (SIGNUP_MODE=allowlist).
const IDENTITIES: Record<string, { id: number; login: string }> = {
  "e2e-owner-token": { id: 42536816, login: "e2e-owner" },
  "e2e-guest-token": { id: 424242, login: "e2e-guest" },
  "e2e-outsider-token": { id: 999999, login: "e2e-outsider" },
}
const OWNER_ID = 42536816
const GUEST_ID = 424242

const NOTE_A =
  "---\nupdated_at: 2026-08-29T12:00:00.000Z\n---\n" +
  "- Hello [[e2e-note-b]] #e2e\n  id:: blk_e2ea000001\n" +
  "  - Nested ((blk_e2eb000001))\n    id:: blk_e2ea000002\n"
const NOTE_B = "- Plain note\n  id:: blk_e2eb000001\n"

const T0 = Date.parse("2026-08-29T12:00:00.000Z")
const graphA = docToGraph("e2e-note-a", NOTE_A, T0)
const graphB = docToGraph("e2e-note-b", NOTE_B, T0)

const authHeaders = (token: string) => ({
  Cookie: "gh_refresh=e2e-session",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
})

const e2eNodes = (rows: NodeRow[]) => rows.filter((row) => row.id.includes("e2e"))
const e2eLinks = (rows: LinkRow[]) => rows.filter((row) => row.source_id.includes("e2e"))

/** GitHub `/user`, stubbed: the one outbound call the handler makes. */
const githubStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "https://api.github.com/user") {
    throw new Error(`Unexpected outbound fetch: ${String(input)}`)
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
  const identity = IDENTITIES[/^Bearer (.+)$/.exec(auth)?.[1] ?? ""]
  if (!identity) return new Response("{}", { status: 401 })
  return new Response(JSON.stringify(identity), { status: 200 })
}) as typeof fetch

async function main() {
  const platform = await getPlatformProxy<Env>()
  const db = platform.env.DB
  // The DO binding is deliberately not wired here (see the header): after the
  // import there is nothing behind it, and the handler must cope with that.
  const env = {
    DB: db,
    SIGNUP_MODE: "allowlist",
    ALLOWED_GITHUB_ID: String(OWNER_ID),
  } as unknown as Env

  const api = (path: string, init?: RequestInit) =>
    replica(new Request(`https://ruminate.test${path}`, init), env, githubStub)
  const status = async (token = "e2e-owner-token"): Promise<ReplicaStatusBody> => {
    const response = await api("/api/replica/status", { headers: authHeaders(token) })
    assert.equal(response.status, 200)
    return (await response.json()) as ReplicaStatusBody
  }
  const put = (body: unknown, token = "e2e-owner-token") =>
    api("/api/replica/notes", {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    })
  const pull = async (token = "e2e-owner-token"): Promise<ReplicaCorpusBody> =>
    (await (
      await api("/api/replica/notes", { headers: authHeaders(token) })
    ).json()) as ReplicaCorpusBody

  /** Rows this script created, straight out of D1 — including their tenant. */
  const ownedRows = async () => {
    const result = await db
      .prepare(
        "SELECT user_id, id, deleted_at FROM nodes WHERE id LIKE '%e2e%' ORDER BY user_id, id",
      )
      .all<{ user_id: number; id: string; deleted_at: number | null }>()
    return result.results
  }
  const cleanup = () =>
    db.batch([
      db.prepare("DELETE FROM link WHERE source_id LIKE '%e2e%' OR destination_id LIKE '%e2e%'"),
      db.prepare("DELETE FROM nodes WHERE id LIKE '%e2e%'"),
      db.prepare("DELETE FROM allowlist WHERE github_id = ?1").bind(GUEST_ID),
      db.prepare("DELETE FROM users WHERE github_id = ?1").bind(GUEST_ID),
    ])

  try {
    await cleanup() // in case an earlier run aborted

    // --- auth guards: no cookie / no bearer / unknown token → 401;
    //     a VALID GitHub identity outside the allowlist → 403, fail closed
    assert.equal(
      (
        await api("/api/replica/notes", {
          headers: { Authorization: "Bearer e2e-owner-token" },
        })
      ).status,
      401,
    )
    assert.equal(
      (await api("/api/replica/status", { headers: { Cookie: "gh_refresh=e2e-session" } })).status,
      401,
    )
    const outsider = await api("/api/replica/status", {
      headers: authHeaders("e2e-outsider-token"),
    })
    assert.equal(outsider.status, 403)
    assert.deepEqual(await outsider.json(), { error: "signup_closed" })
    console.log("auth guards: 401 without session, 403 for a non-allowlisted identity ✓")

    // --- push two notes' rows, built by the real ingest
    const before = await status()
    const cursor = String(Date.now())
    const putResponse = await put({
      nodes: [...graphA.nodes, ...graphB.nodes],
      links: [...graphA.links, ...graphB.links],
      cursor,
    })
    assert.equal(putResponse.status, 200)
    assert.deepEqual(await putResponse.json(), { ok: true, nodes: 5, links: 3, deletes: 0 })

    const after = await status()
    assert.equal(after.counts.nodes, before.counts.nodes + 5)
    assert.equal(after.counts.links, before.counts.links + 3)
    assert.equal(after.counts.pages, before.counts.pages + 2)
    assert.equal(after.replica_cursor, cursor)
    assert.equal(after.schema_version, "3")
    console.log("PUT: rows landed in the owner's D1 partition, counts + cursor confirmed ✓")

    // --- every row carries the VERIFIED tenant, and no other
    assert.deepEqual(
      [...new Set((await ownedRows()).map((row) => row.user_id))],
      [OWNER_ID],
      "every row this push created must belong to the verified owner",
    )
    console.log("tenancy: every stored row carries the verified user_id ✓")

    // --- GET pull (database-authoritative boot + sync source)
    const corpus = await pull()
    assert.equal(corpus.cursor, cursor)
    assert.equal(e2eNodes(corpus.nodes).length, 5)
    assert.equal(e2eLinks(corpus.links).length, 3)
    // The pulled rows roll up to the exact canonical markdown that was ingested.
    const snapshot = buildGraphSnapshot(corpus.nodes, corpus.links)
    assert.equal(rollup("e2e-note-a", snapshot), serialize(parse(NOTE_A)))
    assert.equal(rollup("e2e-note-b", snapshot), NOTE_B)
    console.log("GET full: rollup reproduces the ingested markdown ✓")

    // --- since pull: changed rows + full key lists
    const changes = (await (
      await api(`/api/replica/notes?since=${T0 - 1000}`, {
        headers: authHeaders("e2e-owner-token"),
      })
    ).json()) as ReplicaChangesBody
    assert.equal(e2eNodes(changes.nodes).length, 5)
    assert.ok(changes.nodeIds.includes("e2e-note-a") && changes.nodeIds.includes("blk_e2eb000001"))
    assert.ok(changes.linkKeys.some(([s, d]) => s === "e2e-note-b" && d === "blk_e2eb000001"))

    const noChanges = (await (
      await api(`/api/replica/notes?since=${Date.now() + 60_000}`, {
        headers: authHeaders("e2e-owner-token"),
      })
    ).json()) as ReplicaChangesBody
    assert.equal(e2eNodes(noChanges.nodes).length, 0)
    assert.ok(noChanges.nodeIds.includes("e2e-note-b"))

    assert.equal(
      (await api("/api/replica/notes?since=nope", { headers: authHeaders("e2e-owner-token") }))
        .status,
      400,
    )
    console.log("GET since: changed rows + full key lists, 400 on malformed since ✓")

    // --- per-row LWW: replays are idempotent, stale rows cannot clobber newer
    await put({
      nodes: [...graphA.nodes, ...graphB.nodes],
      links: [...graphA.links, ...graphB.links],
    })
    assert.deepEqual((await status()).counts, after.counts)

    await put({
      nodes: [{ ...graphB.nodes[1], text: "Edited note", updated_at: T0 + 1000 }],
      links: [],
    })
    await put({
      nodes: [{ ...graphB.nodes[1], text: "Stale edit", updated_at: T0 - 5000 }],
      links: [],
    })
    assert.equal(
      (await pull()).nodes.find((row) => row.id === "blk_e2eb000001")?.text,
      "Edited note",
    )
    console.log("per-row LWW: replay idempotent, stale row rejected ✓")

    // --- soft deletes: the row survives, carries its stamp, and stops counting
    const deletedAt = T0 + 5000
    await put({
      nodes: [
        { ...graphB.nodes[1], text: "Edited note", updated_at: deletedAt, deleted_at: deletedAt },
      ],
      links: [],
    })
    const afterDelete = await status()
    assert.equal(afterDelete.counts.nodes, after.counts.nodes - 1)
    const tombstoned = (await pull()).nodes.find((row) => row.id === "blk_e2eb000001")
    assert.equal(tombstoned?.deleted_at, deletedAt, "the tombstone must survive a round trip")
    const sinceDelete = (await (
      await api(`/api/replica/notes?since=${deletedAt - 1}`, {
        headers: authHeaders("e2e-owner-token"),
      })
    ).json()) as ReplicaChangesBody
    assert.ok(
      sinceDelete.nodes.some((row) => row.id === "blk_e2eb000001" && row.deleted_at === deletedAt),
      "a since-pull must deliver the tombstone as an ordinary change",
    )
    // The row still EXISTS, so it stays in the key lists — no purge implied.
    assert.ok(sinceDelete.nodeIds.includes("blk_e2eb000001"))
    // Reviving the id clears the stamp.
    await put({
      nodes: [{ ...graphB.nodes[1], text: "Back", updated_at: deletedAt + 1000 }],
      links: [],
    })
    assert.equal(
      (await pull()).nodes.find((row) => row.id === "blk_e2eb000001")?.deleted_at,
      undefined,
    )
    console.log("soft deletes: tombstone round-trips, hides the row, and revives cleanly ✓")

    // --- tenant isolation over the real handler: allowlist the guest, who
    //     gets an EMPTY corpus, and whose claimed-tenant params change nothing
    await db
      .prepare("INSERT INTO allowlist (github_id, note) VALUES (?1, 'e2e')")
      .bind(GUEST_ID)
      .run()
    const guestPull = await api("/api/replica/notes?github_id=42536816&user_id=42536816", {
      headers: { ...authHeaders("e2e-guest-token"), "X-GitHub-Id": "42536816" },
    })
    assert.equal(guestPull.status, 200)
    const guestCorpus = (await guestPull.json()) as ReplicaCorpusBody
    assert.equal(guestCorpus.nodes.length, 0, "the guest must not see the owner's rows")
    assert.equal(guestCorpus.links.length, 0)

    assert.equal(
      (
        await put(
          {
            nodes: [
              {
                id: "e2e-guest-note",
                type: "page",
                text: "e2e-guest-note",
                props: null,
                updated_at: T0,
              },
            ],
            links: [],
          },
          "e2e-guest-token",
        )
      ).status,
      200,
    )
    const guestSince = (await (
      await api("/api/replica/notes?since=0", { headers: authHeaders("e2e-guest-token") })
    ).json()) as ReplicaChangesBody
    // The destructive channel: the guest's key list must be theirs alone.
    assert.deepEqual(guestSince.nodeIds, ["e2e-guest-note"])

    const ownerAfterGuest = await pull()
    assert.ok(!ownerAfterGuest.nodes.some((row) => row.id === "e2e-guest-note"))
    assert.deepEqual((await status("e2e-guest-token")).counts, { nodes: 1, links: 0, pages: 1 })
    assert.deepEqual(
      [...new Set((await ownedRows()).map((row) => row.user_id))].sort(),
      [GUEST_ID, OWNER_ID].sort(),
      "each row belongs to exactly the tenant that wrote it",
    )
    console.log("tenant isolation: guest sees an empty corpus, claimed-tenant params ignored ✓")

    // --- deletes through the legacy channel tombstone the owner's rows only
    await put({
      nodes: [],
      links: [],
      deleteNodes: [
        "e2e-note-a",
        "e2e-note-b",
        "blk_e2ea000001",
        "blk_e2ea000002",
        "blk_e2eb000001",
      ],
    })
    assert.deepEqual((await status()).counts, before.counts)
    assert.deepEqual((await status("e2e-guest-token")).counts, { nodes: 1, links: 0, pages: 1 })
    console.log("deletes: the owner's counts are back, the guest's are untouched ✓")
  } finally {
    await cleanup()
    await platform.dispose()
  }

  console.log("\nreplica e2e: all assertions passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
