// Tenancy resolution — the control-plane half of `requireSession`
// (docs/multi-tenant-design.md §3).
//
// Identity verification (cookie + bearer → GitHub `/user`) stays in
// `replica.ts`; this module answers the next question: *is this verified
// GitHub id a tenant here?* It runs against the control-plane database
// through the `SqlDriver` seam, so the logic is engine-agnostic and the test
// suite exercises it on `node:sqlite` with the real `0003_control_plane.sql`
// tables.
//
// Modes (`SIGNUP_MODE` var):
// - "allowlist": a verified id with no `users` row is admitted only if the
//   `allowlist` table (or the `ALLOWED_GITHUB_ID` bootstrap var) names it —
//   admission provisions the `users` row.
// - "open": any verified GitHub id auto-provisions a `users` row.
// - absent/unknown: fail closed — only the `ALLOWED_GITHUB_ID` bootstrap id
//   passes, which is exactly today's single-owner behavior.
//
// A `users.status = 'blocked'` row always loses, in every mode. If the
// control-plane tables don't exist yet (migration 0003 not applied), every
// mode degrades to the legacy `ALLOWED_GITHUB_ID` comparison, so a deploy
// ahead of the migration cannot lock the owner out — and cannot let anyone
// else in.

import type { SqlDriver } from "../../src/data/sql-driver"

/** The identity `requireSession` verified against GitHub. */
export interface VerifiedIdentity {
  id: number
  login: string
  name: string | null
}

export type TenancyDecision = { allowed: true } | { allowed: false; status: number; error: string }

export interface TenancyOptions {
  /** `env.SIGNUP_MODE` — "allowlist" | "open"; anything else fails closed. */
  signupMode: string | undefined
  /** `env.ALLOWED_GITHUB_ID` — the bootstrap owner id (kept working so
   * nothing breaks before/without the control-plane migration). */
  bootstrapGithubId: string | undefined
  /** Injectable clock for tests. */
  now?: () => number
}

/** Refresh `users.last_seen_at` at most this often (avoid a D1 write per
 * sync request — the sync loop runs every few seconds). */
const LAST_SEEN_REFRESH_MS = 6 * 60 * 60 * 1000

const allow: TenancyDecision = { allowed: true }
const deny = (status: number, error: string): TenancyDecision => ({ allowed: false, status, error })

/** Today's single-owner rule, verbatim — the fallback when the control-plane
 * tables are missing, and the bootstrap rule when `SIGNUP_MODE` is unset. */
function legacyOwnerDecision(id: number, bootstrapGithubId: string | undefined): TenancyDecision {
  if (!bootstrapGithubId) return deny(403, "owner_not_configured")
  return String(id) === bootstrapGithubId ? allow : deny(403, "forbidden")
}

async function provisionUser(
  driver: SqlDriver,
  identity: VerifiedIdentity,
  createdBy: "signup" | "allowlist",
  now: number,
): Promise<void> {
  await driver.exec(
    "INSERT INTO users (github_id, login, name, created_at, created_by, last_seen_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?4) ON CONFLICT (github_id) DO NOTHING",
    [identity.id, identity.login, identity.name, now, createdBy],
  )
}

/**
 * Decide whether the verified identity is a tenant, provisioning the `users`
 * row when the mode admits a new one. Pure of platform types: `driver` is the
 * control-plane database behind the `SqlDriver` seam.
 */
export async function resolveTenancy(
  driver: SqlDriver,
  identity: VerifiedIdentity,
  options: TenancyOptions,
): Promise<TenancyDecision> {
  const now = options.now?.() ?? Date.now()

  let existing: { status: string; last_seen_at: number | null } | undefined
  try {
    const rows = await driver.exec("SELECT status, last_seen_at FROM users WHERE github_id = ?1", [
      identity.id,
    ])
    existing = rows[0] as unknown as { status: string; last_seen_at: number | null } | undefined
  } catch {
    // Control-plane tables missing (migration 0003 not applied yet): behave
    // exactly like the pre-multi-tenant deployment.
    return legacyOwnerDecision(identity.id, options.bootstrapGithubId)
  }

  if (existing) {
    if (existing.status === "blocked") return deny(403, "blocked")
    if (existing.last_seen_at === null || now - existing.last_seen_at > LAST_SEEN_REFRESH_MS) {
      await driver.exec("UPDATE users SET last_seen_at = ?1 WHERE github_id = ?2", [
        now,
        identity.id,
      ])
    }
    return allow
  }

  // No users row: signing in is signing up — if the mode admits this id.
  if (options.signupMode === "open") {
    await provisionUser(driver, identity, "signup", now)
    return allow
  }

  const isBootstrapOwner =
    options.bootstrapGithubId !== undefined && String(identity.id) === options.bootstrapGithubId

  if (options.signupMode === "allowlist") {
    const listed = await driver.exec("SELECT github_id FROM allowlist WHERE github_id = ?1", [
      identity.id,
    ])
    if (listed.length === 0 && !isBootstrapOwner) return deny(403, "signup_closed")
    await provisionUser(driver, identity, "allowlist", now)
    return allow
  }

  // Mode absent or unrecognized: fail closed, bootstrap owner only.
  const decision = legacyOwnerDecision(identity.id, options.bootstrapGithubId)
  if (decision.allowed) await provisionUser(driver, identity, "allowlist", now)
  return decision
}
