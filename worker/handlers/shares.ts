// Sharing — `/api/shares` (docs/sharing.md).
//
// A share is a view shared with someone: an owner names a note or block and
// an email, and the person GitHub reports that email for reads — and, with
// the verbs the owner ticked, edits or deletes — the slice of the owner's
// corpus beneath that root. The share row holds the grant; the root, and the
// filter and sort the grantee opens it with, are the owner's VIEW of the node
// (migrations/0017, docs/metadata.md), read at request time. The slice is
// computed here on every request from the owner's rows
// (`worker/shares/slice.ts`), so it is live and least-privilege by
// construction.
//
// Reached by a browser, so every route authenticates like the replica does —
// `requireSession`, the cookie + GitHub token check — and nothing here takes
// an MCP token.
//
// TENANT-SCOPING: this is the one handler that holds a tenant handle which is
// not the caller's own. It is minted with `forTenant` from the share row's
// `owner_id` — a value the SERVER wrote, under the owner's verified session,
// when the share was created — and from nothing the caller sent. The caller
// reaches that handle only through a share the ledger says is addressed to
// them (`findReceivedShare`: verified id → `users.email`, recorded at sign-in
// → share), and only
// the slice-scoped reads and writes in `slice.ts` ever run on it. Both
// halves are pinned by the adversarial tests in shares.test.ts.
//
// Routes (wired in worker/index.ts):
//   GET    /api/shares            — shares given and received
//   POST   /api/shares            — create a share
//   DELETE /api/shares/:id        — revoke one (owner only)
//   GET    /api/shares/:id/notes  — the slice (grantee only)
//   PUT    /api/shares/:id/notes  — write into the slice (grantee only)

import { controlPlaneDriver, corpusDriver, forTenant } from "../tenancy-db"
import { writeRows, writerOf } from "./event-log"
import type { Env } from "../types"
import { PERMISSIONS, normalizeEmail, type Permission, type ShareGrant } from "../shares/grant"
import {
  applySliceWrite,
  closureIds,
  planSliceWrite,
  resolveShareViews,
  sliceRows,
  takenIds,
} from "../shares/slice"
import {
  countLiveShares,
  createShare,
  emailOf,
  findReceivedShare,
  listGivenShares,
  listReceivedShares,
  revokeShare,
  type ReceivedShare,
} from "../shares/store"
import type { GivenShare, ReceivedShareSummary, ShareView, SharesListBody } from "../shares/wire"
import { featureAllows, featureRefusal } from "../features"
import { parseReplicaPayload } from "./replica-payload"
import { requireSession } from "./replica"
import type { VerifiedIdentity } from "./tenancy"

export const SHARES_PREFIX = "/api/shares"

const MAX_LIVE_SHARES = 50
/** A grantee's push is a coalesced diff of one editing session, never a corpus. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const asGiven = (grant: ShareGrant, view: ShareView): GivenShare => ({
  id: grant.id,
  granteeEmail: grant.granteeEmail,
  view,
  permissions: PERMISSIONS.filter((permission) => grant.permissions.has(permission)),
  createdAt: grant.createdAt,
  revokedAt: grant.revokedAt,
})

const asReceived = ({ grant, owner }: ReceivedShare, view: ShareView): ReceivedShareSummary => ({
  id: grant.id,
  owner: { login: owner.login, name: owner.name },
  view,
  permissions: PERMISSIONS.filter((permission) => grant.permissions.has(permission)),
  createdAt: grant.createdAt,
})

/** A tenant handle for an owner named by a share row — the one handle in
 * the app that is not the caller's own (see the header comment). */
const ownerHandle = (env: Env, ownerId: number) =>
  forTenant(corpusDriver(env), { id: ownerId, login: String(ownerId), name: null })

/** The view behind each received share, resolved under its owner's handle —
 * one query per owner, since shares from one person come from one partition. */
async function receivedViews(env: Env, received: ReceivedShare[]): Promise<Map<string, ShareView>> {
  const byOwner = new Map<number, string[]>()
  for (const { grant } of received) {
    const ids = byOwner.get(grant.ownerId) ?? []
    ids.push(grant.viewId)
    byOwner.set(grant.ownerId, ids)
  }
  const views = new Map<string, ShareView>()
  for (const [ownerId, ids] of byOwner) {
    const resolved = await resolveShareViews(ownerHandle(env, ownerId), ids)
    for (const { grant } of received) {
      if (grant.ownerId !== ownerId) continue
      const view = resolved.get(grant.viewId)
      if (view) views.set(grant.id, view)
    }
  }
  return views
}

