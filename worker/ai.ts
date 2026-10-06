// The one AI path, shared by every route that asks a model (docs/boards.md,
// "Tagging with Claude"): `POST /api/boards/tag` for a picture's caption and
// tags, `POST /api/boards/notes` for a board's feature notes. A route reads
// its own request and its own answer; everything between is here —
//
// - WHO ANSWERS: `chooseProvider`, the one router (src/data/ai-router.ts)
//   over the Worker's own truth — the key row, the flag's audience, the
//   stored preference — Anthropic if a key is kept, else Cloudflare if the
//   `cloudflareAi` flag allows the caller and they opted in, else nothing.
// - THE ASK: `resolveAsker` hands a route an `Asker` for the chosen
//   provider, or the refusal to answer with (412 nothing set up, 501
//   Cloudflare chosen with no binding). Its `ask` takes a system prompt, a
//   user prompt, the JSON schema the answer is held to and, when the caller
//   has one, a picture, and gives back the model's text — JSON, if the
//   model did as asked; the route's own reader decides. The providers
//   differ in nothing else.
// - THE REFUSALS: a provider passes on what it must (a bad key, a rate
//   limit, a decline) as a `ProviderRefusal`; anything else it throws is a
//   `provider_error`. `failureResponse` turns either into the body the
//   client expects, carrying what the call can be found by (`found`: the
//   provider, its model, and on the Cloudflare path the AI Gateway log id)
//   and what the provider said.
//
// The key is in one place — the Anthropic client's constructor — and in no
// log line, no error detail and no response: the SDK's error messages are
// the API's answers, which never carry it.

import Anthropic from "@anthropic-ai/sdk"
import {
  DAILY_LIMIT_RETRY_AFTER,
  SUGGEST_CODES,
  SUGGEST_STATUS,
  type ServerSuggestCode,
} from "../src/data/ai-codes"
import { MAX_DETAIL_LENGTH } from "../src/data/ai-limits"
import { resolveAiProvider } from "../src/data/ai-router"
import { AUTO_TAG_MODEL, CLOUDFLARE_AI_MODEL, type AiProvider } from "../src/data/auto-tag"
import { featureAllows } from "./features"
import { readKey } from "./handlers/anthropic-key"
import { storedPreferences } from "./handlers/preferences"
import { controlPlaneDriver, corpusDriver, forTenant } from "./tenancy-db"
import type { Env } from "./types"

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

/** A refusal, at the status its code pairs with (`SUGGEST_STATUS`), with
 * whatever else the body carries. */
