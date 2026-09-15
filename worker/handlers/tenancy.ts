// Tenancy resolution — the control-plane half of `requireSession`
// (docs/multi-tenant-design.md §3).
//
// Identity verification (cookie + bearer → GitHub `/user`) stays in
// `replica.ts`; this module answers the next question: *is this verified
// GitHub id a tenant here?* It runs against the control-plane database
// through the `SqlDriver` seam, so the logic is engine-agnostic and the test
// suite exercises it on `node:sqlite` with the real control-plane migrations.
//
// Modes (`SIGNUP_MODE` var):
// - "invite": a verified id with no `users` row is admitted only if it is the
//   bootstrap owner (`ALLOWED_GITHUB_ID`) or the sign-in came through a live
//   invite link (worker/invites.ts) — admission provisions the `users` row
//   and claims the invite.
// - "open": any verified GitHub id auto-provisions a `users` row.
// - absent/unknown: fail closed — only the `ALLOWED_GITHUB_ID` bootstrap id
//   passes, which is exactly the original single-owner behavior.
//
// A `users.status = 'blocked'` row always loses, in every mode. If the
// control-plane tables don't exist yet (migration 0003 not applied), every
// mode degrades to the legacy `ALLOWED_GITHUB_ID` comparison, so a deploy
// ahead of the migration cannot lock the owner out — and cannot let anyone
// else in.

import type { SqlDriver } from "../../src/data/sql-driver"
import { redeemInvite } from "../invites"

/** The identity `requireSession` verified against GitHub. */
export interface VerifiedIdentity {
  id: number
  login: string
  name: string | null
  /**
   * The primary verified address GitHub reports for the account — known only
   * to the sign-in callback, which fetches it. Absent on the API path
   * (`requireSession` checks `/user`, not `/user/emails`), where the stored
   * value is left alone and no row can be provisioned.
   */
  email?: string | null
}

/** How an admitted identity got in: it already had a row, or it was
 * provisioned one just now — by an invite, by open signups, or as the
 * bootstrap owner. */
type Admission = "existing" | "invite" | "signup" | "owner"

export type TenancyDecision =
  { allowed: true; via: Admission } | { allowed: false; status: number; error: string }

export interface TenancyOptions {
  /** `env.SIGNUP_MODE` — "invite" | "open"; anything else fails closed. */
  signupMode: string | undefined
  /** `env.ALLOWED_GITHUB_ID` — the bootstrap owner id (kept working so
   * nothing breaks before/without the control-plane migration). */
  bootstrapGithubId: string | undefined
  /** The invite token the sign-in arrived with, if any — the sign-in
   * callback's to pass, from the `/invite/<token>` URL it returns to. */
  inviteToken?: string | null
  /** Injectable clock for tests. */
  now?: () => number
}

/** Refresh `users.last_seen_at` at most this often (avoid a D1 write per
 * sync request — the sync loop runs every few seconds). */
const LAST_SEEN_REFRESH_MS = 6 * 60 * 60 * 1000

const allow = (via: Admission): TenancyDecision => ({ allowed: true, via })
const deny = (status: number, error: string): TenancyDecision => ({ allowed: false, status, error })

/** The original single-owner rule, verbatim — the fallback when the
 * control-plane tables are missing, and the bootstrap rule when `SIGNUP_MODE`
 * is unset. */
function legacyOwnerDecision(id: number, bootstrapGithubId: string | undefined): TenancyDecision {
  if (!bootstrapGithubId) return deny(403, "owner_not_configured")
  return String(id) === bootstrapGithubId ? allow("owner") : deny(403, "forbidden")
}

/** What `users.created_by` records for each way in. */
const CREATED_BY: Record<Exclude<Admission, "existing">, string> = {
  invite: "invite",
  signup: "signup",
  owner: "admin",
}

