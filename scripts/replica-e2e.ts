/**
 * Live end-to-end check of the D1 replica path (schema v2).
 *
 * Drives the real Worker handler (`worker/handlers/replica.ts`) against the
 * real local D1 database (the same `.wrangler/state` store `wrangler dev`
 * uses, via wrangler's `getPlatformProxy`), with rows built by the real
 * ingest (`docToGraph` from `src/data/graph.ts`). The only stub is the one
 * outbound GitHub token-verification call inside `requireSession` —
 * everything else (cookie check, payload validation, per-row LWW SQL, the
 * atomic D1 batch, the status counts) runs for real.
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

// requireSession verifies the bearer token against api.github.com; stub that
// single upstream call so the rest of the stack runs unmodified.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === "https://api.github.com/user") {
    // The owner identity, matching wrangler.jsonc's ALLOWED_GITHUB_ID.
    return new Response(JSON.stringify({ id: 42536816 }), { status: 200 })
  }
  return realFetch(input, init)
}) as typeof fetch

const NOTE_A =
  "---\nupdated_at: 2026-08-29T12:00:00.000Z\n---\n" +
  "- Hello [[e2e-note-b]] #e2e\n  id:: blk_e2ea000001\n" +
  "  - Nested ((blk_e2eb000001))\n    id:: blk_e2ea000002\n"
const NOTE_B = "- Plain note\n  id:: blk_e2eb000001\n"

const T0 = Date.parse("2026-08-29T12:00:00.000Z")
const graphA = docToGraph("e2e-note-a", NOTE_A, T0)
const graphB = docToGraph("e2e-note-b", NOTE_B, T0)

const AUTH_HEADERS = {
  Cookie: "gh_refresh=e2e-session",
  Authorization: "Bearer e2e-token",
  "Content-Type": "application/json",
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://ruminate.test${path}`, init)
}

async function status(env: Env): Promise<ReplicaStatusBody> {
  const response = await replica(request("/api/replica/status", { headers: AUTH_HEADERS }), env)
  assert.equal(response.status, 200)
  return (await response.json()) as ReplicaStatusBody
}

async function put(env: Env, body: unknown): Promise<Response> {
  return replica(
    request("/api/replica/notes", {
      method: "PUT",
      headers: AUTH_HEADERS,
      body: JSON.stringify(body),
    }),
    env,
  )
}

const e2eNodes = (rows: NodeRow[]) => rows.filter((row) => row.id.includes("e2e"))
const e2eLinks = (rows: LinkRow[]) => rows.filter((row) => row.source_id.includes("e2e"))

async function main() {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc" })
  const env = proxy.env

  // --- auth guard: no session cookie / no bearer → 401, D1 untouched
  const noCookie = await replica(
    request("/api/replica/notes", {
      method: "PUT",
      headers: { Authorization: "Bearer e2e-token" },
      body: "{}",
    }),
    env,
  )
  assert.equal(noCookie.status, 401)
  const noToken = await replica(
    request("/api/replica/status", { headers: { Cookie: "gh_refresh=e2e-session" } }),
    env,
  )
  assert.equal(noToken.status, 401)
  console.log("auth guard: 401 without cookie or bearer token ✓")

  const before = await status(env)
  assert.equal(before.schema_version, "2")
  console.log("status before:", JSON.stringify(before))

  // --- push two notes' rows, built by the real ingest
  const cursor = String(Date.now())
  const putResponse = await put(env, {
    nodes: [...graphA.nodes, ...graphB.nodes],
    links: [...graphA.links, ...graphB.links],
    cursor,
  })
  assert.equal(putResponse.status, 200)
  assert.deepEqual(await putResponse.json(), { ok: true, nodes: 5, links: 3, deletes: 0 })

  // --- rows landed: check them straight out of D1
  const nodeRows = await env.DB.prepare(
    "SELECT id, type, text, props, updated_at FROM nodes WHERE id LIKE '%e2e%' ORDER BY id",
  ).all<NodeRow>()
  assert.deepEqual(
    nodeRows.results.map((row) => `${row.id}|${row.type}|${row.text}`),
    [
      "blk_e2ea000001|ul|Hello [[e2e-note-b]] #e2e",
      "blk_e2ea000002|ul|Nested ((blk_e2eb000001))",
      "blk_e2eb000001|ul|Plain note",
      "e2e-note-a|page|e2e-note-a",
      "e2e-note-b|page|e2e-note-b",
    ],
  )
  const pageA = nodeRows.results.find((row) => row.id === "e2e-note-a")
  assert.equal(
    pageA?.props,
    JSON.stringify({ frontmatter: "updated_at: 2026-08-29T12:00:00.000Z" }),
  )

  const linkRows = await env.DB.prepare(
    "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link " +
      "WHERE source_id LIKE '%e2e%' ORDER BY source_id, sort_key",
  ).all<LinkRow>()
  assert.deepEqual(
    linkRows.results.map((row) => `${row.source_id}>${row.destination_id}`),
    ["blk_e2ea000001>blk_e2ea000002", "e2e-note-a>blk_e2ea000001", "e2e-note-b>blk_e2eb000001"],
  )
  assert.ok(linkRows.results.every((row) => row.kind === "child" && row.sort_key.length > 0))
  console.log("rows landed in D1: 5 nodes, 3 links ✓")

  // --- status reflects the push and echoes the cursor
  const after = await status(env)
  assert.equal(after.counts.nodes, before.counts.nodes + 5)
  assert.equal(after.counts.links, before.counts.links + 3)
  assert.equal(after.counts.pages, before.counts.pages + 2)
  assert.equal(after.replica_cursor, cursor)
  console.log("status counts + cursor confirmed ✓")

  // --- GET pull (database-authoritative boot + sync source)
  const noAuthPull = await replica(request("/api/replica/notes"), env)
  assert.equal(noAuthPull.status, 401)

  const fullPull = await replica(request("/api/replica/notes", { headers: AUTH_HEADERS }), env)
  assert.equal(fullPull.status, 200)
  const corpus = (await fullPull.json()) as ReplicaCorpusBody
  assert.equal(corpus.cursor, cursor)
  assert.equal(e2eNodes(corpus.nodes).length, 5)
  assert.equal(e2eLinks(corpus.links).length, 3)
  // The pulled rows roll up to the exact canonical markdown that was ingested.
  const snapshot = buildGraphSnapshot(corpus.nodes, corpus.links)
  assert.equal(rollup("e2e-note-a", snapshot), serialize(parse(NOTE_A)))
  assert.equal(rollup("e2e-note-b", snapshot), NOTE_B)
  console.log(`GET full: rows pulled, rollup reproduces the ingested markdown ✓`)

  // --- since pull: changed rows + full key lists
  const sincePull = await replica(
    request(`/api/replica/notes?since=${T0 - 1000}`, { headers: AUTH_HEADERS }),
    env,
  )
  assert.equal(sincePull.status, 200)
  const changes = (await sincePull.json()) as ReplicaChangesBody
  assert.equal(e2eNodes(changes.nodes).length, 5)
  assert.ok(changes.nodeIds.includes("e2e-note-a") && changes.nodeIds.includes("blk_e2eb000001"))
  assert.ok(changes.linkKeys.some(([s, d]) => s === "e2e-note-b" && d === "blk_e2eb000001"))

  const sinceAfter = await replica(
    request(`/api/replica/notes?since=${Date.now() + 60_000}`, { headers: AUTH_HEADERS }),
    env,
  )
  const noChanges = (await sinceAfter.json()) as ReplicaChangesBody
  assert.equal(e2eNodes(noChanges.nodes).length, 0)
  assert.equal(e2eLinks(noChanges.links).length, 0)
  // Unchanged rows still appear in the key lists — deletion stays detectable.
  assert.ok(noChanges.nodeIds.includes("e2e-note-b"))

  const badSince = await replica(
    request("/api/replica/notes?since=nope", { headers: AUTH_HEADERS }),
    env,
  )
  assert.equal(badSince.status, 400)
  console.log("GET since: changed rows + full key lists, 400 on malformed since ✓")

  // --- per-row LWW: replays are idempotent, stale rows cannot clobber newer
  const replay = await put(env, {
    nodes: [...graphA.nodes, ...graphB.nodes],
    links: [...graphA.links, ...graphB.links],
  })
  assert.equal(replay.status, 200)
  assert.deepEqual((await status(env)).counts, after.counts)

  const newer = { ...graphB.nodes[1], text: "Edited note", updated_at: T0 + 1000 }
  await put(env, { nodes: [newer], links: [] })
  const stale = { ...graphB.nodes[1], text: "Stale edit", updated_at: T0 - 5000 }
  await put(env, { nodes: [stale], links: [] })
  const current = await env.DB.prepare("SELECT text FROM nodes WHERE id = 'blk_e2eb000001'").first<{
    text: string
  }>()
  assert.equal(current?.text, "Edited note")
  console.log("per-row LWW: replay idempotent, stale row rejected ✓")

  // --- row deletes: one link, then whole subtrees
  await put(env, {
    nodes: [],
    links: [],
    deleteLinks: [["blk_e2ea000001", "blk_e2ea000002", "child"]],
  })
  const remainingLinks = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM link WHERE source_id LIKE '%e2e%'",
  ).first<{ n: number }>()
  assert.equal(remainingLinks?.n, 2)

  const del = await put(env, {
    nodes: [],
    links: [],
    deleteNodes: ["e2e-note-a", "e2e-note-b", "blk_e2ea000001", "blk_e2ea000002", "blk_e2eb000001"],
  })
  assert.equal(del.status, 200)
  const cleaned = await status(env)
  assert.deepEqual(cleaned.counts, before.counts)
  console.log("deletes restored the pre-test counts ✓")

  await proxy.dispose()
  console.log("\nreplica e2e: all assertions passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
