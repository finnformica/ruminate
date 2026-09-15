// The admin API — `/api/admin/*` (docs/multi-tenant-design.md §3).
//
// The bootstrap owner's controls: invite links, which admit people without
// an allowlist, and the feature flags (src/data/feature-flags.ts). Reached by
// the admin page in the browser, so it authenticates like every other
// browser-facing route — `requireSession`, the cookie + GitHub token check —
// and then asks one more question: is this verified id the admin? Nobody
// else gets past the first line, whatever the path.
//
// Routes:
//   GET    /api/admin/invites         — every invite, newest first
//   POST   /api/admin/invites         — mint one; answers with the link's token, once
//   DELETE /api/admin/invites/<id>    — revoke a live invite
//   GET    /api/admin/features        — every flag's audience
//   PUT    /api/admin/features/<key>  — set one flag's audience

import { isAudience, isFeatureKey } from "../../src/data/feature-flags"
import type { FeatureAudiencesBody, InvitesListBody, MintedInviteBody } from "../admin-wire"
import { featureAudiences, isAdmin, setFeatureAudience } from "../features"
import {
  DEFAULT_INVITE_DAYS,
  listInvites,
  MAX_INVITE_DAYS,
  mintInvite,
  revokeInvite,
} from "../invites"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const ADMIN_PREFIX = "/api/admin"

const MAX_NOTE_LENGTH = 80

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/** Validate the mint request. Returns the parsed body or the reason it is
 * refused, written for the person filling in the form. */
function parseMintBody(raw: unknown): { note: string | null; expiresInDays: number } | string {
  if (raw !== null && typeof raw !== "object") return "Body must be an object."
  const body = (raw ?? {}) as Record<string, unknown>

  let note: string | null = null
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") return "`note` must be text."
    note = body.note.trim()
    if (note.length === 0) note = null
    else if (note.length > MAX_NOTE_LENGTH)
      return `The note must be ${MAX_NOTE_LENGTH} characters or fewer.`
  }

  let expiresInDays = DEFAULT_INVITE_DAYS
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = body.expiresInDays
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS) {
      return `\`expiresInDays\` must be a whole number of days between 1 and ${MAX_INVITE_DAYS}.`
    }
    expiresInDays = days
  }

  return { note, expiresInDays }
}

/** Route `/api/admin/*`. Every route is session-guarded AND admin-only. */
export async function admin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  // The same 404 a route that does not exist gets: the admin API confirms
  // nothing about itself to anyone but the admin.
  if (!isAdmin(env, session.id)) return json({ error: "not_found" }, 404)

  const { pathname } = new URL(request.url)
  const segments = pathname
    .slice(ADMIN_PREFIX.length)
    .replace(/^\//, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent)
  const control = controlPlaneDriver(env)

  try {
    if (segments[0] === "invites") {
      if (segments.length === 1) {
        if (request.method === "GET") {
          const body: InvitesListBody = { invites: await listInvites(control) }
          return json(body)
        }
        if (request.method === "POST") {
          let raw: unknown = null
          try {
            raw = await request.json()
          } catch {
            // An empty body means "the defaults".
          }
          const parsed = parseMintBody(raw)
          if (typeof parsed === "string")
            return json({ error: "invalid_request", detail: parsed }, 400)
          const minted = await mintInvite(control, { createdBy: session.id, ...parsed })
          const body: MintedInviteBody = { token: minted.token, invite: minted.summary }
          return json(body, 201)
        }
        return json({ error: "method_not_allowed" }, 405)
      }
      if (segments.length === 2) {
        if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405)
        const revoked = await revokeInvite(control, segments[1])
        return revoked ? json({ ok: true, id: segments[1] }) : json({ error: "not_found" }, 404)
      }
    }

    if (segments[0] === "features") {
      if (segments.length === 1) {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405)
        const body: FeatureAudiencesBody = { audiences: await featureAudiences(control) }
        return json(body)
      }
      if (segments.length === 2) {
        if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405)
        const key = segments[1]
        if (!isFeatureKey(key)) return json({ error: "not_found" }, 404)
        const raw = (await request.json().catch(() => null)) as { audience?: unknown } | null
        if (!raw || !isAudience(raw.audience)) {
          return json(
            { error: "invalid_request", detail: "`audience` must be off, admin or everyone." },
            400,
          )
        }
        await setFeatureAudience(control, key, raw.audience, session.id)
        const body: FeatureAudiencesBody = { audiences: await featureAudiences(control) }
        return json(body)
      }
    }
  } catch {
    // The feature_flags or invites table (migrations/0013, 0014) is not there yet.
    return json(
      {
        error: "admin_unavailable",
        detail: "The admin tables are not set up on this server yet (a migration is pending).",
      },
      503,
    )
  }

  return json({ error: "not_found" }, 404)
}
