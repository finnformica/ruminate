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
// 3. **Which NODES the grantee may see is not decided here**: a share names
//    notes, and the slice beneath them is computed from the owner's rows on
//    every request by `slice.ts`.

import { parsePermissions, serializePermissions, type Permission } from "../mcp/grant"

/** One share's authority. Produced only by `shareFromRow`. */
export interface ShareGrant {
  readonly id: string
  /** The verified GitHub id whose corpus the slice is cut from. */
  readonly ownerId: number
  /** The address the share is for, lowercased. Shown to the owner (who typed
   * it) and never to anyone else. */
  readonly granteeEmail: string
  /** The note ids the closure is walked from. Possibly empty (a row that did
   * not parse), in which case the slice is empty too. */
  readonly rootIds: ReadonlySet<string>
  /** The verbs this share permits — `read`, and only `read`, today. */
  readonly permissions: ReadonlySet<Permission>
  readonly createdAt: number
  readonly revokedAt: number | null
}

/** The `shares` columns a grant is built from. */
export interface ShareRow {
  id: string
  owner_id: number
  grantee_email: string
  root_ids: string
  permissions: string
  created_at: number
  revoked_at: number | null
}

/**
 * Parse the stored root list: a JSON array of note ids. Anything else —
 * malformed JSON, a non-array, a non-string entry — yields the EMPTY set: a
 * row we cannot read is a share over nothing, never over everything.
 */
export function parseRootIds(stored: string): Set<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return new Set()
  }
  if (!Array.isArray(parsed)) return new Set()
  const ids = new Set<string>()
  for (const entry of parsed) if (typeof entry === "string" && entry.length > 0) ids.add(entry)
  return ids
}

/** Mint a `ShareGrant` from a row — the ONE mint there is. A revoked row is
 * still minted (the owner's list shows it); `shareAllows` and the handler
 * refuse it, so there is no path that serves a slice from a dead share. */
export function shareFromRow(row: ShareRow): ShareGrant {
  return {
    id: row.id,
    ownerId: row.owner_id,
    granteeEmail: row.grantee_email,
    rootIds: parseRootIds(row.root_ids),
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  }
}

/** Storage form of a permission set, `read` forced in: a share that cannot
 * be read is not a share of anything. Every share is read-only today; the
 * column is kept in the storage form the MCP grant uses so that write and
 * delete can arrive without a migration. */
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
