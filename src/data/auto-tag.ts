/**
 * Tagging a board's pictures with Claude (docs/boards.md, "Tagging with
 * Claude") — the half shared by the Worker, which asks the model
 * (worker/handlers/board-tag.ts), and the client, which sends the board's
 * features and applies the answer (src/hooks/board.ts).
 *
 * A PROOF OF CONCEPT, open to every signed-in user. The shapes here are the
 * request the client sends, the prompt the Worker builds from it, the JSON
 * schema the model is held to, and the reading of its answer back into a
 * suggestion — pure, with no platform types, so both sides and the tests
 * run the same code.
 *
 * The client sends the board's features and their values rather than the
 * Worker reading them from D1: a picture is tagged right after its upload
 * lands, before the replica has the row, so the graph in the browser is the
 * one that knows what the board looks like now. The Worker trusts nothing
 * in the body beyond the prompt's text — the image is read from the
 * caller's own prefix in R2, and the answer is applied by the client
 * through the board's ordinary writes.
 */

/** The model the Worker asks. A Haiku-class model: fast, cheap, and enough
 * for a caption and a few labels. */
export const AUTO_TAG_MODEL = "claude-haiku-4-5"

/** Calls one account may make in a UTC day — a fuse on the user's own bill
 * (the key is theirs), not a quota. */
export const AUTO_TAG_DAILY_LIMIT = 300

/** The most the picture's bytes may weigh: the API takes five megabytes of
 * base64, which is three and three-quarter of raw bytes. */
export const AUTO_TAG_MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4)

/** The picture formats the API reads. AVIF, which the editor accepts, is
 * not among them. */
export const AUTO_TAG_IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

/** A feature as the client describes it to the Worker: its label, whether
 * a picture may carry several of its values, and the values in use. */
export interface TagFeature {
  label: string
  multi: boolean
  values: string[]
}

/** `POST /api/boards/tag` takes this. */
export interface TagRequest {
  /** The asset's id (`img_…`), the key the bytes are under in R2. */
  imageId: string
  features: TagFeature[]
}

/** What the model answers, read back into shape: a caption and, per
 * feature in the request's order, the values that fit — existing or new. */
export interface TagSuggestion {
  caption: string
  features: { label: string; values: string[] }[]
}

/** `POST /api/boards/tag` answers this. */
export interface TagResponse {
  suggestion: TagSuggestion
}

// Limits on what is sent and what is read back, so a board cannot stuff
// the prompt and an answer cannot stuff the graph.
const MAX_FEATURES = 12
const MAX_VALUES_PER_FEATURE = 200
const MAX_LABEL_LENGTH = 60
const MAX_VALUE_LENGTH = 60
const MAX_CAPTION_LENGTH = 120
/** How many values the model may give one feature at once. */
const MAX_SUGGESTED_VALUES = 5

const normalise = (text: string) => text.trim().toLocaleLowerCase()

/**
 * The request a body states, or null when it is not one: an asset id and
 * up to a dozen features, each a label, a `multi` flag and a list of
 * values, every string trimmed and cut to length.
 */
export function readTagRequest(raw: unknown): TagRequest | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.imageId !== "string" || !Array.isArray(record.features)) return null
  if (record.features.length > MAX_FEATURES) return null
  const features: TagFeature[] = []
  for (const entry of record.features) {
    if (typeof entry !== "object" || entry === null) return null
    const feature = entry as Record<string, unknown>
    if (typeof feature.label !== "string" || typeof feature.multi !== "boolean") return null
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
    features.push({ label, multi: feature.multi, values })
  }
  return { imageId: record.imageId, features }
}

/** What the model is, and how it is to answer. Fixed text, so it caches. */
export const AUTO_TAG_SYSTEM_PROMPT = [
  "You tag pictures on a mood board — inspiration kept for a home, a garden, a project.",
  "For each picture you are told the board's features and the values already in use.",
  "Answer with a caption of a few words (no full stop) saying what the picture shows,",
  "and, for each feature, the values that fit it. Prefer a value already in use, spelled",
  "exactly as given. Add a new value only when none in use fits, and keep it to a word",
  "or two. Give a feature no values when it does not apply. A feature that takes one",
  "value takes at most one.",
].join(" ")

/** The text beside the picture: the features and their values, one a line. */
export function tagPrompt(features: readonly TagFeature[]): string {
  if (features.length === 0) return "There are no features on this board: answer with a caption."
  const lines = features.map((feature) => {
    const kind = feature.multi ? "several values" : "one value"
    const values = feature.values.length ? feature.values.join(", ") : "none yet"
    return `- ${feature.label} (${kind}): ${values}`
  })
  return ["Features:", ...lines].join("\n")
}

/** The JSON schema the model's answer is held to (structured output). */
export function tagOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      caption: { type: "string", description: "A few words saying what the picture shows." },
      features: {
        type: "array",
        description: "One entry per feature, in the order given.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "The feature's label, exactly as given." },
            values: {
              type: "array",
              items: { type: "string" },
              description:
                "The values that fit the picture: existing ones spelled as given, or a new short one. Empty when none applies.",
            },
          },
          required: ["label", "values"],
          additionalProperties: false,
        },
      },
    },
    required: ["caption", "features"],
    additionalProperties: false,
  }
}

/**
 * The model's answer read into a suggestion against the features that were
 * asked about: a feature it did not mention gets no values, one it named
 * twice is read once, a value is trimmed, cut to length and given once
 * whatever its case, and a single-value feature keeps only the first.
 * Null when the answer is not shaped as asked.
 */
export function readTagSuggestion(
  raw: unknown,
  features: readonly TagFeature[],
): TagSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.caption !== "string" || !Array.isArray(record.features)) return null
  const caption = record.caption.trim().slice(0, MAX_CAPTION_LENGTH)
  const answered = new Map<string, string[]>()
  for (const entry of record.features) {
    if (typeof entry !== "object" || entry === null) continue
    const item = entry as Record<string, unknown>
    if (typeof item.label !== "string" || !Array.isArray(item.values)) continue
    const key = normalise(item.label)
    if (answered.has(key)) continue
    const seen = new Set<string>()
    const values: string[] = []
    for (const value of item.values) {
      if (typeof value !== "string") continue
      const text = value.trim().slice(0, MAX_VALUE_LENGTH)
      if (text === "" || seen.has(normalise(text))) continue
      seen.add(normalise(text))
      values.push(text)
      if (values.length === MAX_SUGGESTED_VALUES) break
    }
    answered.set(key, values)
  }
  return {
    caption,
    features: features.map((feature) => {
      const values = answered.get(normalise(feature.label)) ?? []
      return { label: feature.label, values: feature.multi ? values : values.slice(0, 1) }
    }),
  }
}

/** The shape of an Anthropic API key, as far as the Worker checks before
 * keeping one: the `sk-ant-` prefix and a plausible length. The API is
 * what says whether it works. */
export const isAnthropicKeyShaped = (key: string): boolean =>
  /^sk-ant-[A-Za-z0-9_-]{20,250}$/.test(key)

/** The characters the settings card shows of a kept key. */
export const keyLast4 = (key: string): string => key.slice(-4)

/** What `GET /api/anthropic-key` answers: whether a key is kept, and its
 * last characters. Never the key. */
export interface AnthropicKeyBody {
  set: boolean
  last4: string | null
}
