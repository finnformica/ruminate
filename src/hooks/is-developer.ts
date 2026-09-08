import { atom, useAtomValue } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { githubUserAtom, markdownFilesAtom } from "../global-state"
import { buildBlockHomesIndex, type BlockHomesIndex } from "../utils/block-homes"

/**
 * Developer mode: debug affordances that only the app's developer should ever
 * see (block ids beside every block, graph metadata beneath them, …).
 *
 * The gate is the signed-in GitHub account. The numeric id is the strongest
 * signal — it is the tenant key and the bootstrap owner (`ALLOWED_GITHUB_ID`)
 * and cannot be changed — so it is checked first; the login and the primary
 * email are accepted too, and so is GitHub's private-email alias
 * (`<id>+<login>@users.noreply.github.com`), which is what an account with
 * "keep my email addresses private" used to be stored under. This is
 * client-side gating of debug CHROME only: it decides what the UI shows, it
 * protects nothing. Signed out (sample notes) there is no developer.
 */
const DEVELOPER = {
  githubId: 42536816,
  login: "finnformica",
  emails: ["finnformica@gmail.com"] as readonly string[],
}

const NOREPLY_RE = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/

/** Whether an email identifies the developer: the primary address, or the
 * noreply alias carrying the developer's id or login. */
export function isDeveloperEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  if (DEVELOPER.emails.includes(normalized)) return true
  const alias = NOREPLY_RE.exec(normalized)
  if (!alias) return false
  return Number(alias[1]) === DEVELOPER.githubId || alias[2] === DEVELOPER.login
}

/** Whether a signed-in GitHub user is the developer (see the module note). */
export function isDeveloperUser(
  user: { id?: number; login?: string; email?: string | null } | null | undefined,
): boolean {
  if (!user) return false
  if (user.id === DEVELOPER.githubId) return true
  if (user.login?.trim().toLowerCase() === DEVELOPER.login) return true
  return isDeveloperEmail(user.email)
}

/** Whether the signed-in user is the developer. */
const isDeveloperAtom = atom((get) => isDeveloperUser(get(githubUserAtom)))

export function useIsDeveloper(): boolean {
  return useAtomValue(isDeveloperAtom)
}

/** The developer's debug toggles. Each is off until switched on from the
 * open note's actions menu (`note-actions-menu.tsx`). */
export interface DeveloperDebugFlags {
  /** Show every block's `blk_` id beside it (click to copy). */
  blockIds: boolean
  /** Show every block's graph metadata beneath it: type, children, and the
   * notes it lives in — the tell for whether a paste linked or duplicated. */
  blockMetadata: boolean
}

const OFF: DeveloperDebugFlags = { blockIds: false, blockMetadata: false }

/** The stored preference. Persisted locally like the other UI preferences;
 * read it through `developerDebugAtom`, which applies the developer gate. */
export const developerDebugPreferenceAtom = atomWithStorage<DeveloperDebugFlags>(
  "developer-debug",
  OFF,
)

/**
 * The EFFECTIVE debug flags: the stored preference for the developer, all-off
 * for anyone else — so a preference left in localStorage can never switch
 * debug chrome on for a different account signing in on the same browser.
 */
export const developerDebugAtom = atom<DeveloperDebugFlags>((get) => {
  if (!get(isDeveloperAtom)) return OFF
  const stored = get(developerDebugPreferenceAtom)
  return { ...OFF, ...stored }
})

export function useDeveloperDebug(): DeveloperDebugFlags {
  return useAtomValue(developerDebugAtom)
}

/**
 * Block id → the notes whose content declares it, for the block-metadata
 * readout. Null (and, importantly, NOT subscribed to the corpus — which
 * changes on every autosave of any note) unless block metadata is on.
 */
export const blockHomesIndexAtom = atom<BlockHomesIndex | null>((get) =>
  get(developerDebugAtom).blockMetadata ? buildBlockHomesIndex(get(markdownFilesAtom)) : null,
)
