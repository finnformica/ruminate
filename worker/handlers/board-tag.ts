// `POST /api/boards/tag` — a caption and tags for a picture, from a vision
// model (docs/boards.md, "Tagging with Claude"). A PROOF OF CONCEPT, open to
// every signed-in user with a provider set up.
//
// ONE path, whoever answers. The request is a form: `image`, the picture's
// bytes — a copy the client fitted for the model (`visionCopy`,
// src/data/image-fit.ts), a few hundred kilobytes, never the stored
// original — and `features`, the board's features with their values in use
// as a JSON string (`TagRequest`, src/data/auto-tag.ts). Nothing about who
// is asked: the handler resolves the provider itself, by the one router
// (src/data/ai-router.ts) over its own truth — the key row, the flag's
// audience, the stored preference — Anthropic if a key is kept, else
// Cloudflare if the `cloudflareAi` flag allows the caller and they opted
// in, else nothing. Then the picture is checked (a format the models read,
// under the API's size limit — a sanity limit, the fitted copy being far
// below it), the day's call counted (worker/ai-usage.ts, the same count for
// both), and the provider asked through one interface, `TagProvider`: a
// picture and the features in, the model's answer out as text. The
// providers differ in nothing else; one step after reads the text leniently
// (`extractJson`) into a `TagSuggestion` (`readTagSuggestion`: trimmed,
// de-duplicated, capped, one value for a single-value feature) and returns
// it. The client applies it through the board's ordinary writes; this
// route writes nothing, and reads nothing of the caller's but the session.
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
// from the toast. The key is in one place in this file — the Anthropic
// client's constructor — and in no log line, no error detail and no
// response: the SDK's error messages are the API's answers, which never
// carry it.

import Anthropic from "@anthropic-ai/sdk"
import { resolveAiProvider } from "../../src/data/ai-router"
import {
  AUTO_TAG_IMAGE_TYPES,
  AUTO_TAG_MAX_IMAGE_BYTES,
  AUTO_TAG_MODEL,
  AUTO_TAG_SYSTEM_PROMPT,
  CLOUDFLARE_AI_MODEL,
  cloudflareTagPrompt,
  extractJson,
  readTagRequest,
  readTagSuggestion,
  tagOutputSchema,
  tagPrompt,
  type AiProvider,
  type LocationHint,
  type TagFeature,
  type TagLocation,
  type TagResponse,
} from "../../src/data/auto-tag"
import { spendAiCall } from "../ai-usage"
import { featureAllows } from "../features"
import { reverseGeocode } from "../geocode"
import { controlPlaneDriver, corpusDriver, forTenant } from "../tenancy-db"
import type { Env } from "../types"
import { readKey } from "./anthropic-key"
import { storedPreferences } from "./preferences"
import { requireSession } from "./replica"

export const BOARD_TAG_PATH = "/api/boards/tag"

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

/** Bytes to base64, in chunks a call stack can take. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  const chunk = 0x8000
  let binary = ""
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk))
  }
  return btoa(binary)
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

/** What every provider is given. */
interface TagInput {
  image: { bytes: ArrayBuffer; mimeType: ImageMediaType }
  features: TagFeature[]
  /** Where the picture was taken, when its block says, with the place name
   * found for it (worker/geocode.ts) or without one. */
  hint?: LocationHint
}

/**
 * A provider: shown the picture and the features, answers with the model's
 * text — JSON, if the model did as asked; the shared step after decides.
 * A refusal it must pass on (a bad key, a rate limit, a decline) is a
 * `ProviderRefusal`; anything else it throws is a `provider_error`.
 */
interface TagProvider {
  suggest(input: TagInput): Promise<string>
}

class ProviderRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(code)
  }
}

/** The Messages API with the caller's own key: a fixed system prompt and
 * a JSON schema the answer is held to. */
