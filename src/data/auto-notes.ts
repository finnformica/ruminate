/**
 * Notes for a board's features, from a model (docs/boards.md, "Features"
 * and "Tagging with Claude") — the half shared by the Worker, which asks
 * (worker/handlers/board-notes.ts), and the client, which sends the board
 * as it stands and writes the answer (src/hooks/board.ts). As with tagging
 * (`auto-tag.ts`), the shapes here are the request, the prompt built from
 * it, the schema the answer is held to and the reading of the answer back
 * — pure, with no platform types, so both sides and the tests run the same
 * code.
 *
 * The model is given everything the board already says in words — its
 * name, and each feature's label, type, whether it takes several values,
 * the values in use (the strongest sign of what a feature means) and any
 * notes already written, so the style matches — and no picture. It writes
 * the notes that are missing; it does not add, rename or remove features,
 * and the client never overwrites a note that has text.
 */

import type { AiProvider } from "./auto-tag"
import type { FeatureType } from "./boards"

/** A feature as the client describes it: all text already on the board. */
export interface NotesFeature {
  label: string
  type: FeatureType
  multi: boolean
  values: string[]
  /** The notes as they stand, "" when none. */
  notes: string
}

/** What `POST /api/boards/notes` takes: the board's name and its features. */
export interface NotesRequest {
  board: string
  features: NotesFeature[]
}

/** What the model answers, read back: notes per feature it was asked
 * about, by label. */
export interface NotesSuggestion {
  notes: { label: string; notes: string }[]
}

/** `POST /api/boards/notes` answers this. */
export interface NotesResponse extends NotesSuggestion {
  provider: AiProvider
  model: string
  log?: string
}

// Limits on what is sent and what is read back, as the tag request's.
const MAX_BOARD_LENGTH = 120
const MAX_FEATURES = 12
const MAX_VALUES_PER_FEATURE = 200
const MAX_LABEL_LENGTH = 60
const MAX_VALUE_LENGTH = 60
const MAX_NOTES_LENGTH = 500

const normalise = (text: string) => text.trim().toLocaleLowerCase()

const FEATURE_TYPES: readonly FeatureType[] = ["text", "place", "link"]

/**
 * The request a value states, or null when it is not one: a board's name
 * (any string, cut), up to a dozen features, each a label, a type, a
 * `multi` flag, a list of values and notes, every string trimmed and cut
 * to length.
 */
export function readNotesRequest(raw: unknown): NotesRequest | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.board !== "string" || !Array.isArray(record.features)) return null
  if (record.features.length > MAX_FEATURES) return null
  const features: NotesFeature[] = []
  for (const entry of record.features) {
    if (typeof entry !== "object" || entry === null) return null
    const feature = entry as Record<string, unknown>
    if (typeof feature.label !== "string" || typeof feature.multi !== "boolean") return null
    if (!FEATURE_TYPES.includes(feature.type as FeatureType)) return null
    if (!Array.isArray(feature.values) || feature.values.length > MAX_VALUES_PER_FEATURE) {
      return null
    }
    const label = feature.label.trim().slice(0, MAX_LABEL_LENGTH)
    if (label === "") return null
    const values: string[] = []
    for (const value of feature.values) {
      if (typeof value !== "string") return null
      const text = value.trim().slice(0, MAX_VALUE_LENGTH)
      if (text !== "") values.push(text)
    }
    const notes =
      typeof feature.notes === "string" ? feature.notes.trim().slice(0, MAX_NOTES_LENGTH) : ""
    features.push({ label, type: feature.type as FeatureType, multi: feature.multi, values, notes })
  }
  return { board: record.board.trim().slice(0, MAX_BOARD_LENGTH), features }
}

