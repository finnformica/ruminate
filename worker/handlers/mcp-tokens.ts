// Token management — `/api/mcp/tokens` (docs/mcp-server.md).
//
// The other half of the MCP feature: the endpoints the SETTINGS PAGE uses to
// mint, list and revoke the grants agents present at `/mcp`. Reached by a
// browser, so it authenticates like every other browser-facing route —
// `requireSession`, the same cookie + GitHub token check the replica uses —
// and NOT with an MCP token. That asymmetry is deliberate and load-bearing:
//
//   **an MCP token can never mint another MCP token.**
//
// Only a person at a keyboard, signed in to GitHub, can widen what an agent
// may do. An agent that talks its way into any amount of mischief still
// cannot grant itself a permission it was not given, cannot reach a note it
// was not scoped to, and cannot outlive the revoke button.
//
// The note ids a grant names are validated against the caller's OWN corpus
// through a `TenantDb`, so a grant cannot be minted over a note that does not
// exist or is not theirs — the scope means something the moment it is stored,
// not only when it is enforced.

import { corpusDriver, controlPlaneDriver, forTenant } from "../tenancy-db"
import type { Env } from "../types"
import { PERMISSIONS, type Permission } from "../mcp/grant"
import { listTokens, mintToken, revokeToken } from "../mcp/tokens"
import { requireSession } from "./replica"

export const MCP_TOKENS_PREFIX = "/api/mcp/tokens"

const MAX_NAME_LENGTH = 80
/** A grant over more notes than this is, in practice, a grant over all of
 * them — and the list is stored as JSON on a row read on every agent request. */
const MAX_SCOPED_NOTES = 100
const MAX_EXPIRY_DAYS = 365
const MAX_TOKENS_PER_USER = 50

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

interface MintBody {
  name: string
  permissions: Permission[]
  noteIds: string[] | null
  expiresAt: number | null
}

/** Validate the mint request. Returns the parsed body or the reason it is
 * refused — every refusal names the field, because this one is read by a
 * person filling in a form. */
function parseMintBody(raw: unknown, now: number): MintBody | string {
  if (typeof raw !== "object" || raw === null) return "Body must be an object."
  const body = raw as Record<string, unknown>

  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (name.length === 0) return "Give the token a name so you can recognize it later."
  if (name.length > MAX_NAME_LENGTH)
    return `The name must be ${MAX_NAME_LENGTH} characters or fewer.`

  if (!Array.isArray(body.permissions) || body.permissions.length === 0) {
    return "Choose at least one permission."
  }
  const permissions: Permission[] = []
  for (const entry of body.permissions) {
    if (typeof entry !== "string" || !(PERMISSIONS as readonly string[]).includes(entry)) {
      return `Unknown permission: ${String(entry)}.`
    }
    if (!permissions.includes(entry as Permission)) permissions.push(entry as Permission)
  }

  // Null means every note. An empty ARRAY is refused rather than stored:
  // silently widening it to "all notes" would be the worst possible reading
  // of an empty scope, and storing it would mint a token that can do nothing.
  let noteIds: string[] | null = null
  if (body.noteIds !== undefined && body.noteIds !== null) {
    if (!Array.isArray(body.noteIds)) return "`noteIds` must be a list of note ids, or null."
    if (body.noteIds.length === 0) {
      return "Pick at least one note, or leave the scope unset for every note."
    }
    if (body.noteIds.length > MAX_SCOPED_NOTES) {
      return `Scope a token to at most ${MAX_SCOPED_NOTES} notes, or to every note.`
    }
    const unique = new Set<string>()
    for (const entry of body.noteIds) {
      if (typeof entry !== "string" || entry.length === 0) return "`noteIds` must be note ids."
      unique.add(entry)
    }
    noteIds = [...unique]
  }

  let expiresAt: number | null = null
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = body.expiresInDays
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
      return `\`expiresInDays\` must be a whole number of days between 1 and ${MAX_EXPIRY_DAYS}.`
    }
    expiresAt = now + days * 24 * 60 * 60 * 1000
  }

  return { name, permissions, noteIds, expiresAt }
}

/** Which of these ids are live pages in the caller's own corpus. */
async function ownPageIds(env: Env, userId: number, ids: string[]): Promise<Set<string>> {
  const tenant = forTenant(corpusDriver(env), { id: userId, login: String(userId), name: null })
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ")
  const rows = await tenant.exec(
    `SELECT id FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL ` +
      `AND type = 'page' AND id IN (${placeholders})`,
    ids,
  )
  return new Set(rows.map((row) => String(row.id)))
}

/** Route `/api/mcp/tokens[/<id>]`. Every route is session-guarded. */
export async function mcpTokens(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const { pathname } = new URL(request.url)
  const rest = pathname.slice(MCP_TOKENS_PREFIX.length)
  const control = controlPlaneDriver(env)

  if (rest === "" || rest === "/") {
    if (request.method === "GET") return json({ tokens: await listTokens(control, session.id) })
    if (request.method === "POST") return mint(request, env, control, session.id)
    return json({ error: "method_not_allowed" }, 405)
  }

  const id = decodeURIComponent(rest.replace(/^\//, ""))
  if (id === "" || id.includes("/")) return json({ error: "not_found" }, 404)
  if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405)

  const revoked = await revokeToken(control, session.id, id)
  return revoked ? json({ ok: true, id }) : json({ error: "not_found" }, 404)
}

async function mint(
  request: Request,
  env: Env,
  control: ReturnType<typeof controlPlaneDriver>,
  userId: number,
): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  const now = Date.now()
  const parsed = parseMintBody(raw, now)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  const existing = await listTokens(control, userId)
  if (existing.filter((token) => token.revokedAt === null).length >= MAX_TOKENS_PER_USER) {
    return json(
      {
        error: "too_many_tokens",
        detail: `Revoke an unused token first — ${MAX_TOKENS_PER_USER} live tokens is the limit.`,
      },
      409,
    )
  }

  // A scope is only worth storing if it names notes that exist and are the
  // caller's. Checked through a `TenantDb`, so "are they the caller's" is the
  // same question the corpus answers everywhere else.
  if (parsed.noteIds !== null) {
    const own = await ownPageIds(env, userId, parsed.noteIds)
    const missing = parsed.noteIds.filter((id) => !own.has(id))
    if (missing.length > 0) {
      return json(
        {
          error: "invalid_request",
          detail: `These are not notes in your corpus: ${missing.join(", ")}.`,
        },
        400,
      )
    }
  }

  const minted = await mintToken(control, {
    userId,
    name: parsed.name,
    permissions: parsed.permissions,
    noteIds: parsed.noteIds,
    expiresAt: parsed.expiresAt,
    now,
  })

  // The one and only time the secret leaves the server. The client says so
  // to the user, because there is no second chance to copy it.
  return json({ token: minted.token, summary: minted.summary }, 201)
}
