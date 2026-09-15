// Sharing — `/api/shares` (docs/sharing.md).
//
// A share is a scoped grant: an owner names a set of root notes and an email,
// and the person GitHub reports that email for reads the slice of the owner's
// corpus beneath those roots. The slice is computed here on every request
// from the owner's rows (`worker/shares/slice.ts`), so it is live and
// least-privilege by construction. Shares are read-only: there is no write
// route, so nothing a grantee sends can reach the owner's rows.
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
// → share), and only the slice-scoped reads in `slice.ts` ever run on it.
// Both halves are pinned by the adversarial tests in shares.test.ts.
//
// Routes (wired in worker/index.ts):
//   GET    /api/shares            — shares given and received
//   POST   /api/shares            — create a share
//   DELETE /api/shares/:id        — revoke one (owner only)
//   GET    /api/shares/:id/notes  — the slice (grantee only)

import { controlPlaneDriver, corpusDriver, forTenant } from "../tenancy-db"
import type { Env } from "../types"
import { normalizeEmail, type ShareGrant } from "../shares/grant"
import { MAX_SHARE_ROOTS, sliceRows } from "../shares/slice"
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
import type { GivenShare, ReceivedShareSummary, SharesListBody } from "../shares/wire"
import { requireSession } from "./replica"
import type { VerifiedIdentity } from "./tenancy"

export const SHARES_PREFIX = "/api/shares"

const MAX_LIVE_SHARES = 50

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const asGiven = (grant: ShareGrant): GivenShare => ({
  id: grant.id,
  granteeEmail: grant.granteeEmail,
  rootIds: [...grant.rootIds],
  createdAt: grant.createdAt,
  revokedAt: grant.revokedAt,
})

const asReceived = ({ grant, owner }: ReceivedShare): ReceivedShareSummary => ({
  id: grant.id,
  owner: { login: owner.login, name: owner.name },
  rootIds: [...grant.rootIds],
  createdAt: grant.createdAt,
})

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
      const [email, given, received] = await Promise.all([
        emailOf(control, session.id),
        listGivenShares(control, session.id),
        listReceivedShares(control, session.id),
      ])
      const body: SharesListBody = {
        // The caller's OWN address, so Settings can say which address others
        // may share with — read back from the row, which is what shares are
        // resolved against, rather than from whatever the client remembers.
        me: { email },
        given: given.map(asGiven),
        received: received.map(asReceived),
      }
      return json(body)
    }
    if (request.method === "POST") return create(request, env, session)
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
    const owner = forTenant(corpusDriver(env), {
      id: received.grant.ownerId,
      login: String(received.grant.ownerId),
      name: null,
    })

    if (request.method === "GET") return json(await sliceRows(owner, received.grant))
    return json({ error: "method_not_allowed" }, 405)
  }

  return json({ error: "not_found" }, 404)
}

interface ParsedCreate {
  email: string
  rootIds: string[]
}

/** Validate the create request. Every refusal names the field, because this
 * one is read by a person filling in a form. */
function parseCreateBody(raw: unknown): ParsedCreate | string {
  if (typeof raw !== "object" || raw === null) return "Body must be an object."
  const body = raw as Record<string, unknown>

  const email = normalizeEmail(body.email)
  if (email === null) return "Enter the email address the person signs in to GitHub with."

  if (!Array.isArray(body.rootIds) || body.rootIds.length === 0) {
    return "Pick at least one note to share."
  }
  if (body.rootIds.length > MAX_SHARE_ROOTS) {
    return `Share at most ${MAX_SHARE_ROOTS} notes at a time.`
  }
  const unique = new Set<string>()
  for (const entry of body.rootIds) {
    if (typeof entry !== "string" || entry.length === 0) return "`rootIds` must be note ids."
    unique.add(entry)
  }

  return { email, rootIds: [...unique] }
}

/** Which of these ids are live notes in the caller's own corpus. */
async function ownNoteIds(
  env: Env,
  session: VerifiedIdentity,
  ids: string[],
): Promise<Set<string>> {
  const tenant = forTenant(corpusDriver(env), session)
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ")
  const rows = await tenant.exec(
    `SELECT id FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL ` +
      `AND type = 'note' AND id IN (${placeholders})`,
    ids,
  )
  return new Set(rows.map((row) => String(row.id)))
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

  // A share is only worth storing if it names notes that exist and are the
  // caller's. Checked through a `TenantDb`, so "are they the caller's" is the
  // same question the corpus answers everywhere else — and naming someone
  // else's note id is indistinguishable from naming one that does not exist.
  const own = await ownNoteIds(env, session, parsed.rootIds)
  const missing = parsed.rootIds.filter((id) => !own.has(id))
  if (missing.length > 0) {
    return json(
      {
        error: "invalid_request",
        detail: `These are not notes in your corpus: ${missing.join(", ")}.`,
      },
      400,
    )
  }

  const grant = await createShare(control, {
    ownerId: session.id,
    granteeEmail: parsed.email,
    rootIds: parsed.rootIds,
  })
  // The response says what was stored and nothing about the address: whether
  // it belongs to a Ruminate user is not this endpoint's to reveal.
  return json({ share: asGiven(grant) }, 201)
}