/** What the model is, and how it is to answer. Fixed text, so it caches. */
export const AUTO_NOTES_SYSTEM_PROMPT = [
  "You help set up a mood board — inspiration kept for a home, a garden, a project — whose",
  "pictures are tagged by a vision model. The board has features, each with a short note",
  'telling the vision model what the feature means and how to answer it, such as "the thing',
  'the picture is of, such as furniture, lighting, cutlery, plants or decoration". You are',
  "given the board's name, which says what the board is about, and its features: each one's",
  "label, type, whether it takes one value or several, the values in use — the surest sign of",
  "what a feature means — and the note already written, if any. Write a note for every feature",
  "that lacks one: one line, under 120 characters, no full stop, in the style of the notes",
  "already written. Do not add, rename or remove features, and do not rewrite a note that is",
  "there.",
].join(" ")

/** The text beside the system prompt: the board's name and the features,
 * one a line, and the ask. */
export function notesPrompt(request: NotesRequest): string {
  const lines = request.features.map((feature) => {
    const kind = feature.multi ? "several values" : "one value"
    const values = feature.values.length ? feature.values.join(", ") : "none yet"
    const notes = feature.notes !== "" ? feature.notes : "none"
    return `- ${feature.label} (${feature.type}, ${kind}): Values in use: ${values}. Notes: ${notes}`
  })
  const missing = request.features.filter((feature) => feature.notes === "")
  return [
    `Board: ${request.board.trim() || "Untitled"}`,
    "Features:",
    ...lines,
    missing.length
      ? `Write notes for: ${missing.map((feature) => feature.label).join(", ")}.`
      : "Every feature has notes already: answer with an empty list.",
  ].join("\n")
}

/** The same text for Workers AI, with the JSON asked for in so many words. */
export function cloudflareNotesPrompt(request: NotesRequest): string {
  return [
    notesPrompt(request),
    "",
    "Answer with JSON only, no prose and no code fence, of exactly this shape:",
    '{"notes": [{"label": "the feature\'s label as given", "notes": "one line under 120 characters"}]}',
    "One entry per feature that lacks notes, in the order given.",
  ].join("\n")
}

/** The JSON schema the model's answer is held to (structured output). */
export function notesOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      notes: {
        type: "array",
        description: "One entry per feature that lacks notes, in the order given.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "The feature's label, exactly as given." },
            notes: {
              type: "string",
              description:
                "One line, under 120 characters, with no full stop, telling a vision model what the feature means and how to answer it, in the style of the notes already written.",
            },
          },
          required: ["label", "notes"],
          additionalProperties: false,
        },
      },
    },
    required: ["notes"],
    additionalProperties: false,
  }
}

/**
 * The model's answer read into a suggestion against the features that
 * lack notes: an entry is matched to a feature by its label (trimmed,
 * whatever its case), or — when the answer has one entry per such feature
 * in order under other labels — by its position; the notes are trimmed and
 * cut to length, and an entry with nothing in it, or for a feature not
 * asked about, is dropped. Each feature gets at most one. Null when the
 * answer is not shaped as asked.
 */
export function readNotesSuggestion(raw: unknown, request: NotesRequest): NotesSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.notes)) return null
  const missing = request.features.filter((feature) => feature.notes === "")
  const byLabel = new Map(missing.map((feature) => [normalise(feature.label), feature.label]))
  const entries: ({ label: string; notes: string } | null)[] = []
  for (const entry of record.notes) {
    if (typeof entry !== "object" || entry === null) {
      entries.push(null)
      continue
    }
    const item = entry as Record<string, unknown>
    if (typeof item.label !== "string" || typeof item.notes !== "string") {
      entries.push(null)
      continue
    }
    entries.push({ label: item.label, notes: item.notes.trim().slice(0, MAX_NOTES_LENGTH) })
  }
  // Only when the answer is the missing features, in order, under other names.
  const byPosition =
    entries.length === missing.length &&
    entries.every((entry) => entry !== null && !byLabel.has(normalise(entry.label)))
  const given = new Set<string>()
  const notes: { label: string; notes: string }[] = []
  entries.forEach((entry, index) => {
    if (!entry || entry.notes === "") return
    const label = byLabel.get(normalise(entry.label)) ?? (byPosition ? missing[index].label : null)
    if (label === null || given.has(label)) return
    given.add(label)
    notes.push({ label, notes: entry.notes })
  })
  return { notes }
}