function anthropicProvider(apiKey: string, fetchImpl: typeof fetch): TagProvider {
  const client = new Anthropic({ apiKey, fetch: fetchImpl, maxRetries: 0 })
  return {
    async suggest({ image, features, hint }) {
      let answer: Anthropic.Message
      try {
        answer = await client.messages.create({
          model: AUTO_TAG_MODEL,
          max_tokens: 1024,
          system: AUTO_TAG_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mimeType,
                    data: toBase64(image.bytes),
                  },
                },
                { type: "text", text: tagPrompt(features, hint) },
              ],
            },
          ],
          output_config: { format: { type: "json_schema", schema: tagOutputSchema() } },
        })
      } catch (error) {
        // The codes alone: an SDK error's message is the API's, and the
        // API's words are not for the person who pasted the key.
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError
        ) {
          throw new ProviderRefusal(
            422,
            "invalid_api_key",
            "Anthropic refused the API key kept for you.",
          )
        }
        if (error instanceof Anthropic.RateLimitError) {
          const retryAfter = error.headers?.get("retry-after")
          throw new ProviderRefusal(
            429,
            "rate_limited",
            "Anthropic asked to slow down.",
            retryAfter ? { "Retry-After": retryAfter } : {},
          )
        }
        throw error
      }
      if (answer.stop_reason === "refusal") throw new ProviderRefusal(422, "refused")
      return answer.content.find((block) => block.type === "text")?.text ?? ""
    },
  }
}

/** Just enough of the binding's shape to call it: the model names and
 * input types in workers-types are a moving target, and this is one call.
 * `aiGatewayLogId` is what the binding sets after a call made through AI
 * Gateway — the id the call is logged under. */
interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { gateway?: { id: string } },
  ): Promise<unknown>
  aiGatewayLogId?: string
}

/** The AI Gateway the Cloudflare calls go through: `default` is made on
 * first use, and from then on every call — prompt, answer, latency, tokens
 * — is logged under AI → AI Gateway in the dashboard. */
const AI_GATEWAY_ID = "default"

/** The log id the binding holds after a call, if any. */
const gatewayLogOf = (ai: unknown): string | undefined => {
  const id = (ai as AiBinding | undefined)?.aiGatewayLogId
  return typeof id === "string" ? id : undefined
}

/**
 * The text of a Workers AI answer, wherever the model put it. The shapes
 * seen: `response` as a string; `response` as an OBJECT — JSON mode
 * (`response_format`) hands the answer back already parsed, so it is
 * written out again for the one reading step; `choices[0].message.content`
 * as a string, or as parts, whose `text` parts are joined; and
 * `choices[0].message.parsed`, an object. Anything else is nothing.
 */
function completionText(result: unknown): string {
  if (typeof result !== "object" || result === null) return ""
  const record = result as { choices?: unknown; response?: unknown }
  if (typeof record.response === "string") return record.response
  if (typeof record.response === "object" && record.response !== null) {
    return JSON.stringify(record.response)
  }
  if (!Array.isArray(record.choices)) return ""
  const message = (record.choices[0] as { message?: { content?: unknown; parsed?: unknown } })
    ?.message
  if (typeof message?.content === "string") return message.content
  if (Array.isArray(message?.content)) {
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("")
  }
  if (typeof message?.parsed === "object" && message.parsed !== null) {
    return JSON.stringify(message.parsed)
  }
  return ""
}

/**
 * Workers AI: the picture as a data URL in a chat-completion message, the
 * JSON asked for in the prompt. `response_format` is tried first — the
 * model's input schema lists it — and the call made again without it if
 * that is refused, since JSON mode is honoured by some models there and
 * not others. Reasoning is switched off (`chat_template_kwargs`): on by
 * default for this model, it makes the answer slow and can spend the
 * output on thought before any JSON. The output cap is given under both
 * names the docs use. Every call goes through AI Gateway, for its logs.
 */
