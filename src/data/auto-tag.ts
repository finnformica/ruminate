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
 * Worker reading them from D1: the graph in the browser is the one that
 * knows what the board looks like now (a value picked a moment ago may not
 * have reached the replica yet), and the Worker trusts nothing
 * in the body beyond the prompt's text — the image is read from the
 * caller's own prefix in R2, and the answer is applied by the client
 * through the board's ordinary writes.
 */

/**
 * Who answers: `anthropic` — the Messages API with the user's own key — or
 * `cloudflare` — Workers AI, free within Cloudflare's daily allowance,
 * behind the `cloudflareAi` flag. One router picks, in one fixed order
 * (src/data/ai-router.ts); the Worker resolves it from its own truth, and
 * the client only shows the same answer.
 */
export type AiProvider = "anthropic" | "cloudflare"

/** The model the Worker asks of Anthropic. A Haiku-class model: fast,
 * cheap, and enough for a caption and a few labels. */
export const AUTO_TAG_MODEL = "claude-haiku-4-5"

/** The model the Worker asks of Workers AI: an open vision model that reads
 * a picture and chat-completion messages. */
export const CLOUDFLARE_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it"

/** Calls one account may make in a UTC day — a fuse on the user's own bill
 * (the key is theirs), not a quota. */
export const AUTO_TAG_DAILY_LIMIT = 300

/** The most the picture's bytes may weigh: the API takes five megabytes of
 * base64, which is three and three-quarter of raw bytes. A sanity limit —
 * the client sends a copy fitted for the model (`visionCopy`,
 * src/data/image-fit.ts), which is far below it. */
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
 * a picture may carry several of its values, its notes, the values in
 * use, and whether it is a place — the feature the location hint is for,
 * when the picture carries where it was taken. */
export interface TagFeature {
  label: string
  multi: boolean
  values: string[]
  /** Notes on what the feature is, for the prompt — "what that thing is
   * made of". */
  notes?: string
  /** A place feature: where the picture was taken is offered to it. */
  place?: boolean
}

/** Where a picture was taken: WGS84, as its block's `lat`/`lon` props. */
export interface TagLocation {
  lat: number
  lon: number
}

/** What `POST /api/boards/tag` takes beside the picture: the board's
 * features and, when the picture's block carries one, where it was taken
 * — as the `features` field of the form, a JSON string of this. */
export interface TagRequest {
  features: TagFeature[]
  location?: TagLocation
}

/** A location a value states, or undefined: two finite numbers on the
 * globe. Anything else is no location, never a refusal. */
export function readTagLocation(raw: unknown): TagLocation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { lat, lon } = raw as { lat?: unknown; lon?: unknown }
  if (typeof lat !== "number" || typeof lon !== "number") return undefined
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  return { lat, lon }
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
  /** Who answered, as the router chose, and with which model. */
  provider: AiProvider
  model: string
  /** The AI Gateway log the call was written to, on the Cloudflare path. */
  log?: string
}

// Limits on what is sent and what is read back, so a board cannot stuff
// the prompt and an answer cannot stuff the graph.
const MAX_FEATURES = 12
const MAX_VALUES_PER_FEATURE = 200
const MAX_LABEL_LENGTH = 60
const MAX_NOTES_LENGTH = 500
const MAX_VALUE_LENGTH = 60
const MAX_CAPTION_LENGTH = 120
/** How many values the model may give one feature at once. */
const MAX_SUGGESTED_VALUES = 5

const normalise = (text: string) => text.trim().toLocaleLowerCase()

/**
 * The request a value states, or null when it is not one: up to a dozen
 * features, each a label, a `multi` flag and a list of values, every
 * string trimmed and cut to length.
 */
export function readTagRequest(raw: unknown): TagRequest | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.features)) return null
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
    const notes =
      typeof feature.notes === "string" ? feature.notes.trim().slice(0, MAX_NOTES_LENGTH) : ""
    const values: string[] = []
    for (const value of feature.values) {
      if (typeof value !== "string") return null
      const text = value.trim().slice(0, MAX_VALUE_LENGTH)
      if (text !== "") values.push(text)
    }
    features.push({
      label,
      multi: feature.multi,
      values,
      ...(notes ? { notes } : {}),
      ...(feature.place === true ? { place: true } : {}),
    })
  }
  const location = readTagLocation(record.location)
  return location ? { features, location } : { features }
}

