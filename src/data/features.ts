import { atom, getDefaultStore, useAtomValue } from "jotai"
import {
  DEFAULT_AUDIENCES,
  FEATURE_KEYS,
  audienceAdmits,
  type EnabledFeatures,
  type FeatureKey,
  type FeaturesBody,
} from "./feature-flags"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

/**
 * The feature flags as this account may use them (src/data/feature-flags.ts),
 * read from `GET /api/features` once per sign-in. The Worker enforces the
 * flags on each feature's own routes; this is only what the client draws —
 * the Settings panels, the Share… menu items, the Admin link.
 *
 * Until the request has answered, the last answer this account got on this
 * device stands (`seedFeatures`, from localStorage), and before there has
 * been one the registry DEFAULTS do, evaluated for a non-admin. So a start
 * with no network — the app reopened on a phone, offline — keeps the admin's
 * page and everyone's panels as they were, rather than hiding them behind a
 * request that cannot return; and a panel that is off is at worst shown to
 * a caller the server will refuse. The request runs again when the network
 * comes back (use-database-mode.ts).
 */

const DEFAULTS: FeaturesBody = {
  admin: false,
  features: Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, audienceAdmits(DEFAULT_AUDIENCES[key], false)]),
  ) as EnabledFeatures,
}

/** Null = nothing known for the current sign-in. */
const featuresAtom = atom<FeaturesBody | null>(null)

/** Where the last answer for an account is kept on this device. */
const cacheKey = (owner: string) => `features:${owner}`

function readCache(owner: string): FeaturesBody | null {
  try {
    const raw = localStorage.getItem(cacheKey(owner))
    if (!raw) return null
    const body = JSON.parse(raw) as Partial<FeaturesBody> | null
    if (!body || typeof body.features !== "object" || body.features === null) return null
    return {
      admin: body.admin === true,
      features: { ...DEFAULTS.features, ...body.features },
    }
  } catch {
    return null
  }
}

function writeCache(owner: string, body: FeaturesBody): void {
  try {
    localStorage.setItem(cacheKey(owner), JSON.stringify(body))
  } catch {
    // A full or unavailable localStorage: the flags still stand in memory.
  }
}

/** The account the flags are for, so a fetched answer is remembered under it. */
let currentOwner: string | null = null

/**
 * Start from what this account was last told on this device, if anything,
 * so a start with no network is not a start as a stranger. Called on
 * sign-in, before `refreshFeatures` asks the server.
 */
export function seedFeatures(owner: string): void {
  currentOwner = owner
  const cached = readCache(owner)
  if (cached) getDefaultStore().set(featuresAtom, cached)
}

const effectiveFeaturesAtom = atom((get) => get(featuresAtom) ?? DEFAULTS)

/** Whether this account is the admin, as the server said. False until it has. */
const isAdminAtom = atom((get) => get(effectiveFeaturesAtom).admin)

export function useIsAdmin(): boolean {
  return useAtomValue(isAdminAtom)
}

const featureAtoms = Object.fromEntries(
  FEATURE_KEYS.map((key) => [key, atom((get) => get(effectiveFeaturesAtom).features[key])]),
) as Record<FeatureKey, ReturnType<typeof atom<boolean>>>

/** Whether this account may use a feature. */
export function useFeature(key: FeatureKey): boolean {
  return useAtomValue(featureAtoms[key])
}

/** Fetch the flags for the signed-in account. Silent on failure: the
 * defaults stand, and the feature's routes are the ones that refuse. */
export async function refreshFeatures(fetchImpl: typeof fetch = fetch): Promise<void> {
  const store = getDefaultStore()
  try {
    await ensureFreshToken()
    if (!getAccessToken()) return
    const response = await withAuthRetry(async () => {
      const token = getAccessToken()
      if (!token) throw Object.assign(new Error("Not signed in."), { status: 401 })
      const res = await fetchImpl("/api/features", {
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        throw Object.assign(new Error("Features request rejected (401)"), { status: 401 })
      }
      return res
    })
    if (!response.ok) return
    const body = (await response.json()) as Partial<FeaturesBody> | null
    if (!body || typeof body.features !== "object" || body.features === null) return
    const next: FeaturesBody = {
      admin: body.admin === true,
      features: {
        ...DEFAULTS.features,
        ...Object.fromEntries(
          FEATURE_KEYS.filter((key) => typeof body.features?.[key] === "boolean").map((key) => [
            key,
            body.features?.[key],
          ]),
        ),
      },
    }
    store.set(featuresAtom, next)
    if (currentOwner !== null) writeCache(currentOwner, next)
  } catch {
    // Left as they were — the cached answer, or the defaults; see the
    // module note.
  }
}

/** Forget the flags — on sign-out, so the next account starts from the
 * defaults. The device's memory of each account's answer is kept, under
 * that account, for its next sign-in. */
export function resetFeatures(): void {
  currentOwner = null
  getDefaultStore().set(featuresAtom, null)
}
