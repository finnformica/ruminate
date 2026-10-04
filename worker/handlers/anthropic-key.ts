// `/api/anthropic-key` — the signed-in caller's own Anthropic API key, for
// tagging a board's pictures with Claude (docs/boards.md, "Tagging with
// Claude"; a proof of concept). Any signed-in user may keep one.
//
//   GET    → { set, last4 }   whether a key is kept, and its last characters
//   PUT    { key }            keep this key; answers as GET
//   DELETE                    forget it; answers as GET
//
// The key lives in the control plane's `anthropic_keys` table
// (migrations/0018), one row per verified GitHub id, and is read back by
// exactly one thing: the tagging route (board-tag.ts), which sends it to the
// Anthropic API. It is NEVER in a response body, and nothing here logs it.
// The browser holds only the answer to "is one set".

import { isAnthropicKeyShaped, keyLast4, type AnthropicKeyBody } from "../../src/data/auto-tag"
import type { SqlDriver } from "../../src/data/sql-driver"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const ANTHROPIC_KEY_PATH = "/api/anthropic-key"

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/** What the card may know of the kept key: that there is one, and its tail. */
async function keyStatus(driver: SqlDriver, userId: number): Promise<AnthropicKeyBody> {
  const rows = await driver.exec("SELECT last4 FROM anthropic_keys WHERE user_id = ?1", [userId])
  const last4 = rows[0]?.last4
  return typeof last4 === "string" ? { set: true, last4 } : { set: false, last4: null }
}

async function keepKey(driver: SqlDriver, userId: number, key: string, now: number) {
  await driver.exec(
    "INSERT INTO anthropic_keys (user_id, api_key, last4, updated_at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (user_id) DO UPDATE SET api_key = excluded.api_key, " +
      "last4 = excluded.last4, updated_at = excluded.updated_at",
    [userId, key, keyLast4(key), now],
  )
}

async function forgetKey(driver: SqlDriver, userId: number) {
  await driver.exec("DELETE FROM anthropic_keys WHERE user_id = ?1", [userId])
}

/**
 * The kept key, or null — the one read the tagging route makes, and the
 * only place the key leaves this table. The day's calls are counted apart
 * (worker/ai-usage.ts), the same way for every provider; the `calls_*`
 * columns 0018 gave this table are no longer written.
 */
export async function readKey(driver: SqlDriver, userId: number): Promise<string | null> {
  const rows = await driver.exec("SELECT api_key FROM anthropic_keys WHERE user_id = ?1", [userId])
  const key = rows[0]?.api_key
  return typeof key === "string" ? key : null
}

export async function anthropicKey(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  const driver = controlPlaneDriver(env)

  if (request.method === "GET") return json(await keyStatus(driver, session.id))

  if (request.method === "PUT") {
    const raw = (await request.json().catch(() => null)) as { key?: unknown } | null
    const key = typeof raw?.key === "string" ? raw.key.trim() : ""
    if (!isAnthropicKeyShaped(key)) {
      return json(
        { error: "invalid_key", detail: "That does not look like an Anthropic API key." },
        400,
      )
    }
    await keepKey(driver, session.id, key, clock())
    return json(await keyStatus(driver, session.id))
  }

  if (request.method === "DELETE") {
    await forgetKey(driver, session.id)
    return json(await keyStatus(driver, session.id))
  }

  return json({ error: "method_not_allowed" }, 405)
}
