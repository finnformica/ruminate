/**
 * What this device knows about the what's-new card.
 *
 * Two facts, both kept in browser storage because both are about this device
 * rather than this account: whether the reader has just asked for an update,
 * and which build of the changelog they last saw.
 *
 * Storage can be absent or throw (a private window, blocked site data), and
 * the honest answer there is that this device has asked for nothing and seen
 * nothing, so the card stays away.
 */

/** Set when the reader takes a waiting update, read on the boot that follows. */
const REQUESTED_KEY = "changelog-show-after-update"

/** The changelog build this device last saw (`<week>.<hash>`, vite.config.ts). */
const SEEN_KEY = "changelog-last-seen"

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Nothing to be done, and nothing that needs saying: at worst the reader
    // is shown the card once more than they should be, or once less.
  }
}

function forget(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // As above.
  }
}

/**
 * Remember that the reader asked for the update they are about to get.
 *
 * Taking an update reloads the page (`src/hooks/app-update.ts`), so there is no
 * moment in which anything could be shown: this outlives the reload, and the
 * boot that follows finds it.
 *
 * This is what makes the card work the first time. Without it the card had only
 * the stored build to go on, and a device arriving from a build that predates
 * the card has none — so the first update after it shipped showed nothing at
 * all, to everybody, which is the one update they were most likely to be
 * curious about.
 */
export function markUpdateRequested() {
  write(REQUESTED_KEY, "1")
}

/** Whether the reader asked for this build, clearing the note either way so a
 * later reload is not mistaken for another update. */
export function takeUpdateRequest(): boolean {
  const asked = read(REQUESTED_KEY) !== null
  forget(REQUESTED_KEY)
  return asked
}

/** The build last seen, or `null` on a device that has never stored one. */
export function lastSeenVersion(): string | null {
  return read(SEEN_KEY)
}

export function rememberVersion(version: string) {
  write(SEEN_KEY, version)
}