/** What the prompt says of where the picture was taken: a place name,
 * found for the coordinates, or the coordinates themselves. */
export interface LocationHint {
  location: TagLocation
  place: string | null
}

/** The labels of the features a location is for: the board's place
 * features. None, and the prompt says nothing of where the picture was
 * taken, whatever the request carried. */
export const placeLabels = (features: readonly TagFeature[]): string[] =>
  features.filter((feature) => feature.place === true).map((feature) => feature.label)

/** The line the prompt carries for a location, naming the place feature
 * (or features) it is for. */
function locationLine(hint: LocationHint, labels: readonly string[]): string {
  const named = labels.join(" and ")
  if (hint.place) {
    return `The picture was taken at: ${hint.place} (most specific first). For ${named}, use a value in use that covers the place; otherwise name it as a person would in conversation — the country by default, or the everyday short name of a notable specific place such as an airport, a landmark or a city.`
  }
  return `The picture was taken at latitude ${hint.location.lat}, longitude ${hint.location.lon}: name the town or area for ${named}.`
}

/** What the model is, and how it is to answer. Fixed text, so it caches. */
export const AUTO_TAG_SYSTEM_PROMPT = [
  "You tag pictures on a mood board — inspiration kept for a home, a garden, a project.",
  "For each picture you are told the board's features and the values already in use.",
  "Answer with a caption of a few words (no full stop) saying what the picture shows,",
  "and, for every feature the picture clearly shows something for, a value: one already",
  "in use when it fits, spelled exactly as given; otherwise a new one of one to three",
  "words, in the style of the values in use (the same case, singular or plural as they",
  "are). Give a feature no value only when the picture shows nothing for it. A feature",
  "that takes one value takes at most one.",
].join(" ")

/** The text beside the picture: the features and their values, one a
 * line, and where the picture was taken, when that is known and the board
 * has a place feature to offer it to. */
export function tagPrompt(features: readonly TagFeature[], hint?: LocationHint): string {
  const labels = placeLabels(features)
  const where = hint && labels.length > 0 ? [locationLine(hint, labels)] : []
  if (features.length === 0) {
    return ["There are no features on this board: answer with a caption.", ...where].join("\n")
  }
  const lines = features.map((feature) => {
    const kind = feature.multi ? "several values" : "one value"
    const values = feature.values.length ? feature.values.join(", ") : "none yet"
    const notes = feature.notes ? `${feature.notes}. ` : ""
    return `- ${feature.label} (${kind}): ${notes}Values in use: ${values}`
  })
  return ["Features:", ...lines, ...where].join("\n")
}

/**
 * The text beside the picture for Workers AI: the same features, then the
 * JSON asked for in so many words — JSON mode is not something every model
 * there honours, so the prompt asks and `extractJson` reads leniently.
 */
export function cloudflareTagPrompt(features: readonly TagFeature[], hint?: LocationHint): string {
  return [
    tagPrompt(features, hint),
    "",
    "Answer with JSON only, no prose and no code fence, of exactly this shape:",
    '{"caption": "a few words", "features": [{"label": "the feature\'s label as given", "values": ["a value"]}]}',
    "One entry per feature, in the order given; an empty values list when none applies.",
  ].join("\n")
}

/**
 * The first JSON object in a model's answer, read leniently: a code fence
 * around it, or words before or after it, are stripped; what is between
 * the first `{` and the last `}` is parsed. Null when there is none, or it
 * does not parse.
 */
export function extractJson(text: string): unknown {
  const unfenced = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "")
  const start = unfenced.indexOf("{")
  const end = unfenced.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    return null
  }
}

/** The JSON schema the model's answer is held to (structured output). */
export function tagOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      caption: {
        type: "string",
        description: "A few words saying what the picture shows, with no full stop.",
      },
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
                "The values the picture clearly shows for this feature: one already in use, spelled exactly as given, or a new one of one to three words and at most 30 characters, in the style of the values in use (the same case, singular or plural as they are). Empty only when the picture shows nothing for the feature.",
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

