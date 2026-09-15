// Feature flags, Worker side — the enforcement half of the registry in
// src/data/feature-flags.ts (migrations/0013).
//
// A flag's audience decides who a feature is served to: `off` nobody,
// `admin` the bootstrap owner only, `everyone` every tenant. The routes a
// feature owns ask `featureAllows` after `requireSession`, so a switched-off
// feature is refused server-side whatever the client shows; the client reads
// `effectiveFeatures` (`GET /api/features`) only to know what to draw.
//
// Pure of platform types, like `tenancy.ts`: the control plane comes in
// behind the `SqlDriver` seam, so the worker suites drive these exact
// statements on `node:sqlite`.

import {
  audienceAdmits,
  DEFAULT_AUDIENCES,
  FEATURE_KEYS,
  isAudience,
  type Audience,
  type EnabledFeatures,
  type FeatureAudiences,
  type FeatureKey,
} from "../src/data/feature-flags"
import type { SqlDriver } from "../src/data/sql-driver"
import type { Env } from "./types"

/**
 * The admin is the bootstrap owner (`ALLOWED_GITHUB_ID`): the one id that
 * was always admitted, now also the one that admits others and sets the
 * switches. Without the var configured there is no admin at all.
 */
export function isAdmin(env: Pick<Env, "ALLOWED_GITHUB_ID">, userId: number): boolean {
  return env.ALLOWED_GITHUB_ID !== undefined && String(userId) === env.ALLOWED_GITHUB_ID
}

/**
 * Every feature's audience: the stored row where there is one, the registry
 * default otherwise. A missing table (migration 0013 not applied) reads as
 * all defaults — a deploy ahead of its migration changes nothing.
 */
export async function featureAudiences(driver: SqlDriver): Promise<FeatureAudiences> {
  const audiences: FeatureAudiences = { ...DEFAULT_AUDIENCES }
  let rows: Record<string, unknown>[]
  try {
    rows = await driver.exec("SELECT key, audience FROM feature_flags")
  } catch {
    return audiences
  }
  for (const row of rows) {
    const key = row.key
    if (
      typeof key === "string" &&
      (FEATURE_KEYS as readonly string[]).includes(key) &&
      isAudience(row.audience)
    ) {
      audiences[key as FeatureKey] = row.audience
    }
  }
  return audiences
}

/** Set one feature's audience. Upsert: a feature with no row gets one. */
export async function setFeatureAudience(
  driver: SqlDriver,
  key: FeatureKey,
  audience: Audience,
  updatedBy: number,
  now = Date.now(),
): Promise<void> {
  await driver.exec(
    "INSERT INTO feature_flags (key, audience, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (key) DO UPDATE SET audience = excluded.audience, " +
      "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    [key, audience, now, updatedBy],
  )
}

/** The features this user may use, given every flag's audience. */
export function enabledFor(audiences: FeatureAudiences, admin: boolean): EnabledFeatures {
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, audienceAdmits(audiences[key], admin)]),
  ) as EnabledFeatures
}

/** Whether `userId` may use `key` — one read of the flags table. */
export async function featureAllows(
  driver: SqlDriver,
  env: Pick<Env, "ALLOWED_GITHUB_ID">,
  key: FeatureKey,
  userId: number,
): Promise<boolean> {
  const audiences = await featureAudiences(driver)
  return audienceAdmits(audiences[key], isAdmin(env, userId))
}

/** The JSON body a feature's routes answer with when the flag refuses. */
export const featureRefusal = (key: FeatureKey): { error: string; detail: string } => ({
  error: "feature_off",
  detail: `The ${key} feature is not enabled for this account.`,
})
