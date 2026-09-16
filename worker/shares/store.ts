// Share storage — creating, listing, resolving and revoking shares against
// the control plane (migrations/0012_shares.sql).
//
// Pure of platform types, like `tenancy.ts` and `mcp/tokens.ts`: it takes the
// control-plane database behind the shared `SqlDriver` seam, so the worker
// suites drive the exact production statements on `node:sqlite`.
//
// ## Who a share is for
//
// A share names an EMAIL, and an email is not an identity the server trusts
// from a client. The only writer of `users.email` is the server itself, from
// what GitHub reports for a token it has just verified: the sign-in callback
// records it as it provisions the row (`resolveTenancy`; mandatory since
// migrations/0011). Resolving "the shares addressed to me" is therefore a join
// from the
// caller's VERIFIED id to their recorded address to the rows naming it —
// never from an address the caller supplied.

import type { SqlDriver } from "../../src/data/sql-driver"
import {
  serializeSharePermissions,
  shareFromRow,
  type Permission,
  type ShareGrant,
  type ShareRow,
} from "./grant"

/** `id` column: a short public handle. */
const ID_BYTES = 15

const randomBase64url = (bytes: number): string => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let binary = ""
  for (const byte of raw) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The recorded address of a tenant (`users.email`, mandatory — every row the
 * resolver admits has one). */
export async function emailOf(driver: SqlDriver, githubId: number): Promise<string> {
  const rows = await driver.exec("SELECT email FROM users WHERE github_id = ?1", [githubId])
  return String(rows[0]?.email ?? "")
}

// -----------------------------------------------------------------------------
// Shares
// -----------------------------------------------------------------------------

export interface CreateShareOptions {
  ownerId: number
  /** Already normalized (`normalizeEmail`). */
  granteeEmail: string
  rootIds: string[]
  permissions: Permission[]
  now?: number
}

/** Create a share. Returns the grant as stored. */
export async function createShare(
  driver: SqlDriver,
  options: CreateShareOptions,
): Promise<ShareGrant> {
  const now = options.now ?? Date.now()
  const row: ShareRow = {
    id: `shr_${randomBase64url(ID_BYTES)}`,
    owner_id: options.ownerId,
    grantee_email: options.granteeEmail,
    root_ids: JSON.stringify(options.rootIds),
    permissions: serializeSharePermissions(options.permissions),
    created_at: now,
    revoked_at: null,
  }
  await driver.exec(
    "INSERT INTO shares (id, owner_id, grantee_email, root_ids, permissions, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [row.id, row.owner_id, row.grantee_email, row.root_ids, row.permissions, row.created_at],
  )
  return shareFromRow(row)
}

const SHARE_COLUMNS = "id, owner_id, grantee_email, root_ids, permissions, created_at, revoked_at"

const asRow = (row: Record<string, unknown>): ShareRow => ({
  id: String(row.id),
  owner_id: Number(row.owner_id),
  grantee_email: String(row.grantee_email),
  root_ids: String(row.root_ids),
  permissions: String(row.permissions ?? ""),
  created_at: Number(row.created_at),
  revoked_at:
    row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
})

/** The shares a user has GIVEN, newest first. Revoked ones are included —
 * the audit trail is the point of keeping the row. */
export async function listGivenShares(driver: SqlDriver, ownerId: number): Promise<ShareGrant[]> {
  const rows = await driver.exec(
    `SELECT ${SHARE_COLUMNS} FROM shares WHERE owner_id = ?1 ORDER BY created_at DESC`,
    [ownerId],
  )
  return rows.map((row) => shareFromRow(asRow(row)))
}

/** What a grantee learns about the person who shared with them: a login and
 * a display name, from the control plane's `users` row. Never an email. */
interface ShareOwner {
  id: number
  login: string
  name: string | null
}

export interface ReceivedShare {
  grant: ShareGrant
  owner: ShareOwner
}

/**
 * The LIVE shares addressed to a verified id, newest first — through the
 * ledger, never through an address the caller named. A share whose owner is
 * no longer an active tenant is left out: blocking a user ends what they
 * shared at the same moment it ends their own access.
 */
export async function listReceivedShares(
  driver: SqlDriver,
  granteeId: number,
): Promise<ReceivedShare[]> {
  const rows = await driver.exec(
    `SELECT s.id, s.owner_id, s.grantee_email, s.root_ids, s.permissions, s.created_at, ` +
      `s.revoked_at, u.login AS owner_login, u.name AS owner_name ` +
      `FROM shares s ` +
      `JOIN users g ON g.github_id = ?1 AND g.email = s.grantee_email ` +
      `JOIN users u ON u.github_id = s.owner_id AND u.status = 'active' ` +
      `WHERE s.revoked_at IS NULL ` +
      `ORDER BY s.created_at DESC`,
    [granteeId],
  )
  return rows.map((row) => ({
    grant: shareFromRow(asRow(row)),
    owner: {
      id: Number(row.owner_id),
      login: String(row.owner_login),
      name: row.owner_name === null || row.owner_name === undefined ? null : String(row.owner_name),
    },
  }))
}

/**
 * One live share addressed to the caller, by id — the lookup behind every
 * slice read and write. The share id names nothing on its own: a caller who
 * is not its grantee (by the ledger) gets null, exactly as for an id that
 * does not exist, so the endpoint is not an existence oracle for other
 * people's shares.
 */
export async function findReceivedShare(
  driver: SqlDriver,
  granteeId: number,
  shareId: string,
): Promise<ReceivedShare | null> {
  const received = await listReceivedShares(driver, granteeId)
  return received.find((entry) => entry.grant.id === shareId) ?? null
}

/**
 * Revoke one share. Scoped to `ownerId` in the statement itself, so naming
 * someone else's share revokes nothing rather than revoking theirs. Returns
 * whether a live row was actually retired.
 */
export async function revokeShare(
  driver: SqlDriver,
  ownerId: number,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await driver.exec("SELECT revoked_at FROM shares WHERE id = ?1 AND owner_id = ?2", [
    id,
    ownerId,
  ])
  if (rows.length === 0 || rows[0].revoked_at !== null) return false
  await driver.exec(
    "UPDATE shares SET revoked_at = ?3 WHERE id = ?1 AND owner_id = ?2 AND revoked_at IS NULL",
    [id, ownerId, now],
  )
  return true
}

/** How many live shares a user has given — the cap the create endpoint
 * enforces. */
export async function countLiveShares(driver: SqlDriver, ownerId: number): Promise<number> {
  const rows = await driver.exec(
    "SELECT COUNT(*) AS n FROM shares WHERE owner_id = ?1 AND revoked_at IS NULL",
    [ownerId],
  )
  return Number(rows[0]?.n ?? 0)
}