export const refusal = (
  code: ServerSuggestCode,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response => json({ error: code, ...body }, SUGGEST_STATUS[code], headers)

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

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

/** What a route asks: the fixed system prompt, the text beside it (and,
 * for Workers AI, the same text with the JSON asked for in so many words,
 * since JSON mode is not something every model there honours), the schema
 * the answer is held to, named for the binding, and a picture when there
 * is one. */
interface AskInput {
  system: string
  prompt: string
  cloudflarePrompt: string
  schema: Record<string, unknown>
  schemaName: string
  image?: { bytes: ArrayBuffer; mimeType: ImageMediaType }
}

/**
 * A provider: asked, answers with the model's text. A refusal it must pass
 * on is a `ProviderRefusal`; anything else it throws is a `provider_error`.
 */
interface Provider {
  ask(input: AskInput): Promise<string>
}

class ProviderRefusal extends Error {
  constructor(
    public readonly code: ServerSuggestCode,
    public readonly detail?: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(code)
  }
}

/** The Messages API with the caller's own key: a fixed system prompt and
 * a JSON schema the answer is held to. */
function anthropicProvider(apiKey: string, fetchImpl: typeof fetch): Provider {
  const client = new Anthropic({ apiKey, fetch: fetchImpl, maxRetries: 0 })
  return {
    async ask({ system, prompt, schema, image }) {
      let answer: Anthropic.Message
      try {
        answer = await client.messages.create({
          model: AUTO_TAG_MODEL,
          max_tokens: 1024,
          system,
          messages: [
            {
              role: "user",
              content: [
                ...(image
                  ? [
                      {
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          media_type: image.mimeType,
                          data: toBase64(image.bytes),
                        },
                      },
                    ]
                  : []),
                { type: "text", text: prompt },
              ],
            },
          ],
          output_config: { format: { type: "json_schema", schema } },
        })
      } catch (error) {
        // The codes alone: an SDK error's message is the API's, and the
        // API's words are not for the person who pasted the key.
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError
        ) {
          throw new ProviderRefusal(
            SUGGEST_CODES.invalidApiKey,
            "Anthropic refused the API key kept for you.",
          )
        }
        if (error instanceof Anthropic.RateLimitError) {
          const retryAfter = error.headers?.get("retry-after")
          throw new ProviderRefusal(
            SUGGEST_CODES.rateLimited,
            "Anthropic asked to slow down.",
            retryAfter ? { "Retry-After": retryAfter } : {},
          )
        }
        throw error
      }
      if (answer.stop_reason === "refusal") throw new ProviderRefusal(SUGGEST_CODES.refused)
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
 * Workers AI: the picture, when there is one, as a data URL in a
 * chat-completion message, the JSON asked for in the prompt.
 * `response_format` is tried first — the model's input schema lists it —
 * and the call made again without it if that is refused, since JSON mode
 * is honoured by some models there and not others. Reasoning is switched
 * off (`chat_template_kwargs`): on by default for this model, it makes the
 * answer slow and can spend the output on thought before any JSON. The
 * output cap is given under both names the docs use. Every call goes
 * through AI Gateway, for its logs.
 */
function cloudflareProvider(ai: AiBinding): Provider {
  return {
    async ask({ system, cloudflarePrompt, schema, schemaName, image }) {
      const input = {
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              ...(image
                ? [
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:${image.mimeType};base64,${toBase64(image.bytes)}`,
                      },
                    },
                  ]
                : []),
              { type: "text", text: cloudflarePrompt },
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
            response_format: { type: "json_schema", json_schema: { name: schemaName, schema } },
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

/** Who may be asked: a verified session's account. */
export interface AiSession {
  id: number
  login: string
  name: string | null
}

/** The handler's own truth, resolved by the one router. */
async function chooseProvider(env: Env, session: AiSession): Promise<AiProvider | null> {
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

/** What a failing call can be found by: the provider, its model, and — on
 * the Cloudflare path — the AI Gateway log the call was written to. */
export interface Found {
  provider: AiProvider
  model: string
  log?: string
}

/** A route's way to the chosen model. */
export interface Asker {
  chosen: AiProvider
  ask(input: AskInput): Promise<string>
  found(): Found
}

/**
 * The asker for the caller's account, or the refusal to answer with: 412
 * when nothing is set up, 501 when Cloudflare is chosen but there is no
 * binding. Resolved before a call is counted or a byte read.
 */
export async function resolveAsker(
  env: Env,
  session: AiSession,
  fetchImpl: typeof fetch,
): Promise<Asker | Response> {
  const chosen = await chooseProvider(env, session)
  if (chosen === null) {
    return refusal(SUGGEST_CODES.noProvider, {
      detail: "Add your Anthropic API key under Settings → AI.",
    })
  }
  if (chosen === "cloudflare" && !env.AI) return refusal(SUGGEST_CODES.aiDisabled)
  const provider: Provider =
    chosen === "anthropic"
      ? anthropicProvider((await readKey(controlPlaneDriver(env), session.id)) ?? "", fetchImpl)
      : cloudflareProvider(env.AI as unknown as AiBinding)
  const model = chosen === "anthropic" ? AUTO_TAG_MODEL : CLOUDFLARE_AI_MODEL
  const logOf = () => (chosen === "cloudflare" ? gatewayLogOf(env.AI) : undefined)
  return {
    chosen,
    ask: (input) => provider.ask(input),
    found: () => ({ provider: chosen, model, ...(logOf() ? { log: logOf() } : {}) }),
  }
}

/**
 * The response for a call that failed: a refusal the provider passed on,
 * at its own status with its code and detail (and headers — a rate
 * limit's Retry-After); or, for anything else, 502 `provider_error` with
 * the provider's own words, for the person debugging — an SDK error's
 * message is the API's answer and never carries the key, which is in the
 * Anthropic client's constructor alone; the binding's errors are
 * Cloudflare's. Cut to a size a toast can hold.
 */
export function failureResponse(error: unknown, found: Found): Response {
  if (error instanceof ProviderRefusal) {
    return refusal(
      error.code,
      { ...(error.detail ? { detail: error.detail } : {}), ...found },
      error.headers,
    )
  }
  const status = error instanceof Anthropic.APIError ? (error.status ?? null) : null
  const message = String((error as { message?: unknown })?.message ?? error).slice(
    0,
    MAX_DETAIL_LENGTH,
  )
  return refusal(SUGGEST_CODES.providerError, { status, message, ...found })
}

/** The response for an answer that is not what was asked for: the answer
 * as it came, so the person can see what the model said. */
export function badAnswerResponse(text: string, found: Found): Response {
  return refusal(SUGGEST_CODES.badAnswer, {
    detail: { ...found, answer: text.slice(0, MAX_DETAIL_LENGTH) },
    ...found,
  })
}

/** The response for a day whose calls are spent. */
export function dailyLimitResponse(detail: string): Response {
  return refusal(SUGGEST_CODES.dailyLimit, { detail }, { "Retry-After": DAILY_LIMIT_RETRY_AFTER })
}
