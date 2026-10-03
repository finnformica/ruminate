// `POST /api/boards/tag` — a caption and tags for one of the caller's
// pictures, from a vision model (docs/boards.md, "Tagging with Claude"). A
// PROOF OF CONCEPT, open to every signed-in user with a provider set up.
//
// ONE path, whoever answers. The body is a `TagRequest`
// (src/data/auto-tag.ts): the asset's id and the board's features with
// their values in use — nothing about who is asked. The handler resolves
// the provider itself, by the one router (src/data/ai-router.ts) over its
// own truth: the key row, the flag's audience, the stored preference —
// Anthropic if a key is kept, else Cloudflare if the `cloudflareAi` flag
// allows the caller and they opted in, else nothing. Then the picture is
// read from the caller's own prefix in R2 (the key minted from the session,
// never from the body, as images.ts mints it), the day's call counted
// (worker/ai-usage.ts, the same count for both), and the provider asked
// through one interface, `TagProvider`: a picture and the features in,
// the model's answer out as text. The providers differ in nothing else;
// one step after reads the text leniently (`extractJson`) into a
// `TagSuggestion` (`readTagSuggestion`: trimmed, de-duplicated, capped,
// one value for a single-value feature) and returns it. The client applies
// it through the board's ordinary writes; this route writes nothing.
//
// Refusals, each a code the client puts into words:
//   412 no_provider          nothing set up — Settings → AI
//   501 ai_disabled          Cloudflare chosen, but no binding
//   429 daily_limit          the account's calls for today are spent
//   429 rate_limited         the API said to slow down (its Retry-After passed on)
//   413 image_too_large      the API takes five megabytes of base64
//   415 unsupported_image    a format the API does not read (AVIF)
//   422 invalid_api_key      Anthropic refused the key
//   422 refused              the model declined
//   422 bad_answer           the answer is not a suggestion
//   502 provider_error       the provider failed
//
// The key is in one place in this file — the Anthropic client's
// constructor — and in no log line, no error detail and no response.

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
  type TagFeature,
  type TagResponse,
} from "../../src/data/auto-tag"
import { spendAiCall } from "../ai-usage"
import { featureAllows } from "../features"
import { controlPlaneDriver, corpusDriver, forTenant } from "../tenancy-db"
import type { Env } from "../types"
import { readKey } from "./anthropic-key"
import { isImageId } from "./image-policy"
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
    async suggest({ image, features }) {
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
                { type: "text", text: tagPrompt(features) },
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
 * input types in workers-types are a moving target, and this is one call. */
interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

/** The text of a chat-completion answer, wherever the model put it. */
function completionText(result: unknown): string {
  if (typeof result !== "object" || result === null) return ""
  const record = result as { choices?: unknown; response?: unknown }
  if (typeof record.response === "string") return record.response
  if (!Array.isArray(record.choices)) return ""
  const content = (record.choices[0] as { message?: { content?: unknown } } | undefined)?.message
    ?.content
  return typeof content === "string" ? content : ""
}

/**
 * Workers AI: the picture as a data URL in a chat-completion message, the
 * JSON asked for in the prompt. `response_format` is tried first — the
 * model's input schema lists it — and the call made again without it if
 * that is refused, since JSON mode is honoured by some models there and
 * not others.
 */
function cloudflareProvider(ai: AiBinding): TagProvider {
  return {
    async suggest({ image, features }) {
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
              { type: "text", text: cloudflareTagPrompt(features) },
            ],
          },
        ],
        max_tokens: 1024,
      }
      let result: unknown
      try {
        result = await ai.run(CLOUDFLARE_AI_MODEL, {
          ...input,
          response_format: {
            type: "json_schema",
            json_schema: { name: "tag_suggestion", schema: tagOutputSchema() },
          },
        })
      } catch {
        result = await ai.run(CLOUDFLARE_AI_MODEL, input)
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

export async function boardTag(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  options: { clock?: () => number; dailyLimit?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405)
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const body = readTagRequest(await request.json().catch(() => null))
  if (body === null || !isImageId(body.imageId)) return json({ error: "invalid_body" }, 400)
  if (env.VITE_IMAGES_ENABLED !== "true" || !env.IMAGES) {
    return json({ error: "images_disabled" }, 501)
  }

  // Who answers, before a byte is read or a call counted.
  const chosen = await chooseProvider(env, session)
  if (chosen === null) {
    return json(
      { error: "no_provider", detail: "Add your Anthropic API key under Settings → AI." },
      412,
    )
  }
  if (chosen === "cloudflare" && !env.AI) return json({ error: "ai_disabled" }, 501)

  // The picture, before the call is counted: a missing or unreadable one
  // costs the day nothing.
  const object = await env.IMAGES.get(`${session.id}/${body.imageId}`)
  if (!object) return json({ error: "not_found" }, 404)
  const mediaType = (object.httpMetadata?.contentType ?? "").split(";")[0].trim().toLowerCase()
  if (!AUTO_TAG_IMAGE_TYPES.includes(mediaType)) return json({ error: "unsupported_image" }, 415)
  if (object.size > AUTO_TAG_MAX_IMAGE_BYTES) return json({ error: "image_too_large" }, 413)
  // R2 hands back a body stream; the test's bucket hands back the buffer.
  // A Response reads either.
  const bytes = await new Response(object.body as BodyInit).arrayBuffer()
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
  let text: string
  try {
    text = await provider.suggest({
      image: { bytes, mimeType: mediaType as ImageMediaType },
      features: body.features,
    })
  } catch (error) {
    if (error instanceof ProviderRefusal) {
      return json(
        { error: error.code, ...(error.detail ? { detail: error.detail } : {}) },
        error.status,
        error.headers,
      )
    }
    const status = error instanceof Anthropic.APIError ? (error.status ?? null) : null
    return json({ error: "provider_error", provider: chosen, status }, 502)
  }

  const suggestion = readTagSuggestion(extractJson(text), body.features)
  if (suggestion === null) return json({ error: "bad_answer", provider: chosen }, 422)
  const response: TagResponse = { suggestion, provider: chosen }
  return json(response)
}
