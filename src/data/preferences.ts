/**
 * Account preferences: the settings that follow the account rather than the
 * device, shared by the Worker (which stores them, `worker/handlers/preferences.ts`)
 * and the client (which draws and saves them, `src/data/account-preferences.ts`).
 *
 * A device setting — theme, accent, how many levels a note opens with — is
 * about the device: the same account on a phone and a laptop wants them
 * set separately. A preference here is about the person: answered once, it
 * should hold wherever they sign in. There are few of them, so they travel
 * as one small JSON object under the tenant's `meta` row `preferences`,
 * read whole and written whole, with unknown keys dropped on the way in so
 * a build that has not heard of a preference cannot corrupt it and a stale
 * build cannot smuggle one in.
 */

export interface AccountPreferences {
  /** Whether the what's-new card greets an update
   * (src/components/whats-new-popover.tsx). Off until asked for. */
  whatsNewCard: boolean
}

export const DEFAULT_PREFERENCES: AccountPreferences = {
  whatsNewCard: false,
}

/** The body both directions carry: `GET` returns it, `PUT` takes a partial
 * of it and returns the whole. */
export interface PreferencesBody {
  preferences: AccountPreferences
}

/**
 * The preferences a stored or received value actually states — only the
 * keys this build knows, each only if it has the right type. Anything else
 * (a malformed row, an older or newer shape, a hand-edited body) reads as
 * saying nothing about that key.
 */
export function readPreferences(raw: unknown): Partial<AccountPreferences> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const read: Partial<AccountPreferences> = {}
  if (typeof record.whatsNewCard === "boolean") read.whatsNewCard = record.whatsNewCard
  return read
}

/** A stated partial over the defaults: what a caller acts on. */
export const withDefaults = (stated: Partial<AccountPreferences>): AccountPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...stated,
})
