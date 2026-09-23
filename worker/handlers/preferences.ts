// `/api/preferences` — the signed-in caller's account preferences
// (src/data/preferences.ts).
//
// `GET` answers with the preferences as stored, over the defaults. `PUT`
// takes `{ preferences: {…} }` — any subset of the known keys — merges it
// over what is stored, stores the result and answers with the whole. The
// value is one JSON object under the tenant's own `meta` row `preferences`:
// per tenant already (migrations/0004), so nothing new to migrate, and
// beside the tenant's `replica_cursor`, which is the other thing the server
// knows about an account that is not a note.
//
// The client's cached copy is only a cache: a device that saved while
// offline will be overwritten by the next answer here, and that is the
// intended reading — the server holds the account's preference, the device
// holds its last sight of it.

import {
  readPreferences,
  withDefaults,
  type AccountPreferences,
  type PreferencesBody,
} from "../../src/data/preferences"
import { corpusDriver, forTenant, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const PREFERENCES_PATH = "/api/preferences"

/** The `meta` key the object is stored under. */
const META_KEY = "preferences"

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

async function readStored(tenant: TenantDb): Promise<Partial<AccountPreferences>> {
  const rows = await tenant.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
    META_KEY,
  ])
  const value = rows[0]?.value
  if (typeof value !== "string") return {}
  try {
    return readPreferences(JSON.parse(value))
  } catch {
    // A row that is not JSON states nothing; the next save replaces it.
    return {}
  }
}

async function writeStored(tenant: TenantDb, preferences: AccountPreferences): Promise<void> {
  await tenant.exec(
    "INSERT INTO meta (user_id, key, value) VALUES (:tenant, ?1, ?2) " +
      "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
    [META_KEY, JSON.stringify(preferences)],
  )
}

export async function preferences(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  const tenant = forTenant(corpusDriver(env), session)

  if (request.method === "GET") {
    const body: PreferencesBody = { preferences: withDefaults(await readStored(tenant)) }
    return json(body)
  }

  if (request.method === "PUT") {
    const raw = (await request.json().catch(() => null)) as { preferences?: unknown } | null
    if (typeof raw !== "object" || raw === null || typeof raw.preferences !== "object") {
      return json({ error: "invalid_body" }, 400)
    }
    const next = withDefaults({
      ...(await readStored(tenant)),
      ...readPreferences(raw.preferences),
    })
    await writeStored(tenant, next)
    const body: PreferencesBody = { preferences: next }
    return json(body)
  }

  return json({ error: "method_not_allowed" }, 405)
}
