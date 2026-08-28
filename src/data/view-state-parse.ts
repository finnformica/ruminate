/**
 * Pure parsing and write-planning for the view-state sidecar files.
 *
 * Kept free of app/state imports so it can be unit-tested without pulling in
 * the global state machine (and its browser-only filesystem).
 */

import { LEGACY_VIEW_STATE_PATH, viewStatePath } from "./paths"

/** View state keyed by note id: currently the ids of that note's collapsed blocks. */
export type ViewState = Record<string, string[]>

/**
 * Parse the raw legacy `.ruminate/view-state.json` contents into a `ViewState`.
 * Tolerant by design — missing or malformed JSON, and entries of the wrong
 * shape, degrade to empty rather than throwing, so a corrupt sidecar can never
 * break the editor.
 */
export function parseViewState(raw: string | undefined): ViewState {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const result: ViewState = {}
    for (const [noteId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        result[noteId] = ids.filter((x): x is string => typeof x === "string")
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * Parse one per-note view-state file (`.ruminate/view-state/<noteId>.json`):
 * a JSON array of collapsed block ids. Same tolerance as `parseViewState` —
 * anything malformed degrades to empty.
 */
export function parseNoteViewState(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string")
  } catch {
    return []
  }
}

/**
 * Canonical serialization of one note's collapsed ids: sorted and de-duplicated
 * so the same *set* of collapsed blocks always produces the same bytes —
 * fold-then-unfold round-trips to identical content and is skipped instead of
 * committed.
 */
export function serializeNoteViewState(collapsedIds: string[]): string {
  const canonical = [...new Set(collapsedIds)].sort()
  return JSON.stringify(canonical, null, 2)
}

/**
 * Read the collapsed block ids for one note from the raw file map: the per-note
 * file wins; a note not yet migrated falls back to its entry in the legacy
 * single-file sidecar.
 */
export function readNoteViewState(
  files: Record<string, string>,
  noteId: string | undefined,
): string[] {
  if (!noteId) return []
  const perNote = files[viewStatePath(noteId)]
  if (perNote !== undefined) return parseNoteViewState(perNote)
  const legacy = files[LEGACY_VIEW_STATE_PATH]
  if (legacy !== undefined) return parseViewState(legacy)[noteId] ?? []
  return []
}

/**
 * Plan the file writes for persisting one note's collapse state.
 *
 * Returns a path → content map (`null` deletes), or `null` when nothing needs
 * to be written — serialized content unchanged and no migration pending — so
 * the caller can skip the commit entirely.
 *
 * If the legacy single-file sidecar still exists, this write also migrates it:
 * every other note's entry is split into its per-note file and the legacy file
 * is deleted, all in the same commit. Because the legacy file is deleted by
 * that first write, the migration runs exactly once.
 */
export function buildViewStateWrite(
  files: Record<string, string>,
  noteId: string,
  collapsedIds: string[],
): Record<string, string | null> | null {
  const updates: Record<string, string | null> = {}

  // One-time migration of the legacy single-file sidecar.
  const legacyRaw = files[LEGACY_VIEW_STATE_PATH]
  if (legacyRaw !== undefined) {
    const legacy = parseViewState(legacyRaw)
    for (const [id, ids] of Object.entries(legacy)) {
      if (id === noteId) continue // written below from live state
      if (files[viewStatePath(id)] !== undefined) continue // already migrated
      if (ids.length === 0) continue
      updates[viewStatePath(id)] = serializeNoteViewState(ids)
    }
    updates[LEGACY_VIEW_STATE_PATH] = null
  }

  // This note's own file.
  const path = viewStatePath(noteId)
  const existing = files[path]
  if (collapsedIds.length === 0) {
    if (existing !== undefined) updates[path] = null
  } else {
    const content = serializeNoteViewState(collapsedIds)
    if (existing !== content) updates[path] = content
  }

  return Object.keys(updates).length > 0 ? updates : null
}
