/**
 * Live end-to-end check of the D1 replica path (graph storage, phase 3).
 *
 * Drives the real Worker handler (`worker/handlers/replica.ts`) against the
 * real local D1 database (the same `.wrangler/state` store `wrangler dev`
 * uses, via wrangler's `getPlatformProxy`), with payloads built by the real
 * client builder (`buildReplicaNoteEntry` from `src/data/replica-sync.ts`).
 * The only stub is the one outbound GitHub token-verification call inside
 * `requireSession` — everything else (cookie check, payload validation, SQL
 * planning, the atomic D1 batch, the status counts) runs for real.
 *
 * Prereq: npx wrangler d1 migrations apply ruminate --local
 * Run:    npx vite-node scripts/replica-e2e.ts
 */
import { strict as assert } from "node:assert"
import { getPlatformProxy } from "wrangler"
import { buildReplicaNoteEntry } from "../src/data/replica-sync"
import { replica } from "../worker/handlers/replica"
import type { ReplicaStatusBody } from "../worker/handlers/replica-payload"
import type { Env } from "../worker/types"

// requireSession verifies the bearer token against api.github.com; stub that
// single upstream call so the rest of the stack runs unmodified.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === "https://api.github.com/user") {
    return new Response("{}", { status: 200 })
  }
  return realFetch(input, init)
}) as typeof fetch

const files: Record<string, string> = {
  "e2e-note-a.md":
    "---\nupdated_at: 2026-08-29T12:00:00.000Z\n---\n\n" +
    "- Hello [[e2e-note-b]] #e2e\n  id:: blk_e2ea000001\n" +
    "  - Nested ((blk_e2eb000001))\n    id:: blk_e2ea000002\n",
  "e2e-note-b.md": "- Plain note\n  id:: blk_e2eb000001\n",
  ".ruminate/view-state/e2e-note-a.json": '["blk_e2ea000001"]',
}

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
  console.log("status before:", JSON.stringify(before))

  // --- push two notes with the actual client payload builder
  const cursor = String(Date.now())
  const payload = {
    notes: ["e2e-note-a", "e2e-note-b"].map((id) => {
      const entry = buildReplicaNoteEntry(files, id)
      assert.ok(entry, `buildReplicaNoteEntry(${id})`)
      return entry
    }),
    cursor,
  }
  const put = await replica(
    request("/api/replica/notes", {
      method: "PUT",
      headers: AUTH_HEADERS,
      body: JSON.stringify(payload),
    }),
    env,
  )
  assert.equal(put.status, 200)
  assert.deepEqual(await put.json(), { ok: true, notes: 2, deletes: 0 })

  // --- rows landed: check them straight out of D1
  const notes = await env.DB.prepare(
    "SELECT id, content, updated_at FROM notes WHERE id LIKE 'e2e-note-%' ORDER BY id",
  ).all<{ id: string; content: string; updated_at: number | null }>()
  assert.equal(notes.results.length, 2)
  assert.equal(notes.results[0].content, files["e2e-note-a.md"])
  assert.equal(notes.results[0].updated_at, Date.parse("2026-08-29T12:00:00.000Z"))
  assert.equal(notes.results[1].updated_at, null)

  const blocks = await env.DB.prepare(
    "SELECT id, note_id, parent_id, position FROM blocks WHERE note_id LIKE 'e2e-note-%' ORDER BY note_id, position",
  ).all<{ id: string; note_id: string; parent_id: string | null; position: number }>()
  assert.deepEqual(blocks.results, [
    { id: "blk_e2ea000001", note_id: "e2e-note-a", parent_id: null, position: 0 },
    { id: "blk_e2ea000002", note_id: "e2e-note-a", parent_id: "blk_e2ea000001", position: 0 },
    { id: "blk_e2eb000001", note_id: "e2e-note-b", parent_id: null, position: 0 },
  ])

  const links = await env.DB.prepare(
    "SELECT from_block, to_note, to_block, kind FROM links WHERE from_block LIKE 'blk_e2e%' ORDER BY kind, from_block",
  ).all()
  assert.deepEqual(links.results, [
    { from_block: "blk_e2ea000001", to_note: "e2e", to_block: null, kind: "tag" },
    {
      from_block: "blk_e2ea000002",
      to_note: null,
      to_block: "blk_e2eb000001",
      kind: "transclusion",
    },
    { from_block: "blk_e2ea000001", to_note: "e2e-note-b", to_block: null, kind: "wikilink" },
  ])

  const viewState = await env.DB.prepare(
    "SELECT collapsed FROM view_state WHERE note_id = 'e2e-note-a'",
  ).first<{ collapsed: string }>()
  assert.equal(viewState?.collapsed, '["blk_e2ea000001"]')
  console.log("rows landed in D1: 2 notes, 3 blocks, 3 links, 1 view_state ✓")

  // --- status reflects the push and echoes the cursor
  const after = await status(env)
  assert.equal(after.counts.notes, before.counts.notes + 2)
  assert.equal(after.counts.blocks, before.counts.blocks + 3)
  assert.equal(after.counts.links, before.counts.links + 3)
  assert.equal(after.counts.view_state, before.counts.view_state + 1)
  assert.equal(after.replica_cursor, cursor)
  assert.equal(after.schema_version, "1")
  console.log("status after:", JSON.stringify(after))
  console.log("status counts + cursor confirmed ✓")

  // --- replays are idempotent (per-note replace, OR IGNORE links)
  const replay = await replica(
    request("/api/replica/notes", {
      method: "PUT",
      headers: AUTH_HEADERS,
      body: JSON.stringify(payload),
    }),
    env,
  )
  assert.equal(replay.status, 200)
  const replayed = await status(env)
  assert.deepEqual(replayed.counts, after.counts)
  console.log("replay idempotent ✓")

  // --- deletes clean up all four tables
  const del = await replica(
    request("/api/replica/notes", {
      method: "PUT",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ notes: [], deletes: ["e2e-note-a", "e2e-note-b"] }),
    }),
    env,
  )
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