function cloudflareProvider(ai: AiBinding): TagProvider {
  return {
    async suggest({ image, features, hint }) {
      const input = {
        messages: [
          { role: "system", content: AUTO_TAG_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${toBase64(image.bytes)}` },
              },
              { type: "text", text: cloudflareTagPrompt(features, hint) },
            ],
          },
        ],
        chat_template_kwargs: { enable_thinking: false },
        max_completion_tokens: 400,
        max_tokens: 400,
        temperature: 0.2,
      }
      const options = { gateway: { id: AI_GATEWAY_ID } }
      let result: unknown
      try {
        result = await ai.run(
          CLOUDFLARE_AI_MODEL,
          {
            ...input,
            response_format: {
              type: "json_schema",
              json_schema: { name: "tag_suggestion", schema: tagOutputSchema() },
            },
          },
          options,
        )
      } catch {
        result = await ai.run(CLOUDFLARE_AI_MODEL, input, options)
      }
      return completionText(result)
    },
  }
}

/** The handler's own truth, resolved by the one router. */
async function chooseProvider(
  env: Env,
  session: { id: number; login: string; name: string | null },
): Promise<AiProvider | null> {
  const control = controlPlaneDriver(env)
  const hasKey = (await readKey(control, session.id)) !== null
  // The rest is asked only when it could matter: a key kept settles it.
  if (hasKey) return resolveAiProvider({ hasKey, cloudflareAllowed: false, cloudflareOptIn: false })
  const [cloudflareAllowed, preferences] = await Promise.all([
    featureAllows(control, env, "cloudflareAi", session.id),
    storedPreferences(forTenant(corpusDriver(env), session)),
  ])
  return resolveAiProvider({
    hasKey,
    cloudflareAllowed,
    cloudflareOptIn: preferences.useCloudflareAi,
  })
}

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
  const chosen = await chooseProvider(env, session)
  if (chosen === null) {
    return json(
      { error: "no_provider", detail: "Add your Anthropic API key under Settings → AI." },
      412,
    )
  }
  if (chosen === "cloudflare" && !env.AI) return json({ error: "ai_disabled" }, 501)

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
  if (!spend.ok) {
    return json({ error: "daily_limit", detail: "Tagging has made its calls for today." }, 429, {
      "Retry-After": "3600",
    })
  }

  const provider: TagProvider =
    chosen === "anthropic"
      ? anthropicProvider((await readKey(controlPlaneDriver(env), session.id)) ?? "", fetchImpl)
      : cloudflareProvider(env.AI as unknown as AiBinding)
  // What a failing call can be found by: the provider, its model, and —
  // on the Cloudflare path — the AI Gateway log the call was written to.
  const model = chosen === "anthropic" ? AUTO_TAG_MODEL : CLOUDFLARE_AI_MODEL
  const logOf = () => (chosen === "cloudflare" ? gatewayLogOf(env.AI) : undefined)
  const found = () => ({ provider: chosen, model, ...(logOf() ? { log: logOf() } : {}) })

  let text: string
  try {
    // Where the picture was taken, as a place name when Nominatim has one
    // for it — asked once, after the day's call is counted (a refused call
    // asks nothing), and inside this try: a failed lookup is a hint
    // without a name, never a failed tag.
    const hint: LocationHint | undefined = form.location
      ? { location: form.location, place: await reverseGeocode(fetchImpl, form.location) }
      : undefined
    text = await provider.suggest({
      image: { bytes, mimeType: mediaType as ImageMediaType },
      features: form.features,
      hint,
    })
  } catch (error) {
    if (error instanceof ProviderRefusal) {
      return json(
        { error: error.code, ...(error.detail ? { detail: error.detail } : {}), ...found() },
        error.status,
        error.headers,
      )
    }
    // The provider's own words, for the person debugging: an SDK error's
    // message is the API's answer and never carries the key, which is in
    // the Anthropic client's constructor alone; the binding's errors are
    // Cloudflare's. Cut to a size a toast can hold.
    const status = error instanceof Anthropic.APIError ? (error.status ?? null) : null
    const message = String((error as { message?: unknown })?.message ?? error).slice(0, 2000)
    return json({ error: "provider_error", status, message, ...found() }, 502)
  }

  const suggestion = readTagSuggestion(extractJson(text), form.features)
  if (suggestion === null) {
    // The answer as it came, so the person can see what the model said.
    return json(
      { error: "bad_answer", detail: { ...found(), answer: text.slice(0, 2000) }, ...found() },
      422,
    )
  }
  const response: TagResponse = { suggestion, ...found() }
  return json(response)
}
