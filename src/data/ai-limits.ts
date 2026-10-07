/**
 * Every cap the AI requests and answers are held to (docs/boards.md,
 * "Tagging with Claude"), in one place: what a board may send a model,
 * what may be read back from it, and what the Worker spends and keeps. A
 * request's strings are cut here too (`cut`, `readLabel`, `readValues`,
 * `readNotes`), so the tag and the notes requests read the same way.
 */

/** Calls one account may make in a UTC day — a fuse on the user's own bill
 * (the key is theirs), not a quota; one count for every route that asks. */
export const AUTO_TAG_DAILY_LIMIT = 300

/** The most the picture's bytes may weigh: the API takes five megabytes of
 * base64, which is three and three-quarter of raw bytes. A sanity limit —
 * the client sends a copy fitted for the model (`visionCopy`,
 * src/data/image-fit.ts), which is far below it. */
export const AUTO_TAG_MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4)

// What a board may send, so a board cannot stuff the prompt.
export const MAX_BOARD_LENGTH = 120
export const MAX_FEATURES = 12
export const MAX_VALUES_PER_FEATURE = 200
export const MAX_LABEL_LENGTH = 60
export const MAX_VALUE_LENGTH = 60
export const MAX_NOTES_LENGTH = 500

// What may be read back, so an answer cannot stuff the graph.
export const MAX_CAPTION_LENGTH = 120
/** How many values the model may give one feature at once. */
export const MAX_SUGGESTED_VALUES = 5
/** The most a NEW value may be: it becomes a menu option. A value in use
 * is never shortened (`MAX_VALUE_LENGTH` is for the request). */
export const MAX_SUGGESTED_VALUE_LENGTH = 30

/** The most of a provider's words — an error's message, an answer that
 * was not what was asked — a refusal carries: cut to a size a toast can
 * hold. */
export const MAX_DETAIL_LENGTH = 2000

/** The most of a prompt, an answer or a result one row of the history
 * keeps (migrations/0022): a board's worth of values can run to many
 * kilobytes, and a row is kept for good. */
export const MAX_HISTORY_TEXT_LENGTH = 20_000

/** A string trimmed and cut to `max`. */
export const cut = (text: string, max: number): string => text.trim().slice(0, max)

/** A feature's label out of a request, or null when it is not one: a
 * non-empty string, trimmed and cut. */
export function readLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const label = cut(raw, MAX_LABEL_LENGTH)
  return label === "" ? null : label
}

/** A feature's values out of a request, or null when they are not a list
 * of strings within the cap: each trimmed and cut, the empty ones dropped. */
export function readValues(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_VALUES_PER_FEATURE) return null
  const values: string[] = []
  for (const value of raw) {
    if (typeof value !== "string") return null
    const text = cut(value, MAX_VALUE_LENGTH)
    if (text !== "") values.push(text)
  }
  return values
}

/** A feature's notes out of a request: trimmed and cut, "" when there are
 * none or they are not a string. */
export const readNotes = (raw: unknown): string =>
  typeof raw === "string" ? cut(raw, MAX_NOTES_LENGTH) : ""
