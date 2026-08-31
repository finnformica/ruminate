/**
 * Live end-to-end check of the multi-tenant replica path (schema v2, one
 * `UserCorpus` Durable Object per user — docs/multi-tenant-design.md).
 *
 * Runs the REAL worker — `worker/index.ts` bundled by esbuild, executed in
 * workerd via Miniflare — so routing, `requireSession` (cookie + bearer +
 * control-plane tenancy), the tenant-addressing invariant, the `UserCorpus`
 * DO (constructor migration ladder + RPC methods), the tenant-#1 admin
 * migration, and the per-row LWW SQL all run for real. The D1 control plane
 * is the same `.wrangler/state` database `wrangler dev` uses; the corpus DO
 * state is wiped at start (fresh each run) so the script is repeatable. The
 * only stub is GitHub: Miniflare's `outboundService` answers the one outbound
 * `GET https://api.github.com/user` call, mapping test tokens to identities.
 *
 * (Wrangler's `getPlatformProxy` cannot host same-worker Durable Objects —
 * it only proxies bindings, warning that internal DO bindings "will not work
 * in local development" — hence Miniflare directly, which is what
 * `getPlatformProxy` wraps anyway.)
 *
 * Prereq: npx wrangler d1 migrations apply ruminate --local
 * Run:    npx vite-node scripts/replica-e2e.ts
 */
import { strict as assert } from "node:assert"
import { build } from "esbuild"
import { convertV4MiniflareOptions, Miniflare, Response as WorkerdResponse } from "miniflare"
import { parse } from "../src/blocks/parse"
import { serialize } from "../src/blocks/serialize"
import { buildGraphSnapshot, docToGraph, rollup } from "../src/data/graph"
import type {
  LinkRow,
  NodeRow,
  ReplicaChangesBody,
  ReplicaCorpusBody,
  ReplicaStatusBody,
} from "../worker/handlers/replica-payload"

// The identities the GitHub stub vends, keyed by bearer token. The owner id
// matches wrangler.jsonc's ALLOWED_GITHUB_ID (and the 0003 allowlist seed);
// the guest is allowlisted by this script; the outsider is a valid GitHub
// account that must stay locked out (SIGNUP_MODE=allowlist).
const IDENTITIES: Record<string, { id: number; login: string }> = {
  "e2e-owner-token": { id: 42536816, login: "e2e-owner" },
  "e2e-guest-token": { id: 424242, login: "e2e-guest" },
  "e2e-outsider-token": { id: 999999, login: "e2e-outsider" },
}
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

// `node:fs/promises` via `getBuiltinModule`, dodging the vite node-polyfills
// alias (same trick as src/data/sql-node-test-driver.ts).
const { rm } = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process!
  .getBuiltinModule!("node:fs/promises") as {
  rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>
}

