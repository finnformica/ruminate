// The profile fixtures for shots mode (docs/screenshots.md): one user's real
// data, read from a SQLite copy of production D1.
//
//   npm run shots:profile -- [--db <file>] [--out <dir>] [--user <github id>]
//
// Defaults: --db /home/orca/ruminate-prod-clone/ruminate-prod-20261030.sqlite,
// --out /home/orca/ruminate-prod-clone/fixtures, --user 42536816 (the owner).
//
// THIS IS PRIVATE DATA. finnformica/ruminate is a public repo, and PR shots
// are posted in the public PR body. The output must stay outside the repo:
// the script refuses an --out inside it, writes the file with mode 600, and
// prints counts only, never a row. Never commit the output, and never put a
// shot taken from it into a PR.
//
// A plain file read: `node:sqlite`, read-only, no server. The rows are
// shaped as the Worker's routes answer them, so the mock API serves them as
// it serves the demo set. Received shares are left out: their rows are
// other people's data.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const dbFile = option("--db", "/home/orca/ruminate-prod-clone/ruminate-prod-20261030.sqlite")
const outDir = path.resolve(option("--out", "/home/orca/ruminate-prod-clone/fixtures"))
const userId = Number(option("--user", "42536816"))

if (!existsSync(dbFile)) fail(`no database at ${dbFile}`)
if (!Number.isSafeInteger(userId)) fail("--user must be a GitHub id")
const relative = path.relative(ROOT, outDir)
if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
  fail(`--out ${outDir} is inside the repo; profile fixtures must stay outside it`)
}

const db = new DatabaseSync(dbFile, { readOnly: true })
const tables = new Set(
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name),
)

const user = db
  .prepare("SELECT github_id, login, name, email FROM users WHERE github_id = ?")
  .get(userId)
if (!user) fail(`no user ${userId} in ${dbFile}`)

// The per-key log, shaped as `GET /api/replica/events-log` answers it
// (`parseStoredKeyEvent`, src/data/key-events.ts).
const events = db
  .prepare(
    "SELECT seq, id, entity, entity_id, action, key, value, v, batch, origin, device, cause, " +
      "actor, base_seq, ref_seq, at, tz, hlc, received_at, event_id, event_seq " +
      "FROM events_log WHERE user_id = ? ORDER BY seq",
  )
  .all(userId)
  .map((row) => {
    const event = {
      id: row.id,
      seq: row.seq,
      entity: row.entity,
      entity_id: row.entity_id,
      action: row.action,
      key: row.key,
      value: JSON.parse(row.value),
      batch: row.batch,
      device: row.device,
      base_seq: row.base_seq,
      at: row.at,
      v: row.v,
      origin: row.origin,
      actor: row.actor,
      received_at: row.received_at,
    }
    if (row.cause !== null) event.cause = row.cause
    if (row.ref_seq !== null) event.ref_seq = row.ref_seq
    else if (row.action === "restore") event.ref_seq = null
    if (row.tz !== null) event.tz = row.tz
    if (row.hlc !== null) event.hlc = row.hlc
    if (row.event_id !== null) event.event = row.event_id
    if (row.event_seq !== null) event.event_seq = row.event_seq
    return event
  })

const meta = (key) =>
  db.prepare("SELECT value FROM meta WHERE user_id = ? AND key = ?").get(userId, key)?.value ?? null
const preferences = (() => {
  try {
    return JSON.parse(meta("preferences") ?? "{}")
  } catch {
    return {}
  }
})()

const given = tables.has("shares")
  ? db
      .prepare(
        "SELECT id, grantee_email, view_id, permissions, created_at FROM shares " +
          "WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
      )
      .all(userId)
      .map((row) => ({
        id: row.id,
        granteeEmail: row.grantee_email,
        // The view table is gone (0031): the view id was the root's own.
        view: { id: row.view_id, rootId: row.view_id, filter: null, sort: null },
        permissions: String(row.permissions).split(",").filter(Boolean),
        createdAt: row.created_at,
        revokedAt: null,
        revokedBy: null,
      }))
  : []

const fixtures = {
  kind: "profile",
  anchorDay: null,
  user: { id: user.github_id, login: user.login, name: user.name ?? user.login, email: user.email },
  events,
  features: { admin: false, features: { mcp: true, cloudflareAi: true } },
  preferences: {
    preferences: {
      whatsNewCard: preferences.whatsNewCard === true,
      useCloudflareAi: preferences.useCloudflareAi === true,
    },
  },
  shares: { me: { email: user.email }, given, received: [] },
  slices: {},
  mcpTokens: [],
  anthropicKey: { set: false, last4: null },
  reminders: { publicKey: "BProfilePublicKeyForShotsOnly", reminder: null },
}

mkdirSync(outDir, { recursive: true, mode: 0o700 })
const file = path.join(outDir, "fixtures.json")
writeFileSync(file, JSON.stringify(fixtures), { mode: 0o600 })
chmodSync(file, 0o600)
console.log(`wrote ${file} (mode 600): ${events.length} events, ${given.length} shares given`)
console.log("PROFILE DATA: private. Never commit it, and never post a shot of it in a PR.")

function fail(message) {
  console.error(`shots:profile: ${message}`)
  process.exit(1)
}