/** A view nothing resolved — a grant naming no view at all. */
const NO_VIEW: ShareView = { id: "", rootId: "", filter: null, sort: null }

/** Route `/api/shares[/<id>[/notes]]`. Every route is session-guarded. */
export async function shares(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const { pathname } = new URL(request.url)
  const rest = pathname.slice(SHARES_PREFIX.length)
  const control = controlPlaneDriver(env)

  if (rest === "" || rest === "/") {
    if (request.method === "GET") {
      let listing: { email: string; given: ShareGrant[]; received: ReceivedShare[] }
      try {
        const [email, given, received] = await Promise.all([
          emailOf(control, session.id),
          listGivenShares(control, session.id),
          listReceivedShares(control, session.id),
        ])
        listing = { email, given, received }
      } catch {
        // The shares table (migrations/0012) or the address column
        // (0010/0011) is not there yet: say so, rather than a bare 500 the
        // Settings panel can only show as "request failed".
        return json(
          {
            error: "sharing_unavailable",
            detail: "Sharing is not set up on this server yet (a migration is pending).",
          },
          503,
        )
      }
      // Each share's view, read where it lives: the caller's own partition
      // for what they gave, each owner's for what they received.
      const givenViews = await resolveShareViews(
        forTenant(corpusDriver(env), session),
        listing.given.map((grant) => grant.viewId),
      )
      const views = await receivedViews(env, listing.received)
      const body: SharesListBody = {
        // The caller's OWN address, so Settings can say which address others
        // may share with — read back from the row, which is what shares are
        // resolved against, rather than from whatever the client remembers.
        me: { email: listing.email },
        given: listing.given.map((grant) =>
          asGiven(grant, givenViews.get(grant.viewId) ?? NO_VIEW),
        ),
        received: listing.received.map((entry) =>
          asReceived(entry, views.get(entry.grant.id) ?? NO_VIEW),
        ),
      }
      return json(body)
    }
    if (request.method === "POST") {
      // The feature flag gates GIVING a share. Reading what one has been
      // given stays open: a share only exists because someone allowed to
      // share made it.
      if (!(await featureAllows(control, env, "sharing", session.id))) {
        return json(featureRefusal("sharing"), 403)
      }
      return create(request, env, session)
    }
    return json({ error: "method_not_allowed" }, 405)
  }

  const segments = rest.replace(/^\//, "").split("/").map(decodeURIComponent)
  const id = segments[0] ?? ""
  if (id === "") return json({ error: "not_found" }, 404)

  if (segments.length === 1) {
    if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405)
    const revoked = await revokeShare(control, session.id, id)
    return revoked ? json({ ok: true, id }) : json({ error: "not_found" }, 404)
  }

  if (segments.length === 2 && segments[1] === "notes") {
    // The grantee path: the share must be addressed to THIS verified id.
    // Anything else — someone else's share, a revoked one, an id that does
    // not exist — is the same 404, so the endpoint confirms nothing about
    // shares that are not the caller's.
    const received = await findReceivedShare(control, session.id, id)
    if (received === null) return json({ error: "not_found" }, 404)

    // THE tenant-scoping invariant (see the header comment): the only input
    // to the owner's handle is the owner id on the share row.
    const owner = ownerHandle(env, received.grant.ownerId)

    if (request.method === "GET") {
      const rows = await sliceRows(owner, received.grant)
      // A grant naming no view is a share over nothing: the same 404 as a
      // share that is not the caller's.
      return rows === null ? json({ error: "not_found" }, 404) : json(rows)
    }
    if (request.method === "PUT") return write(request, owner, received.grant, session.id)
    return json({ error: "method_not_allowed" }, 405)
  }

  return json({ error: "not_found" }, 404)
}

interface ParsedCreate {
  email: string
  rootId: string
  permissions: Permission[]
}

/** Validate the create request. Every refusal names the field, because this
 * one is read by a person filling in a form. */
function parseCreateBody(raw: unknown): ParsedCreate | string {
  if (typeof raw !== "object" || raw === null) return "Body must be an object."
  const body = raw as Record<string, unknown>

  const email = normalizeEmail(body.email)
  if (email === null) return "Enter the email address the person signs in to GitHub with."

  // One root per share: a share is one view, and a view has one root.
  if (typeof body.rootId !== "string" || body.rootId.length === 0) {
    return "Pick a note or block to share."
  }

  const permissions: Permission[] = ["read"]
  if (body.permissions !== undefined) {
    if (!Array.isArray(body.permissions)) return "`permissions` must be a list."
    for (const entry of body.permissions) {
      if (typeof entry !== "string" || !(PERMISSIONS as readonly string[]).includes(entry)) {
        return `Unknown permission: ${String(entry)}.`
      }
      if (!permissions.includes(entry as Permission)) permissions.push(entry as Permission)
    }
  }

  return { email, rootId: body.rootId, permissions }
}

