import { NoteId } from "../schema"

const DRAFT_PREFIX = "draft" as const
const DRAFT_DEBOUNCE_MS = 500

/**
 * A persisted draft plus its provenance: `baseHash` fingerprints the note
 * content the draft was based on, so a draft can be recognized as stale (the
 * note advanced while the draft slept) even across a page reload. Null =
 * unknown (legacy bare-string drafts, or a new note with no saved content).
 */
export type NoteDraftEntry = {
  value: string
  baseHash: string | null
}

/**
 * Cheap content fingerprint (length + djb2) for draft provenance. Not
 * cryptographic — collisions only risk a missed staleness notice, never data
 * loss (saves still go through the editor value).
 */
export function hashNoteContent(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0
  }
  return `${content.length}:${(hash >>> 0).toString(36)}`
}

/**
 * Parse a raw localStorage draft. New drafts are a JSON envelope
 * `{v: 1, value, baseHash}`; old drafts are the bare markdown string
 * (unknown base). A note that happens to be valid JSON but isn't the envelope
 * falls through to the legacy branch.
 */
function parseDraft(raw: string): NoteDraftEntry {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { value?: unknown }).value === "string"
    ) {
      const { value, baseHash } = parsed as { value: string; baseHash?: unknown }
      return { value, baseHash: typeof baseHash === "string" ? baseHash : null }
    }
  } catch {
    // Not JSON — legacy bare-string draft.
  }
  return { value: raw, baseHash: null }
}

// Keep track of pending debounced writes per storage key so we can
// coalesce rapid updates and cancel when clearing a draft
const draftWriteTimers = new Map<string, number>()

function getNoteStorageKey(noteId: NoteId) {
  return `${DRAFT_PREFIX}::${noteId}`
}

/** The draft's value plus its provenance, or null when no draft exists. */
export function getNoteDraftEntry(noteId: NoteId): NoteDraftEntry | null {
  if (typeof window === "undefined" || !window.localStorage) return null

  try {
    const key = getNoteStorageKey(noteId)
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : parseDraft(raw)
  } catch {
    // Ignore storage errors (e.g., private mode restrictions)
    return null
  }
}

/** The draft's markdown value, or null when no draft exists. */
export function getNoteDraft(noteId: NoteId): string | null {
  return getNoteDraftEntry(noteId)?.value ?? null
}

export function setNoteDraft({
  noteId,
  value,
  baseHash,
  immediate = false,
}: {
  noteId: NoteId
  value: string
  /**
   * Provenance: `hashNoteContent` of the note content the draft is based on
   * (null = unknown). When omitted, the existing draft's provenance is
   * preserved — right for callers that modify a draft in place (see task.ts)
   * without knowing what it was based on.
   */
  baseHash?: string | null
  immediate?: boolean
}) {
  if (typeof window === "undefined" || !window.localStorage) return

  try {
    const key = getNoteStorageKey(noteId)
    const resolvedBaseHash =
      baseHash !== undefined ? baseHash : (getNoteDraftEntry(noteId)?.baseHash ?? null)
    const payload = JSON.stringify({ v: 1, value, baseHash: resolvedBaseHash })

    // Cancel any pending debounced write
    const existingTimerId = draftWriteTimers.get(key)
    if (existingTimerId !== undefined) {
      window.clearTimeout(existingTimerId)
      draftWriteTimers.delete(key)
    }

    if (immediate) {
      // Write immediately without debounce
      window.localStorage.setItem(key, payload)
    } else {
      // Debounce writes to reduce pressure on localStorage
      const timeoutId = window.setTimeout(() => {
        try {
          window.localStorage.setItem(key, payload)
        } catch {
          // Ignore storage errors (e.g., private mode restrictions)
        } finally {
          draftWriteTimers.delete(key)
        }
      }, DRAFT_DEBOUNCE_MS)
      draftWriteTimers.set(key, timeoutId)
    }
  } catch {
    // Ignore storage errors (e.g., private mode restrictions)
  }
}

export function clearNoteDraft(noteId: NoteId) {
  if (typeof window === "undefined" || !window.localStorage) return

  try {
    const key = getNoteStorageKey(noteId)
    // Cancel any pending debounced write for this key to avoid
    // re-creating the draft after it's been cleared (e.g., after save)
    const existingTimerId = draftWriteTimers.get(key)
    if (existingTimerId !== undefined) {
      window.clearTimeout(existingTimerId)
      draftWriteTimers.delete(key)
    }
    window.localStorage.removeItem(key)
  } catch {
    // Ignore storage errors (e.g., private mode restrictions)
  }
}
