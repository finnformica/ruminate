// `POST /api/boards/tag` — a caption and tags for one of the caller's
// pictures, from Claude (docs/boards.md, "Tagging with Claude"). A PROOF OF
// CONCEPT, open to every signed-in user with a key kept.
//
// The body is a `TagRequest` (src/data/auto-tag.ts): the asset's id and
// the board's features with their values in use. The picture's bytes come
// from the caller's own prefix in R2 — the key is minted from the session,
// never from the body, as images.ts mints it — and go to the Anthropic
// Messages API with the caller's OWN key (anthropic-key.ts), a fixed system
// prompt and a JSON schema the answer is held to. The answer is read back
// into a `TagSuggestion` and returned; the client applies it through the
// board's ordinary writes, so this route writes nothing to the graph.
//
// Refusals, each a code the client puts into words:
//   412 no_api_key           no key kept — Settings → API
//   429 daily_limit          the account's calls for today are spent
//   429 rate_limited         the API said to slow down (its Retry-After passed on)
//   413 image_too_large      the API takes five megabytes of base64
//   415 unsupported_image    a format the API does not read (AVIF)
//   422 invalid_api_key      the API refused the key
//   502 anthropic_error      the API failed, or answered something else
//
// The key is in one place in this file — the client's constructor — and in
// no log line, no error detail and no response.

import Anthropic from "@anthropic-ai/sdk"
import {
  AUTO_TAG_IMAGE_TYPES,
  AUTO_TAG_MAX_IMAGE_BYTES,
  AUTO_TAG_MODEL,
  AUTO_TAG_SYSTEM_PROMPT,
  readTagRequest,
  readTagSuggestion,
  tagOutputSchema,
  tagPrompt,
  type TagResponse,
} from "../../src/data/auto-tag"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { spendKey } from "./anthropic-key"
import { isImageId } from "./image-policy"
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

export async function boardTag(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  options: { clock?: () => number; dailyLimit?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405)
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  const driver = controlPlaneDriver(env)

  const body = readTagRequest(await request.json().catch(() => null))
  if (body === null || !isImageId(body.imageId)) return json({ error: "invalid_body" }, 400)
  if (env.VITE_IMAGES_ENABLED !== "true" || !env.IMAGES) {
    return json({ error: "images_disabled" }, 501)
  }

  // The picture first, before a call is counted: a missing or unreadable
  // one costs the day nothing.
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
  const spend = await spendKey(driver, session.id, now, options.dailyLimit)
  if (!spend.ok) {
    if (spend.reason === "no_key") {
      return json(
        { error: "no_api_key", detail: "Add your Anthropic API key under Settings → API." },
        412,
      )
    }
    return json({ error: "daily_limit", detail: "Tagging has made its calls for today." }, 429, {
      "Retry-After": "3600",
    })
  }

  const client = new Anthropic({ apiKey: spend.apiKey, fetch: fetchImpl, maxRetries: 0 })
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
                media_type: mediaType as ImageMediaType,
                data: toBase64(bytes),
              },
            },
            { type: "text", text: tagPrompt(body.features) },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: tagOutputSchema() } },
    })
  } catch (error) {
    // The codes alone: an SDK error's message is the API's, and the API's
    // words are not for the person who pasted the key.
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return json(
        { error: "invalid_api_key", detail: "Anthropic refused the API key kept for you." },
        422,
      )
    }
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = error.headers?.get("retry-after")
      return json(
        { error: "rate_limited", detail: "Anthropic asked to slow down." },
        429,
        retryAfter ? { "Retry-After": retryAfter } : {},
      )
    }
    if (error instanceof Anthropic.APIError) {
      return json({ error: "anthropic_error", status: error.status ?? null }, 502)
    }
    throw error
  }

  if (answer.stop_reason === "refusal") return json({ error: "refused" }, 422)
  const text = answer.content.find((block) => block.type === "text")?.text ?? ""
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: "anthropic_error", status: null }, 502)
  }
  const suggestion = readTagSuggestion(parsed, body.features)
  if (suggestion === null) return json({ error: "anthropic_error", status: null }, 502)
  const response: TagResponse = { suggestion }
  return json(response)
}
