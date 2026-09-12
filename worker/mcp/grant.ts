// The grant: what one MCP token is allowed to do, and the only place that
// question is answered (docs/mcp-server.md).
//
// `TenantDb` (worker/tenancy-db.ts) already makes it structurally impossible
// for a request to read another user's rows. That is necessary and not
// sufficient here: an agent holding the user's own token is *inside* the
// tenant, so the second boundary — which of the user's notes, and which
// verbs — has to be drawn somewhere too. This module is that boundary, built
// on the same three ideas the tenancy module is:
//
// 1. **The grant is bound, never passed in.** A `Grant` is minted from a
//    `mcp_tokens` row by `grantFromRow` and from nothing else. No tool
//    argument, header or body field can name a permission or widen a note
//    set, because there is no parameter for one.
// 2. **Nothing is allowed by default.** `permissions` is a set that starts
//    empty, `noteIds` is a set that admits only what it names, and every
//    check is a positive test. A malformed row yields a grant that can do
//    nothing rather than a grant that can do everything.
// 3. **The checks are narrow and greppable.** Three functions —
//    `allows`, `coversNote`, `mayCreateNotes` — and every call site is a
//    tool in `tools.ts`, pinned by the adversarial tests in `grant.test.ts`.
//
// The note boundary is stated in terms the user recognizes: a grant names
// *notes*, because a note is what the user picked in Settings. What that
// means for the graph beneath — which blocks an agent may see when it
// traverses — is `visibleNodes` in `graph-access.ts`, derived from these note
// ids and never from anything the agent sends.

/** What a grant may do. Ordered from least to most dangerous. */
export const PERMISSIONS = ["read", "write", "delete"] as const

export type Permission = (typeof PERMISSIONS)[number]

const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value)

/**
 * One token's authority. Produced only by `grantFromRow`; every field is
 * read-only, so a tool cannot widen the grant it was handed.
 */
export interface Grant {
  /** The token's public id (`mcp_…`) — for audit lines, never for auth. */
  readonly tokenId: string
  /** The verified GitHub id whose corpus this grant reads. */
  readonly userId: number
  readonly name: string
  /** The verbs this grant permits. Possibly empty. */
  readonly permissions: ReadonlySet<Permission>
  /**
   * The notes this grant may touch, or `null` for **every note**.
   *
   * Null and empty are deliberately different: null is the unrestricted grant
   * the mint endpoint writes when the user picks no notes, and an empty set
   * is a grant over nothing, which the mint endpoint refuses to create — but
   * which this module still handles correctly (it permits nothing) rather
   * than trusting that refusal.
   */
  readonly noteIds: ReadonlySet<string> | null
  readonly expiresAt: number | null
}

/** The `mcp_tokens` columns a grant is built from. */
export interface McpTokenRow {
  id: string
  user_id: number
  name: string
  permissions: string
  note_ids: string | null
  expires_at: number | null
  revoked_at: number | null
}

/** Why a token was refused. Each maps to a distinct response in `mcp.ts`. */
export type GrantRefusal = "invalid_token" | "revoked" | "expired"

export type GrantDecision = { ok: true; grant: Grant } | { ok: false; refusal: GrantRefusal }

/**
 * Parse the stored permission list. Unknown entries are dropped rather than
 * rejected: a token minted by a newer build that knows a fourth verb keeps
 * the three this build understands instead of failing shut on the user.
 */
export function parsePermissions(stored: string): Set<Permission> {
  const permissions = new Set<Permission>()
  for (const entry of stored.split(",")) {
    const trimmed = entry.trim()
    if (isPermission(trimmed)) permissions.add(trimmed)
  }
  return permissions
}

/** Serialize a permission set for storage, in `PERMISSIONS` order so the
 * column is stable and two equal grants read identically. */
export const serializePermissions = (permissions: Iterable<Permission>): string => {
  const held = new Set(permissions)
  return PERMISSIONS.filter((permission) => held.has(permission)).join(",")
}

/**
 * Parse the stored note list: a JSON array of page ids, or NULL for every
 * note. Anything else — malformed JSON, a non-array, a non-string entry —
 * yields the EMPTY set, not null: a row we cannot read is a grant that
 * reaches no note, never one that reaches all of them.
 */
export function parseNoteIds(stored: string | null): Set<string> | null {
  if (stored === null) return null
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

/**
 * Mint a `Grant` from a token row — the ONE mint there is. Refuses a revoked
 * or expired row here rather than leaving that to a caller, so there is no
 * path that produces a `Grant` from a dead token.
 */
export function grantFromRow(row: McpTokenRow, now: number = Date.now()): GrantDecision {
  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return { ok: false, refusal: "revoked" }
  }
  if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= now) {
    return { ok: false, refusal: "expired" }
  }
  if (!Number.isSafeInteger(row.user_id)) return { ok: false, refusal: "invalid_token" }

  return {
    ok: true,
    grant: {
      tokenId: row.id,
      userId: row.user_id,
      name: row.name,
      permissions: parsePermissions(row.permissions),
      noteIds: parseNoteIds(row.note_ids),
      expiresAt: row.expires_at ?? null,
    },
  }
}

// -----------------------------------------------------------------------------
// The three checks
// -----------------------------------------------------------------------------

/** Does this grant permit `permission`? The only permission test there is. */
export const allows = (grant: Grant, permission: Permission): boolean =>
  grant.permissions.has(permission)

/**
 * May this grant touch this note? True for every note when the grant names
 * none (`noteIds === null`), and otherwise only for the ids it names.
 */
export const coversNote = (grant: Grant, noteId: string): boolean =>
  grant.noteIds === null || grant.noteIds.has(noteId)

/**
 * May this grant create notes?
 *
 * Only an unrestricted grant may. A note-scoped grant names notes that
 * already exist; a note it creates could not have been named, so allowing
 * creation would let a grant over one note grow into a grant over a corpus
 * of its own making — precisely the widening the note scope exists to
 * prevent. `write` on a scoped grant means "edit these notes", and says so
 * in the tool description.
 */
export const mayCreateNotes = (grant: Grant): boolean =>
  allows(grant, "write") && grant.noteIds === null

/** A one-line description of the grant, for `server/discover` instructions
 * and for the audit line each call writes. Names no secret. */
export function describeGrant(grant: Grant): string {
  const verbs = PERMISSIONS.filter((permission) => grant.permissions.has(permission))
  const scope =
    grant.noteIds === null
      ? "every note"
      : grant.noteIds.size === 1
        ? "1 note"
        : `${grant.noteIds.size} notes`
  return `${verbs.length > 0 ? verbs.join("+") : "no"} access to ${scope}`
}
