// `POST /api/boards/tag` — a caption and tags for a picture, from a vision
// model (docs/boards.md, "Tagging with Claude"). A PROOF OF CONCEPT, open to
// every signed-in user with a provider set up.
//
// ONE path, whoever answers (worker/ai.ts). The request is a form: `image`,
// the picture's bytes — a copy the client fitted for the model
// (`visionCopy`, src/data/image-fit.ts), a few hundred kilobytes, never the
// stored original — and `features`, the board's features with their values
// in use as a JSON string (`TagRequest`, src/data/auto-tag.ts). Nothing
// about who is asked: the shared module resolves the provider from the
// Worker's own truth. Then the picture is checked (a format the models
// read, under the API's size limit — a sanity limit, the fitted copy being
// far below it), the day's call counted (worker/ai-usage.ts, the same count
// for every route that asks a model), and the model asked; one step after
// reads the text leniently (`extractJson`) into a `TagSuggestion`
// (`readTagSuggestion`: trimmed, de-duplicated, capped, one value for a
// single-value feature) and returns it. The client applies it through the
// board's ordinary writes; this route writes nothing, and reads nothing of
// the caller's but the session.
//
// Refusals, each a code the client puts into words:
//   400 invalid_body         not a form with a picture and features
//   412 no_provider          nothing set up — Settings → AI
//   501 ai_disabled          Cloudflare chosen, but no binding
//   429 daily_limit          the account's calls for today are spent
//   429 rate_limited         the API said to slow down (its Retry-After passed on)
//   413 image_too_large      past the API's five megabytes of base64
//   415 unsupported_image    a format the API does not read (AVIF)
//   422 invalid_api_key      Anthropic refused the key
//   422 refused              the model declined
//   422 bad_answer           the answer is not a suggestion (the answer is in `detail`)
//   502 provider_error       the provider failed (its words are in `message`)
//
// A refusal carries what the call can be found by — the provider, its
// model, and on the Cloudflare path the AI Gateway log id — and, for the
// two above, what the provider actually said, so the person can copy it
// from the toast.

import {
  AUTO_TAG_IMAGE_TYPES,
  AUTO_TAG_MAX_IMAGE_BYTES,
  AUTO_TAG_SYSTEM_PROMPT,
  cloudflareTagPrompt,
  extractJson,
  placeLabels,
  readTagRequest,
  readTagSuggestion,
  tagOutputSchema,
  tagPrompt,
  type LocationHint,
  type TagFeature,
  type TagLocation,
  type TagResponse,
} from "../../src/data/auto-tag"
import {
  badAnswerResponse,
  dailyLimitResponse,
  failureResponse,
  json,
  resolveAsker,
  type ImageMediaType,
} from "../ai"
import { spendAiCall } from "../ai-usage"
import { reverseGeocode } from "../geocode"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const BOARD_TAG_PATH = "/api/boards/tag"

/** The picture and the request out of the form, or null when it is not
 * one. A file part has bytes and a type; a string part has neither. The
 * `features` field is the request's JSON — an object with `features` and
 * perhaps `location`, or, as it first was, the features array alone. */
async function readForm(
  request: Request,
): Promise<{ image: Blob; features: TagFeature[]; location?: TagLocation } | null> {
  const form = await request.formData().catch(() => null)
  if (!form) return null
  const image = form.get("image")
  const features = form.get("features")
  if (typeof image !== "object" || image === null || typeof features !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(features)
  } catch {
    return null
  }
  const body = readTagRequest(Array.isArray(parsed) ? { features: parsed } : parsed)
  if (body === null) return null
  return { image, ...body }
}

export async function boardTag(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  options: { clock?: () => number; dailyLimit?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405)
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const form = await readForm(request)
  if (form === null) return json({ error: "invalid_body" }, 400)

  // Who answers, before a byte is read or a call counted.
  const asker = await resolveAsker(env, session, fetchImpl)
  if (asker instanceof Response) return asker

  // The picture, before the call is counted: one the models cannot read
  // costs the day nothing.
  const mediaType = (form.image.type ?? "").split(";")[0].trim().toLowerCase()
  if (!AUTO_TAG_IMAGE_TYPES.includes(mediaType)) return json({ error: "unsupported_image" }, 415)
  if (form.image.size > AUTO_TAG_MAX_IMAGE_BYTES) return json({ error: "image_too_large" }, 413)
  const bytes = await form.image.arrayBuffer()
  if (bytes.byteLength === 0) return json({ error: "invalid_body" }, 400)
  if (bytes.byteLength > AUTO_TAG_MAX_IMAGE_BYTES) return json({ error: "image_too_large" }, 413)

  const now = options.clock?.() ?? Date.now()
  const spend = await spendAiCall(controlPlaneDriver(env), session.id, now, options.dailyLimit)
  if (!spend.ok) return dailyLimitResponse("Tagging has made its calls for today.")

  let text: string
  try {
    // Where the picture was taken, as a place name when Nominatim has one
    // for it — asked once, after the day's call is counted (a refused call
    // asks nothing), only when the board has a place feature to offer it
    // to, and inside this try: a failed lookup is a hint without a name,
    // never a failed tag.
    const hint: LocationHint | undefined =
      form.location && placeLabels(form.features).length > 0
        ? { location: form.location, place: await reverseGeocode(fetchImpl, form.location) }
        : undefined
    text = await asker.ask({
      system: AUTO_TAG_SYSTEM_PROMPT,
      prompt: tagPrompt(form.features, hint),
      cloudflarePrompt: cloudflareTagPrompt(form.features, hint),
      schema: tagOutputSchema(),
      schemaName: "tag_suggestion",
      image: { bytes, mimeType: mediaType as ImageMediaType },
    })
  } catch (error) {
    return failureResponse(error, asker.found())
  }

  const suggestion = readTagSuggestion(extractJson(text), form.features)
  if (suggestion === null) return badAnswerResponse(text, asker.found())
  // The answer as it came goes back with what was read from it, so the
  // success toast's Copy shows both.
  const response: TagResponse = { suggestion, ...asker.found() }
  return json(response)
}
