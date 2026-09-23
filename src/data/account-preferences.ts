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
 * The account's preferences (src/data/preferences.ts) on this device: read
 * from `GET /api/preferences` once per sign-in, saved through `PUT`, and
 * remembered per account so a start with no network starts from the last
 * answer rather than from the defaults — the same arrangement as the
 * feature flags (src/data/features.ts). Signed out there is no account, so
 * the defaults stand and nothing can be saved.
 *
 * A save is optimistic: the device shows the new value at once and tells the
 * server; if the server refuses or cannot be reached, the value goes back to
 * what it was, since the account's preference is what the server holds and
 * a device that only thinks it changed it would drift from every other one.
 */

/** Null = nothing known for the current sign-in. */
const preferencesAtom = atom<AccountPreferences | null>(null)

const effectivePreferencesAtom = atom((get) => get(preferencesAtom) ?? DEFAULT_PREFERENCES)

/** Where the last answer for an account is kept on this device. */
const cacheKey = (owner: string) => `preferences:${owner}`

function readCache(owner: string): AccountPreferences | null {
  try {
    const raw = localStorage.getItem(cacheKey(owner))
    if (!raw) return null
    return withDefaults(readPreferences(JSON.parse(raw)))
  } catch {
    return null
  }
}

function writeCache(owner: string, preferences: AccountPreferences): void {
  try {
    localStorage.setItem(cacheKey(owner), JSON.stringify(preferences))
  } catch {
    // A full or unavailable localStorage: the preferences still stand in memory.
  }
}

/** The account the preferences are for, so an answer is remembered under it. */
let currentOwner: string | null = null

/** Start from what this account was last told on this device, if anything.
 * Called on sign-in, before `refreshPreferences` asks the server. */
export function seedPreferences(owner: string): void {
  currentOwner = owner
  const cached = readCache(owner)
  if (cached) getDefaultStore().set(preferencesAtom, cached)
}

const preferenceAtoms = {
  whatsNewCard: atom((get) => get(effectivePreferencesAtom).whatsNewCard),
} satisfies Record<keyof AccountPreferences, unknown>

/** One preference of the signed-in account, or its default signed out. */
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

/** Take the server's answer as the account's preferences, and remember it. */
function accept(body: unknown): void {
  const preferences = withDefaults(
    readPreferences((body as Partial<PreferencesBody> | null)?.preferences),
  )
  getDefaultStore().set(preferencesAtom, preferences)
  if (currentOwner !== null) writeCache(currentOwner, preferences)
}

/** Fetch the preferences for the signed-in account. Silent on failure: the
 * cached answer, or the defaults, stand. */
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
 * defaults. The device's memory of each account's answer is kept, under
 * that account, for its next sign-in. */
export function resetPreferences(): void {
  currentOwner = null
  getDefaultStore().set(preferencesAtom, null)
}
