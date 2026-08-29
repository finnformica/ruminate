/**
 * Pure parsing and write-planning for the view-state sidecar entries.
 *
 * Kept free of app/state imports so it can be unit-tested without pulling in
 * the global state machine or the database runtime.
 */

import { viewStatePath } from "./paths"

/**
 * Parse one per-note view-state entry (`.ruminate/view-state/<noteId>.json`):
 * a JSON array of collapsed block ids. Tolerant by design — missing or
 * malformed JSON, and entries of the wrong shape, degrade to empty rather than
 * throwing, so a corrupt sidecar can never break the editor.
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
 * written.
 */
export function serializeNoteViewState(collapsedIds: string[]): string {
  const canonical = [...new Set(collapsedIds)].sort()
  return JSON.stringify(canonical, null, 2)
}

/** Read the collapsed block ids for one note from the raw file map. */
export function readNoteViewState(
  files: Record<string, string>,
  noteId: string | undefined,
): string[] {
  if (!noteId) return []
  return parseNoteViewState(files[viewStatePath(noteId)])
}

/**
 * Plan the file writes for persisting one note's collapse state.
 *
 * Returns a path → content map (`null` deletes), or `null` when nothing needs
 * to be written — serialized content unchanged — so the caller can skip the
 * write entirely.
 */
export function buildViewStateWrite(
  files: Record<string, string>,
  noteId: string,
  collapsedIds: string[],
): Record<string, string | null> | null {
  const path = viewStatePath(noteId)
  const existing = files[path]
  if (collapsedIds.length === 0) {
    return existing !== undefined ? { [path]: null } : null
  }
  const content = serializeNoteViewState(collapsedIds)
  return existing !== content ? { [path]: content } : null
}
