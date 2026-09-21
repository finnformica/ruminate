// The share grant: what one share lets its grantee do, and the only place that
// question is answered (docs/sharing.md).
//
// Built on the same three ideas as the MCP grant (worker/mcp/grant.ts) and
// the tenancy module (worker/tenancy-db.ts):
//
// 1. **The grant is bound, never passed in.** A `ShareGrant` is minted from a
//    `shares` row by `shareFromRow` and from nothing else. No path segment,
//    query param or body field can name an owner, a root or a verb.
// 2. **Nothing is allowed by default.** A malformed row yields a grant that
//    reaches no notes and permits no verbs.
// 3. **The checks are narrow and greppable.** `shareAllows` is the whole
//    permission check. Which NODES the grantee may touch is not decided here:
//    a share names the owner's VIEW (migrations/0017), the view names a root,
//    and the slice beneath it is computed from the owner's rows on every
//    request by `slice.ts`.

import { parsePermissions, serializePermissions, type Permission } from "../mcp/grant"

export { PERMISSIONS, type Permission } from "../mcp/grant"

/** One share's authority. Produced only by `shareFromRow`. */
export interface ShareGrant {
  readonly id: string
  /** The verified GitHub id whose corpus the slice is cut from. */
  readonly ownerId: number
  /** The address the share is for, lowercased. Shown to the owner (who typed
   * it) and never to anyone else. */
  readonly granteeEmail: string
  /** The owner's view this share is of (`views.id` in the owner's
   * partition): its root is what is shared, its filter and sort how the
   * grantee opens it. Empty on a row that did not parse, which is a share
   * over nothing. */
  readonly viewId: string
  /** The verbs this share permits. `read` is always among them on a row the
   * create endpoint wrote; a row without it permits nothing readable. */
  readonly permissions: ReadonlySet<Permission>
  readonly createdAt: number
  readonly revokedAt: number | null
}

/** The `shares` columns a grant is built from. */
export interface ShareRow {
  id: string
  owner_id: number
  grantee_email: string
  view_id: string
  permissions: string
  created_at: number
  revoked_at: number | null
}

/** Mint a `ShareGrant` from a row — the ONE mint there is. A revoked row is
 * still minted (the owner's list shows it); `shareAllows` and the handler
 * refuse it, so there is no path that serves a slice from a dead share. */
export function shareFromRow(row: ShareRow): ShareGrant {
  return {
    id: row.id,
    ownerId: row.owner_id,
    granteeEmail: row.grantee_email,
    // A row we cannot read is a share over nothing, never over everything.
    viewId: typeof row.view_id === "string" ? row.view_id : "",
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  }
}

/** Does this share permit `permission`? A revoked share permits nothing. */
export const shareAllows = (grant: ShareGrant, permission: Permission): boolean =>
  grant.revokedAt === null && grant.permissions.has(permission)

/** Storage form of a permission set, `read` forced in: a share that cannot
 * be read is not a share of anything. */
export const serializeSharePermissions = (permissions: Iterable<Permission>): string =>
  serializePermissions(new Set<Permission>(["read", ...permissions]))

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

/** Longest address accepted (RFC 5321's practical limit). */
const MAX_EMAIL_LENGTH = 254

/** Loose on purpose: the address is an opaque key matched against what
 * GitHub reports, not something we deliver mail to. What matters is that a
 * typo cannot silently match a different user, and lowercasing plus exact
 * comparison gives that. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The canonical form of an address, or null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null
  return EMAIL_SHAPE.test(trimmed) ? trimmed : null
}
