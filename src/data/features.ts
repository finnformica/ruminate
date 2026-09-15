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
 * Until the request has answered (or when it cannot: offline, a Worker
 * ahead of its migration) the registry DEFAULTS stand, evaluated for a
 * non-admin. So a panel that is on for everyone is never hidden by a
 * request that has not returned, and one that is off is at worst shown to a
 * caller the server will refuse.
 */

const DEFAULTS: FeaturesBody = {
  admin: false,
  features: Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, audienceAdmits(DEFAULT_AUDIENCES[key], false)]),
  ) as EnabledFeatures,
}

/** Null = not fetched for the current sign-in. */
const featuresAtom = atom<FeaturesBody | null>(null)

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
    store.set(featuresAtom, {
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
    })
  } catch {
    // Left at the defaults; see the module note.
  }
}

/** Forget the flags — on sign-out, so the next account starts from the defaults. */
export function resetFeatures(): void {
  getDefaultStore().set(featuresAtom, null)
}
