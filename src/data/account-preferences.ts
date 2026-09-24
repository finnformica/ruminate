import { atom, getDefaultStore, useAtomValue } from "jotai"
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  withDefaults,
  type AccountPreferences,
  type PreferencesBody,
} from "./preferences"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

/**
 * The account's preferences (src/data/preferences.ts) as this sign-in knows
 * them: read from `GET /api/preferences` once per sign-in and again when the
 * network returns, saved through `PUT`, and held in memory only. Nothing is
 * kept on the device — the server holds the account's preference, so every
 * device the reader signs in on reads the same answer, and until it has
 * answered (or signed out, where there is no account) the defaults stand.
 *
 * A save is optimistic: the new value shows at once and is sent; if the
 * server refuses or cannot be reached, the value goes back to what it was,
 * since a device that only thinks it changed a preference would drift from
 * every other one.
 */

/** Null = nothing known for the current sign-in. */
const preferencesAtom = atom<AccountPreferences | null>(null)

const effectivePreferencesAtom = atom((get) => get(preferencesAtom) ?? DEFAULT_PREFERENCES)

const preferenceAtoms = {
  whatsNewCard: atom((get) => get(effectivePreferencesAtom).whatsNewCard),
} satisfies Record<keyof AccountPreferences, unknown>

/** One preference of the signed-in account, or its default until known. */
export function useAccountPreference<K extends keyof AccountPreferences>(
  key: K,
): AccountPreferences[K] {
  return useAtomValue(preferenceAtoms[key])
}

async function request(init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  await ensureFreshToken()
  return withAuthRetry(async () => {
    const token = getAccessToken()
    if (!token) throw Object.assign(new Error("Not signed in."), { status: 401 })
    const res = await fetchImpl("/api/preferences", {
      ...init,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
    if (res.status === 401) {
      throw Object.assign(new Error("Preferences request rejected (401)"), { status: 401 })
    }
    return res
  })
}

/** Take the server's answer as the account's preferences. */
function accept(body: unknown): void {
  const preferences = withDefaults(
    readPreferences((body as Partial<PreferencesBody> | null)?.preferences),
  )
  getDefaultStore().set(preferencesAtom, preferences)
}

/** Fetch the preferences for the signed-in account. Silent on failure: what
 * this sign-in already knows, or the defaults, stand. */
export async function refreshPreferences(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    if (!getAccessToken()) return
    const response = await request({ method: "GET" }, fetchImpl)
    if (!response.ok) return
    accept(await response.json())
  } catch {
    // Left as they were; see the module note.
  }
}

/**
 * Save some of the preferences. Shown at once, then sent; put back if the
 * server does not take them. Rejects when it does not, so the control that
 * asked can say so.
 */
export async function saveAccountPreferences(
  patch: Partial<AccountPreferences>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const store = getDefaultStore()
  const before = store.get(effectivePreferencesAtom)
  store.set(preferencesAtom, { ...before, ...patch })
  try {
    const response = await request(
      { method: "PUT", body: JSON.stringify({ preferences: patch }) },
      fetchImpl,
    )
    if (!response.ok) throw new Error(`Preferences save rejected (${response.status})`)
    accept(await response.json())
  } catch (error) {
    store.set(preferencesAtom, before)
    throw error
  }
}

/** Forget the preferences — on sign-out, so the next account starts from the
 * defaults until the server has answered for it. */
export function resetPreferences(): void {
  getDefaultStore().set(preferencesAtom, null)
}
