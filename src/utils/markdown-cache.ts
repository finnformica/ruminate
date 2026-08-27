/**
 * The localStorage cache of the repo's markdown files (`markdown_files`), used
 * to skip the worktree walk on page load. It is strictly a load-time
 * optimization: the git worktree (lightning-fs) is always the source of truth,
 * and `resolveRepo` falls back to walking it whenever this cache is absent.
 *
 * Every write is quota-guarded: when `setItem` throws (QuotaExceededError,
 * private-mode restrictions), we degrade to fs-only by *clearing* the cache
 * key — a partial/stale cache must never shadow the worktree — and surface a
 * one-time warning through `storageWarningAtom`.
 */

import { atom, getDefaultStore } from "jotai"
import { z } from "zod"

const MARKDOWN_FILES_STORAGE_KEY = "markdown_files"

/** One-time, non-blocking warning that local storage is full (or unusable). */
export const storageWarningAtom = atom<string | null>(null)

const QUOTA_WARNING =
  "This browser's local storage is full. Notes are still saved and synced via git, but page loads may be slower until space frees up."

/** Read the cached markdown files, or null when absent/invalid. */
export function getMarkdownFilesCache(): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem(MARKDOWN_FILES_STORAGE_KEY)
    if (!raw) return null
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Replace the cache. On quota failure, degrade to fs-only (see module doc). */
export function setMarkdownFilesCache(markdownFiles: Record<string, string>) {
  try {
    window.localStorage.setItem(MARKDOWN_FILES_STORAGE_KEY, JSON.stringify(markdownFiles))
  } catch {
    clearMarkdownFilesCache()
    warnStorageDegradedOnce()
  }
}

export function clearMarkdownFilesCache() {
  try {
    window.localStorage.removeItem(MARKDOWN_FILES_STORAGE_KEY)
  } catch {
    // Storage unavailable entirely — nothing to clear.
  }
}

function warnStorageDegradedOnce() {
  const store = getDefaultStore()
  if (store.get(storageWarningAtom)) return
  store.set(storageWarningAtom, QUOTA_WARNING)
}
