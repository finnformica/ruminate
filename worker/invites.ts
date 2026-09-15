// Invite storage — minting, listing, revocation and redemption, against the
// control plane (migrations/0014_invites.sql).
//
// An invite is the admin's way of admitting someone without knowing anything
// about them first: mint a link, send it, and whoever signs in through it is
// a tenant. Built the way MCP tokens are (worker/mcp/tokens.ts): the secret
// is `rmn_inv_` plus 32 random bytes, returned once at mint and never stored;
// `redeemInvite` looks the SHA-256 up by the unique index and claims the row
// in the same statement, so two sign-ins racing for one invite cannot both
// win it.
//
// Pure of platform types: the control plane comes in behind the `SqlDriver`
// seam, so the worker suites drive these exact statements on `node:sqlite`.

import type { SqlDriver } from "../src/data/sql-driver"

const TOKEN_PREFIX = "rmn_inv_"
const TOKEN_BYTES = 32
const ID_BYTES = 15

/** How long an invite lives unless the admin says otherwise, and the most it may. */
export const DEFAULT_INVITE_DAYS = 7
export const MAX_INVITE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const BASE64URL = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const randomBase64url = (bytes: number): string =>
  BASE64URL(crypto.getRandomValues(new Uint8Array(bytes)))

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** An invite as the admin page sees it — never the secret. */
export interface InviteSummary {
  id: string
  note: string | null
  createdAt: number
  expiresAt: number
  redeemedAt: number | null
  /** The login of whoever redeemed it, when they have a `users` row. */
  redeemedBy: { id: number; login: string } | null
  revokedAt: number | null
}

/** An invite's state, as one word. */
export function inviteState(
  invite: Pick<InviteSummary, "redeemedAt" | "revokedAt" | "expiresAt">,
  now = Date.now(),
): "live" | "redeemed" | "revoked" | "expired" {
  if (invite.redeemedAt !== null) return "redeemed"
  if (invite.revokedAt !== null) return "revoked"
  if (invite.expiresAt <= now) return "expired"
  return "live"
}

export interface MintInviteOptions {
  createdBy: number
  note: string | null
  expiresInDays: number
  now?: number
}

/**
 * Mint an invite. Returns the summary AND the secret — the only moment the
 * secret exists outside the link the admin is about to send.
 */
export async function mintInvite(
  driver: SqlDriver,
  options: MintInviteOptions,
): Promise<{ token: string; summary: InviteSummary }> {
  const now = options.now ?? Date.now()
  const token = `${TOKEN_PREFIX}${randomBase64url(TOKEN_BYTES)}`
  const id = `inv_${randomBase64url(ID_BYTES)}`
  const expiresAt = now + options.expiresInDays * DAY_MS
  await driver.exec(
    "INSERT INTO invites (id, token_hash, created_by, note, created_at, expires_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [id, await sha256Hex(token), options.createdBy, options.note, now, expiresAt],
  )
  return {
    token,
    summary: {
      id,
      note: options.note,
      createdAt: now,
      expiresAt,
      redeemedAt: null,
      redeemedBy: null,
      revokedAt: null,
    },
  }
}

/** Every invite, newest first, with the redeemer's login where known. */
export async function listInvites(driver: SqlDriver): Promise<InviteSummary[]> {
  const rows = await driver.exec(
    "SELECT i.id, i.note, i.created_at, i.expires_at, i.redeemed_at, i.redeemed_by, " +
      "i.revoked_at, u.login AS redeemed_login " +
      "FROM invites i LEFT JOIN users u ON u.github_id = i.redeemed_by " +
      "ORDER BY i.created_at DESC",
  )
  return rows.map((row) => ({
    id: String(row.id),
    note: typeof row.note === "string" ? row.note : null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    redeemedAt: row.redeemed_at === null ? null : Number(row.redeemed_at),
    redeemedBy:
      row.redeemed_by === null
        ? null
        : {
            id: Number(row.redeemed_by),
            login: typeof row.redeemed_login === "string" ? row.redeemed_login : "",
          },
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  }))
}

/** Revoke a live invite. False if there is no live invite with this id. */
export async function revokeInvite(
  driver: SqlDriver,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await driver.exec(
    "UPDATE invites SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL " +
      "AND redeemed_at IS NULL RETURNING id",
    [now, id],
  )
  return rows.length > 0
}

/**
 * Claim an invite for a verified id. True if the token named a live invite,
 * which is now redeemed by `userId`; false for anything else — unknown,
 * expired, revoked, already used — with nothing said about which.
 *
 * The check and the claim are ONE statement, so of two sign-ins presenting
 * the same link only the first sees a row come back.
 */
export async function redeemInvite(
  driver: SqlDriver,
  token: string,
  userId: number,
  now = Date.now(),
): Promise<boolean> {
  if (!token.startsWith(TOKEN_PREFIX)) return false
  const rows = await driver.exec(
    "UPDATE invites SET redeemed_at = ?1, redeemed_by = ?2 WHERE token_hash = ?3 " +
      "AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?1 RETURNING id",
    [now, userId, await sha256Hex(token)],
  )
  return rows.length > 0
}

/** The path an invite link opens in the app. */
const INVITE_PATH_PREFIX = "/invite/"

/**
 * The invite token in an app URL, if it is one — `/invite/<token>` — the
 * form the sign-in callback receives as OAuth `state` when someone signs in
 * from an invite page.
 */
export function inviteTokenFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  if (!pathname.startsWith(INVITE_PATH_PREFIX)) return null
  const token = decodeURIComponent(pathname.slice(INVITE_PATH_PREFIX.length).split("/")[0] ?? "")
  return token.startsWith(TOKEN_PREFIX) ? token : null
}
