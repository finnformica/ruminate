// MCP token storage — minting, lookup, listing and revocation, against the
// control plane (migrations/0007_mcp_tokens.sql).
//
// Like `tenancy.ts` this module is pure of platform types: it takes the
// control-plane database behind the shared `SqlDriver` seam, so the worker
// suites drive the exact production statements on `node:sqlite`.
//
// ## The secret
//
// A token is `rmn_mcp_` plus 32 bytes of `crypto.getRandomValues`, base64url.
// It is returned by `mintToken` and then gone: only `sha256Hex(token)` is
// stored, and `findGrant` looks up BY that hash, so the comparison is the
// unique index seek in migration 0007 — there is no string compare in this
// file to get wrong, and no timing signal in one either.
//
// 256 bits of entropy is not a ritual: this is a bearer credential over the
// public internet with no second factor and no rate limit in front of it, so
// guessing has to be arithmetically hopeless rather than merely unlikely.

import type { SqlDriver } from "../../src/data/sql-driver"
import {
  grantFromRow,
  serializePermissions,
  type Grant,
  type GrantRefusal,
  type McpTokenRow,
  type Permission,
} from "./grant"

/** The prefix every MCP token carries. Greppable in logs and secret
 * scanners, and it lets an obviously-wrong credential be refused before it
 * costs a database read. */
const TOKEN_PREFIX = "rmn_mcp_"

/** Bytes of entropy in the secret half. */
const TOKEN_BYTES = 32

/** `id` column: a short public handle, distinct from the secret. */
const ID_BYTES = 15

/** Refresh `last_used_at` at most this often — an agent's tool loop must not
 * cost a control-plane WRITE per call (the same reasoning as
 * `LAST_SEEN_REFRESH_MS` in tenancy.ts, at a tighter interval because "when
 * did this token last act" is the question a user revoking one will ask). */
const LAST_USED_REFRESH_MS = 60 * 60 * 1000

const BASE64URL = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const randomBase64url = (bytes: number): string =>
  BASE64URL(crypto.getRandomValues(new Uint8Array(bytes)))

/** SHA-256 as lowercase hex — what the `token_hash` column holds. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** What the user sees about a token — never the secret. */
export interface TokenSummary {
  id: string
  name: string
  permissions: Permission[]
  /** null = every note. */
  noteIds: string[] | null
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface MintOptions {
  userId: number
  name: string
  permissions: Permission[]
  /** null = every note. */
  noteIds: string[] | null
  expiresAt: number | null
  now?: number
}

/**
 * Mint a token. Returns the summary AND the secret — the only moment the
 * secret exists outside the caller's agent, which is why the management API
 * says so in its response and the UI shows it once.
 */
export async function mintToken(
  driver: SqlDriver,
  options: MintOptions,
): Promise<{ token: string; summary: TokenSummary }> {
  const now = options.now ?? Date.now()
  const token = `${TOKEN_PREFIX}${randomBase64url(TOKEN_BYTES)}`
  const id = `mcp_${randomBase64url(ID_BYTES)}`
  const permissions = serializePermissions(options.permissions)
  const noteIds = options.noteIds === null ? null : JSON.stringify(options.noteIds)

  await driver.exec(
    "INSERT INTO mcp_tokens " +
      "(id, user_id, token_hash, name, permissions, note_ids, created_at, expires_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    [
      id,
      options.userId,
      await sha256Hex(token),
      options.name,
      permissions,
      noteIds,
      now,
      options.expiresAt,
    ],
  )

  return {
    token,
    summary: {
      id,
      name: options.name,
      permissions: permissions === "" ? [] : (permissions.split(",") as Permission[]),
      noteIds: options.noteIds,
      createdAt: now,
      expiresAt: options.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    },
  }
}

/** A user's tokens, newest first. Revoked ones are included — the audit
 * trail is the point of keeping the row. */