async function provisionUser(
  driver: SqlDriver,
  identity: VerifiedIdentity,
  email: string,
  via: Exclude<Admission, "existing">,
  now: number,
): Promise<void> {
  await driver.exec(
    "INSERT INTO users (github_id, login, name, email, created_at, created_by, last_seen_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5) ON CONFLICT (github_id) DO NOTHING",
    [identity.id, identity.login, identity.name, email, now, CREATED_BY[via]],
  )
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()

/** Redeem, reading a missing `invites` table (migration 0014 not applied)
 * as "no such invite" — a deploy ahead of its migration admits nobody extra. */
async function tryRedeem(driver: SqlDriver, token: string, userId: number, now: number) {
  try {
    return await redeemInvite(driver, token, userId, now)
  } catch {
    return false
  }
}

/** "invite" is the gated mode. "allowlist" was its name before invites
 * replaced the allowlist table (migrations/0014) and still reads as gated,
 * so a var left on the old spelling closes the door rather than opening it. */
const isInviteMode = (mode: string | undefined) => mode === "invite" || mode === "allowlist"

/**
 * Decide whether the verified identity is a tenant, provisioning the `users`
 * row when the mode admits a new one. Pure of platform types: `driver` is the
 * control-plane database behind the `SqlDriver` seam.
 *
 * A row is provisioned only from the sign-in callback, the one caller that
 * carries the address (`users.email` is NOT NULL, migrations/0011): an
 * admitted identity WITHOUT one — the API path, for an account that has
 * never signed in through this Worker — is refused with `sign_in_required`
 * rather than given a row with no address. An existing row's address is
 * refreshed when the sign-in reports a different one.
 *
 * An invite is claimed only when it admits someone: an id that already has
 * a row keeps its row and the invite stays live for whoever it was meant
 * for, and a sign-in that cannot be provisioned (no address) leaves it
 * untouched too.
 */
export async function resolveTenancy(
  driver: SqlDriver,
  identity: VerifiedIdentity,
  options: TenancyOptions,
): Promise<TenancyDecision> {
  const now = options.now?.() ?? Date.now()
  const email =
    typeof identity.email === "string" && identity.email.trim().length > 0
      ? normalizeEmail(identity.email)
      : null

  let existing: { status: string; last_seen_at: number | null; email: string } | undefined
  try {
    const rows = await driver.exec(
      "SELECT status, last_seen_at, email FROM users WHERE github_id = ?1",
      [identity.id],
    )
    existing = rows[0] as unknown as typeof existing
  } catch {
    // Control-plane tables missing (migration 0003 not applied yet): behave
    // exactly like the pre-multi-tenant deployment.
    return legacyOwnerDecision(identity.id, options.bootstrapGithubId)
  }

  /** Admit a new id: provision its row, which needs the address. */
  const admit = async (via: Exclude<Admission, "existing">): Promise<TenancyDecision> => {
    if (email === null) return deny(403, "sign_in_required")
    await provisionUser(driver, identity, email, via, now)
    return allow(via)
  }

  if (existing) {
    if (existing.status === "blocked") return deny(403, "blocked")
    if (existing.last_seen_at === null || now - existing.last_seen_at > LAST_SEEN_REFRESH_MS) {
      await driver.exec("UPDATE users SET last_seen_at = ?1 WHERE github_id = ?2", [
        now,
        identity.id,
      ])
    }
    if (email !== null && email !== existing.email) {
      await driver.exec("UPDATE users SET email = ?1 WHERE github_id = ?2", [email, identity.id])
    }
    return allow("existing")
  }

  // No users row: signing in is signing up — if the mode admits this id.
  if (options.signupMode === "open") return admit("signup")

  const isBootstrapOwner =
    options.bootstrapGithubId !== undefined && String(identity.id) === options.bootstrapGithubId

  if (isInviteMode(options.signupMode)) {
    if (isBootstrapOwner) return admit("owner")
    const token = options.inviteToken ?? null
    if (token === null) return deny(403, "signup_closed")
    // The invite is claimed only once the row can be written: an address-less
    // sign-in must not spend somebody's link on a refusal.
    if (email === null) return deny(403, "sign_in_required")
    if (await tryRedeem(driver, token, identity.id, now)) return admit("invite")
    return deny(403, "signup_closed")
  }

  // Mode absent or unrecognized: fail closed, bootstrap owner only.
  const decision = legacyOwnerDecision(identity.id, options.bootstrapGithubId)
  return decision.allowed ? admit("owner") : decision
}