async function main() {
  // Start from fresh corpus DOs so every assertion is deterministic and the
  // script is repeatable. Local-dev-only state, and self-healing: if wrangler
  // dev is used afterwards, the owner's empty DO re-imports from the D1
  // corpus via the lazy tenant-#1 fallback in worker/handlers/replica.ts.
  await rm(".wrangler/state/v3/do/ruminate-UserCorpus", { recursive: true, force: true })

  // The real worker, bundled the way wrangler bundles it: `.sql` imports as
  // text (the `rules` stanza), `cloudflare:workers` provided by the runtime.
  const bundle = await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
    loader: { ".sql": "text" },
  })

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "ruminate",
      compatibilityDate: "2026-08-20",
      script: bundle.outputFiles[0].text,
      modules: true,
      bindings: {
        VITE_GITHUB_CLIENT_ID: "e2e",
        GITHUB_CLIENT_SECRET: "e2e",
        ALLOWED_GITHUB_ID: "42536816",
        SIGNUP_MODE: "allowlist",
      },
      // The same local D1 state `wrangler dev` / `wrangler d1 migrations
      // apply --local` use.
      d1Databases: { DB: "7bf20efd-53cd-4605-b0b6-8805a9faab9e" },
      resourcePersistencePath: ".wrangler/state/v3",
      durableObjects: { CORPUS: { className: "UserCorpus", useSQLite: true } },
      outboundService: async (request) => {
        const url = new URL(request.url)
        if (url.origin === "https://api.github.com" && url.pathname === "/user") {
          const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]
          const identity = token ? IDENTITIES[token] : undefined
          if (!identity) return new WorkerdResponse("{}", { status: 401 })
          return new WorkerdResponse(JSON.stringify(identity), { status: 200 })
        }
        return new WorkerdResponse(`unexpected outbound fetch: ${request.url}`, { status: 500 })
      },
    }),
  )

  const api = async (path: string, init?: Parameters<typeof mf.dispatchFetch>[1]) =>
    mf.dispatchFetch(`https://ruminate.test${path}`, init)
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

  const db = await mf.getD1Database("DB")
  const d1Counts = async () => {
    const row = await db
      .prepare("SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM link) AS links")
      .first<{ nodes: number; links: number }>()
    return { nodes: row?.nodes ?? 0, links: row?.links ?? 0 }
  }

  try {
    // --- auth guards: no cookie / no bearer / unknown token → 401;
    //     a VALID GitHub identity outside the allowlist → 403, fail closed
    assert.equal(
      (await api("/api/replica/notes", { headers: { Authorization: "Bearer e2e-owner-token" } }))
        .status,
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

    // --- tenant #1 migration: seed rows into the legacy D1 corpus, then have
    //     the owner run POST /api/admin/migrate-corpus into their (empty) DO
    // (Pre-clean first, in case an earlier aborted run left its seeds behind.)
    await db.batch([
      db.prepare("DELETE FROM link WHERE source_id = 'e2e-migrated-note'"),
      db.prepare("DELETE FROM nodes WHERE id IN ('e2e-migrated-note', 'blk_e2emig0001')"),
      db.prepare("DELETE FROM allowlist WHERE github_id = ?1").bind(GUEST_ID),
      db.prepare("DELETE FROM users WHERE github_id = ?1").bind(GUEST_ID),
    ])
    const d1Before = await d1Counts()
    await db.batch([
      db
        .prepare(
          "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind("e2e-migrated-note", "page", "e2e-migrated-note", null, T0),
      db
        .prepare(
          "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind("blk_e2emig0001", "text", "Migrated block", null, T0),
      db
        .prepare(
          "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) VALUES (?1, ?2, 'child', 'a0', ?3)",
        )
        .bind("e2e-migrated-note", "blk_e2emig0001", T0),
    ])
    const d1Seeded = await d1Counts()

    const guestMigrate = await api("/api/admin/migrate-corpus", {
      method: "POST",
      headers: authHeaders("e2e-guest-token"),
    })
    assert.equal(guestMigrate.status, 403) // guest isn't allowlisted yet, and never owner

    const migrate = await api("/api/admin/migrate-corpus", {
      method: "POST",
      headers: authHeaders("e2e-owner-token"),
    })
    assert.equal(migrate.status, 200)
    const migrateResult = (await migrate.json()) as Record<string, unknown>
    assert.deepEqual(migrateResult, {
      migrated: true,
      reason: "imported",
      nodes: d1Seeded.nodes,
      links: d1Seeded.links,
    })

    const afterMigrate = await status()
    assert.equal(afterMigrate.schema_version, "2") // the DO ran the real ladder
    assert.equal(afterMigrate.counts.nodes, d1Seeded.nodes)
    assert.equal(afterMigrate.counts.links, d1Seeded.links)

    // Re-running is refused: the DO corpus is no longer empty.
    const remigrate = await api("/api/admin/migrate-corpus", {
      method: "POST",
      headers: authHeaders("e2e-owner-token"),
    })
    assert.equal(((await remigrate.json()) as { reason: string }).reason, "corpus_not_empty")
    console.log(
      `tenant #1 migration: D1 corpus (${d1Seeded.nodes} nodes) imported into the owner DO, idempotent ✓`,
    )

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
    console.log("PUT: rows landed in the owner's DO, status counts + cursor confirmed ✓")

    // --- GET pull (database-authoritative boot + sync source)
    const fullPull = await api("/api/replica/notes", { headers: authHeaders("e2e-owner-token") })
    assert.equal(fullPull.status, 200)
    const corpus = (await fullPull.json()) as ReplicaCorpusBody
    assert.equal(corpus.cursor, cursor)
    assert.equal(e2eNodes(corpus.nodes).length, 7) // 5 pushed + 2 migrated
    assert.equal(e2eLinks(corpus.links).length, 4) // 3 pushed + 1 migrated
    assert.deepEqual(
      corpus.nodes
        .filter((row) => /^(blk_e2e[ab]|e2e-note)/.test(row.id))
        .map((row) => `${row.id}|${row.type}|${row.text}`)
        .sort(),
      [
        "blk_e2ea000001|ul|Hello [[e2e-note-b]] #e2e",
        "blk_e2ea000002|ul|Nested ((blk_e2eb000001))",
        "blk_e2eb000001|ul|Plain note",
        "e2e-note-a|page|e2e-note-a",
        "e2e-note-b|page|e2e-note-b",
      ],
    )
    // The pulled rows roll up to the exact canonical markdown that was ingested.
    const snapshot = buildGraphSnapshot(corpus.nodes, corpus.links)
    assert.equal(rollup("e2e-note-a", snapshot), serialize(parse(NOTE_A)))
    assert.equal(rollup("e2e-note-b", snapshot), NOTE_B)
    assert.equal(rollup("e2e-migrated-note", snapshot), "Migrated block\n  id:: blk_e2emig0001\n")
    console.log("GET full: rollup reproduces the ingested AND migrated markdown ✓")

    // --- since pull: changed rows + full key lists
    const sincePull = await api(`/api/replica/notes?since=${T0 - 1000}`, {
      headers: authHeaders("e2e-owner-token"),
    })
    assert.equal(sincePull.status, 200)
    const changes = (await sincePull.json()) as ReplicaChangesBody
    assert.equal(e2eNodes(changes.nodes).length, 7)
    assert.ok(changes.nodeIds.includes("e2e-note-a") && changes.nodeIds.includes("blk_e2eb000001"))
    assert.ok(changes.linkKeys.some(([s, d]) => s === "e2e-note-b" && d === "blk_e2eb000001"))

    const sinceAfter = await api(`/api/replica/notes?since=${Date.now() + 60_000}`, {
      headers: authHeaders("e2e-owner-token"),
    })
    const noChanges = (await sinceAfter.json()) as ReplicaChangesBody
    assert.equal(e2eNodes(noChanges.nodes).length, 0)
    assert.equal(e2eLinks(noChanges.links).length, 0)
    // Unchanged rows still appear in the key lists — deletion stays detectable.
    assert.ok(noChanges.nodeIds.includes("e2e-note-b"))

    const badSince = await api("/api/replica/notes?since=nope", {
      headers: authHeaders("e2e-owner-token"),
    })
    assert.equal(badSince.status, 400)
    console.log("GET since: changed rows + full key lists, 400 on malformed since ✓")

    // --- per-row LWW: replays are idempotent, stale rows cannot clobber newer
    const replay = await put({
      nodes: [...graphA.nodes, ...graphB.nodes],
      links: [...graphA.links, ...graphB.links],
    })
    assert.equal(replay.status, 200)
    assert.deepEqual((await status()).counts, after.counts)

    const newer = { ...graphB.nodes[1], text: "Edited note", updated_at: T0 + 1000 }
    await put({ nodes: [newer], links: [] })
    const stale = { ...graphB.nodes[1], text: "Stale edit", updated_at: T0 - 5000 }
    await put({ nodes: [stale], links: [] })
    const pulled = (await (
      await api("/api/replica/notes", { headers: authHeaders("e2e-owner-token") })
    ).json()) as ReplicaCorpusBody
    assert.equal(pulled.nodes.find((row) => row.id === "blk_e2eb000001")?.text, "Edited note")
    console.log("per-row LWW: replay idempotent, stale row rejected ✓")

    // --- tenant isolation + the addressing invariant, over real HTTP:
    //     allowlist the guest, who then gets an EMPTY corpus (never the
    //     owner's rows), and whose claimed-tenant params change nothing.
    await db
      .prepare("INSERT INTO allowlist (github_id, note) VALUES (?1, 'e2e')")
      .bind(GUEST_ID)
      .run()
    const guestPull = await api("/api/replica/notes?github_id=42536816&tenant=42536816", {
      headers: { ...authHeaders("e2e-guest-token"), "X-GitHub-Id": "42536816" },
    })
    assert.equal(guestPull.status, 200)
    const guestCorpus = (await guestPull.json()) as ReplicaCorpusBody
    assert.equal(guestCorpus.nodes.length, 0) // not the owner's corpus — empty
    assert.equal(guestCorpus.links.length, 0)

    const guestPut = await put(
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
    assert.equal(guestPut.status, 200)
    const guestSince = (await (
      await api("/api/replica/notes?since=0", { headers: authHeaders("e2e-guest-token") })
    ).json()) as ReplicaChangesBody
    assert.deepEqual(guestSince.nodeIds, ["e2e-guest-note"]) // and ONLY that

    const ownerAfterGuest = (await (
      await api("/api/replica/notes", { headers: authHeaders("e2e-owner-token") })
    ).json()) as ReplicaCorpusBody
    assert.ok(!ownerAfterGuest.nodes.some((row) => row.id === "e2e-guest-note"))
    assert.deepEqual((await status("e2e-guest-token")).counts, { nodes: 1, links: 0, pages: 1 })
    assert.deepEqual((await status()).counts, after.counts) // owner untouched by guest writes
    console.log("tenant isolation: guest sees an empty corpus, claimed-tenant params ignored ✓")

    // --- row deletes: one link, then whole subtrees, restoring the DO counts
    await put({
      nodes: [],
      links: [],
      deleteLinks: [["blk_e2ea000001", "blk_e2ea000002", "child"]],
    })
    const afterLinkDelete = await status()
    assert.equal(afterLinkDelete.counts.links, after.counts.links - 1)

    const del = await put({
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
    assert.equal(del.status, 200)
    assert.deepEqual((await status()).counts, before.counts)
    console.log("deletes restored the pre-push counts ✓")

    // --- the legacy D1 corpus was READ, never written: still exactly as seeded
    assert.deepEqual(await d1Counts(), d1Seeded)

    // --- cleanup: remove everything this run added to the persistent D1
    await db.batch([
      db.prepare("DELETE FROM link WHERE source_id = 'e2e-migrated-note'"),
      db.prepare("DELETE FROM nodes WHERE id IN ('e2e-migrated-note', 'blk_e2emig0001')"),
      db.prepare("DELETE FROM allowlist WHERE github_id = ?1").bind(GUEST_ID),
      db.prepare("DELETE FROM users WHERE github_id = ?1").bind(GUEST_ID),
    ])
    assert.deepEqual(await d1Counts(), d1Before)
    console.log("cleanup: local D1 restored ✓")
  } finally {
    await mf.dispose()
  }

  console.log("\nreplica e2e: all assertions passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