/** Is this id a live node — a note or a block — in the caller's own corpus? */
async function ownsNode(tenant: ReturnType<typeof forTenant>, id: string): Promise<boolean> {
  const rows = await tenant.exec(
    `SELECT id FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL AND id = ?1`,
    [id],
  )
  return rows.length > 0
}

/**
 * The owner's view of the node being shared, made where they have none: an
 * empty one — unpinned, unfiltered — under the root's own id, which is the
 * id the client mints too (src/data/views.ts), so the owner saving a filter
 * later lands on this very row. It goes in through the log like any write
 * (`writeRows`), so it carries a `seq` and the owner's devices pull it, and
 * it never overwrites a view the owner has — live or tombstoned: the view IS
 * the share, and what they saved is what is shared.
 */
async function ensureView(
  tenant: ReturnType<typeof forTenant>,
  rootId: string,
  now: number,
): Promise<void> {
  const held = await tenant.exec("SELECT id FROM views WHERE user_id = :tenant AND id = ?1", [
    rootId,
  ])
  if (held.length > 0) return
  const view = {
    id: rootId,
    root_id: rootId,
    filter: null,
    sort: null,
    pinned: false,
    sort_key: null,
    updated_at: now,
  }
  await writeRows(
    tenant,
    { nodes: [], links: [], views: [view] },
    { actor: tenant.userId, origin: "system", device: "share", cause: "share:ensure-view", now },
  )
}

async function create(request: Request, env: Env, session: VerifiedIdentity): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseCreateBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  const control = controlPlaneDriver(env)

  // Sharing with yourself is a no-op that would clutter the list.
  if ((await emailOf(control, session.id)) === parsed.email) {
    return json({ error: "invalid_request", detail: "That is your own address." }, 400)
  }

  if ((await countLiveShares(control, session.id)) >= MAX_LIVE_SHARES) {
    return json(
      {
        error: "too_many_shares",
        detail: `Revoke a share you no longer need first — ${MAX_LIVE_SHARES} live shares is the limit.`,
      },
      409,
    )
  }

  // A share is only worth storing if it names a row that exists and is the
  // caller's. Checked through a `TenantDb`, so "is it the caller's" is the
  // same question the corpus answers everywhere else — and naming someone
  // else's id is indistinguishable from naming one that does not exist.
  const tenant = forTenant(corpusDriver(env), session)
  if (!(await ownsNode(tenant, parsed.rootId))) {
    return json(
      { error: "invalid_request", detail: `This is not in your notes: ${parsed.rootId}.` },
      400,
    )
  }

  // The view is the share: make sure the owner has one of this node, then
  // record the grant against it.
  const now = Date.now()
  await ensureView(tenant, parsed.rootId, now)
  const grant = await createShare(control, {
    ownerId: session.id,
    granteeEmail: parsed.email,
    viewId: parsed.rootId,
    permissions: parsed.permissions,
    now,
  })
  const view = (await resolveShareViews(tenant, [grant.viewId])).get(grant.viewId) ?? NO_VIEW
  // The response says what was stored and nothing about the address: whether
  // it belongs to a Ruminate user is not this endpoint's to reveal.
  return json({ share: asGiven(grant, view) }, 201)
}

async function write(
  request: Request,
  owner: ReturnType<typeof forTenant>,
  grant: ShareGrant,
  /** The verified grantee: recorded as the `actor` of every event they cause. */
  granteeId: number,
): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0")
  if (contentLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const payload = parseReplicaPayload(body)
  if (!payload) return json({ error: "invalid_payload" }, 400)

  const closure = await closureIds(owner, grant)
  const outside = payload.nodes.map((node) => node.id).filter((id) => !closure.nodes.has(id))
  const taken = outside.length > 0 ? await takenIds(owner, outside) : new Set<string>()

  const now = Date.now()
  const plan = planSliceWrite(
    grant,
    { nodes: closure.nodes, roots: closure.roots, taken },
    payload,
    now,
  )
  if (!plan.ok) {
    return json({ error: plan.refusal.error, detail: plan.refusal.detail }, plan.refusal.status)
  }
  await applySliceWrite(owner, plan, granteeId, now, writerOf(request))
  return json({ ok: true, nodes: plan.nodes.length, links: plan.links.length })
}