export async function listTokens(driver: SqlDriver, userId: number): Promise<TokenSummary[]> {
  const rows = await driver.exec(
    "SELECT id, name, permissions, note_ids, created_at, expires_at, last_used_at, revoked_at " +
      "FROM mcp_tokens WHERE user_id = ?1 ORDER BY created_at DESC",
    [userId],
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    permissions: String(row.permissions ?? "")
      .split(",")
      .filter(Boolean) as Permission[],
    noteIds:
      row.note_ids === null || row.note_ids === undefined ? null : safeIds(String(row.note_ids)),
    createdAt: Number(row.created_at),
    expiresAt:
      row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    lastUsedAt:
      row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    revokedAt:
      row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  }))
}

const safeIds = (stored: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/**
 * Revoke one token. Scoped to `userId` in the statement itself, so naming
 * someone else's token id revokes nothing rather than revoking theirs.
 * Returns whether a live row was actually retired.
 */
export async function revokeToken(
  driver: SqlDriver,
  userId: number,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  await driver.exec(
    "UPDATE mcp_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
    [id, userId, now],
  )
  const rows = await driver.exec(
    "SELECT revoked_at FROM mcp_tokens WHERE id = ?1 AND user_id = ?2",
    [id, userId],
  )
  return rows.length > 0 && rows[0].revoked_at !== null
}

export type FindGrantResult = { ok: true; grant: Grant } | { ok: false; refusal: GrantRefusal }

/**
 * The authentication path: a presented token → a `Grant`, or a refusal.
 *
 * Everything about it is fail-closed. A token without the prefix is refused
 * before a query runs; a hash that matches nothing is `invalid_token`; a row
 * that matches is handed to `grantFromRow`, which refuses it if it is revoked
 * or expired. There is no branch that returns a grant without a live row
 * behind it.
 */
export async function findGrant(
  driver: SqlDriver,
  token: string,
  now: number = Date.now(),
): Promise<FindGrantResult> {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, refusal: "invalid_token" }

  const rows = await driver.exec(
    "SELECT id, user_id, name, permissions, note_ids, expires_at, revoked_at " +
      "FROM mcp_tokens WHERE token_hash = ?1",
    [await sha256Hex(token)],
  )
  if (rows.length === 0) return { ok: false, refusal: "invalid_token" }

  const row = rows[0] as unknown as McpTokenRow
  return grantFromRow(row, now)
}

/**
 * Stamp `last_used_at`, at most hourly. Deliberately separate from
 * `findGrant`: authentication is a read, and a write on the read path is how
 * a busy agent turns a tool loop into a write-rate problem.
 */
export async function touchToken(
  driver: SqlDriver,
  tokenId: string,
  now: number = Date.now(),
): Promise<void> {
  await driver.exec(
    "UPDATE mcp_tokens SET last_used_at = ?2 WHERE id = ?1 " +
      "AND (last_used_at IS NULL OR last_used_at < ?3)",
    [tokenId, now, now - LAST_USED_REFRESH_MS],
  )
}

/**
 * Is this user still a tenant in good standing?
 *
 * A grant's `user_id` was verified when the token was minted, under a real
 * GitHub session — but that was then. `users.status` is checked on EVERY MCP
 * request so that blocking a user (`UPDATE users SET status = 'blocked'`)
 * kills their agents' access at the same moment it kills their browser's,
 * without anyone having to remember to revoke tokens as well.
 *
 * A missing `users` row is refused too: an MCP token must never provision a
 * tenant, which is why this is a plain read and not `resolveTenancy`.
 */
export async function tenantIsActive(driver: SqlDriver, userId: number): Promise<boolean> {
  try {
    const rows = await driver.exec("SELECT status FROM users WHERE github_id = ?1", [userId])
    return rows.length > 0 && rows[0].status === "active"
  } catch {
    // Control-plane tables missing (migration 0003 not applied): no MCP
    // access at all. The replica path has a legacy fallback because locking
    // the owner out of their own notes would be worse than the risk; an
    // agent has no such claim.
    return false
  }
}