/** The most a NEW value may be: it becomes a menu option. A value in use
 * is never shortened (`MAX_VALUE_LENGTH` is for the request). */
export const MAX_SUGGESTED_VALUE_LENGTH = 30

/** The first code point upper-cased, the rest as it was. */
const capitalised = (text: string): string => {
  const [first = "", ...rest] = Array.from(text)
  return first.toLocaleUpperCase() + rest.join("")
}

/** The first code point lower-cased, the rest as it was. */
const lowered = (text: string): string => {
  const [first = "", ...rest] = Array.from(text)
  return first.toLocaleLowerCase() + rest.join("")
}

const startsUpper = (text: string): boolean => {
  const first = Array.from(text)[0] ?? ""
  return first !== first.toLocaleLowerCase()
}
const startsLower = (text: string): boolean => {
  const first = Array.from(text)[0] ?? ""
  return first !== first.toLocaleUpperCase()
}

/**
 * A new value in the style of the values in use: when every one starts
 * with an upper-case letter, its first letter upper-cased; when every one
 * starts lower-case, lower-cased; mixed, or none in use, upper-cased.
 */
export function styledValue(text: string, inUse: readonly string[]): string {
  const letters = inUse.filter((value) => startsUpper(value) || startsLower(value))
  if (letters.length > 0 && letters.every(startsLower)) return lowered(text)
  return capitalised(text)
}

/**
 * The model's answer read into a suggestion against the features that were
 * asked about: a feature it did not mention gets no values, one it named
 * twice is read once, a value is given once whatever its case, and a
 * single-value feature keeps only the first. The caption's first letter is
 * upper-cased. A value that matches one in use (trimmed, whatever its
 * case) is returned spelled exactly as the value in use, so the board's
 * own value is linked rather than a near-duplicate made; a new value is
 * trimmed, cut to `MAX_SUGGESTED_VALUE_LENGTH` and given the style of the
 * values in use (`styledValue`). An entry whose label names no feature
 * asked about is read for the feature at its own position, when the
 * answer has one entry per feature in order ("Objects" for Object) — a
 * label that matches always wins. Null when the answer is not shaped as
 * asked.
 */
export function readTagSuggestion(
  raw: unknown,
  features: readonly TagFeature[],
): TagSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.caption !== "string" || !Array.isArray(record.features)) return null
  const caption = capitalised(record.caption.trim().slice(0, MAX_CAPTION_LENGTH))
  const asked = new Set(features.map((feature) => normalise(feature.label)))
  const answered = new Map<string, string[]>()
  // Each entry as it came, in order, for the positional reading.
  const entries: ({ label: string; values: string[] } | null)[] = []
  for (const entry of record.features) {
    if (typeof entry !== "object" || entry === null) {
      entries.push(null)
      continue
    }
    const item = entry as Record<string, unknown>
    if (typeof item.label !== "string" || !Array.isArray(item.values)) {
      entries.push(null)
      continue
    }
    const values: string[] = []
    for (const value of item.values) {
      if (typeof value === "string" && value.trim() !== "") values.push(value.trim())
    }
    const label = normalise(item.label)
    entries.push({ label, values })
    if (!answered.has(label)) answered.set(label, values)
  }
  // Only when the answer is the features, in order, under other names.
  const byPosition = entries.length === features.length
  return {
    caption,
    features: features.map((feature, index) => {
      const inUse = new Map(feature.values.map((value) => [normalise(value), value.trim()]))
      const seen = new Set<string>()
      const values: string[] = []
      const named = answered.get(normalise(feature.label))
      const atIndex = entries[index]
      const givens =
        named ?? (byPosition && atIndex && !asked.has(atIndex.label) ? atIndex.values : [])
      for (const given of givens) {
        const existing = inUse.get(normalise(given))
        const text =
          existing ?? styledValue(given.slice(0, MAX_SUGGESTED_VALUE_LENGTH).trim(), feature.values)
        if (text === "" || seen.has(normalise(text))) continue
        seen.add(normalise(text))
        values.push(text)
        if (values.length === MAX_SUGGESTED_VALUES) break
      }
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
