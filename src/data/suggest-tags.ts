import type { TagFeature, TagLocation, TagResponse, TagSuggestion } from "./auto-tag"
import { sessionFetch } from "./session-fetch"

/**
 * The request for a picture's caption and tags (docs/boards.md, "Tagging
 * with Claude"): `POST /api/boards/tag` as a form — the picture's bytes
 * as `image`, fitted for the model by the caller (`visionCopy`,
 * src/data/image-fit.ts), and the board's features as `features`, a JSON
 * string. The route's refusals (worker/handlers/board-tag.ts) come back as
 * one error with the words a toast shows and, beneath them, the detail a
 * person can copy out of the toast to say what went wrong.
 */

export class SuggestTagsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Plain lines for the clipboard: the message, then what the call can
     * be found by and what the provider said. */
    public readonly detail: string = message,
  ) {
    super(message)
    this.name = "SuggestTagsError"
  }
}

/** The words for each refusal — what the person can do about it. */
const MESSAGES: Record<string, string> = {
  no_provider: "Set up AI under Settings → AI to suggest tags.",
  invalid_api_key: "Anthropic refused your API key — check it under Settings → AI.",
  ai_disabled: "Cloudflare AI isn’t set up on this Ruminate.",
  provider_error: "The model couldn’t answer — try again in a moment.",
  bad_answer: "The model’s answer made no sense — try again.",
  daily_limit: "Tagging has made its calls for today.",
  rate_limited: "Anthropic asked to slow down — try again in a minute.",
  image_too_large: "That picture is too large to tag.",
  unsupported_image: "That picture is in a format the model can’t read.",
  refused: "The model declined to tag that picture.",
}

/** What the route answers with, when it is JSON: an answer or a refusal. */
type ParsedBody = Partial<TagResponse> & RefusalBody

/** What a refusal's body may carry beside its code. */
interface RefusalBody {
  error?: unknown
  provider?: unknown
  model?: unknown
  log?: unknown
  status?: unknown
  detail?: unknown
  message?: unknown
}

/**
 * The detail for the clipboard: the message, then one line per thing the
 * call can be found by — the code, the HTTP status, the provider and its
 * model, the gateway log, the request's `cf-ray` — and the provider's own
 * words (`detail` or `message`) as they came, pretty-printed when they are
 * JSON. When the body was not JSON at all, its raw text is what there is.
 */
export function suggestTagsDetail(parts: {
  message: string
  code: string
  status: number
  body: RefusalBody | null
  rawBody?: string
  cfRay?: string | null
  /** What was read from the answer, on a success. */
  suggestion?: TagSuggestion
  /** The answer as it came, on a success. */
  answer?: string
}): string {
  const lines = [parts.message, `code: ${parts.code}`, `status: ${parts.status}`]
  const body = parts.body
  const line = (name: string, value: unknown) => {
    if (typeof value === "string" && value !== "") lines.push(`${name}: ${value}`)
    else if (typeof value === "number") lines.push(`${name}: ${value}`)
  }
  line("provider", body?.provider)
  line("model", body?.model)
  line("log", body?.log)
  if (parts.cfRay) lines.push(`cf-ray: ${parts.cfRay}`)
  if (typeof body?.status === "number" && body.status !== parts.status) {
    lines.push(`provider status: ${body.status}`)
  }
  for (const [name, value] of [
    ["detail", body?.detail],
    ["message", body?.message],
  ] as const) {
    if (value === undefined || value === null || value === "") continue
    lines.push(`${name}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)
  }
  if (body === null && parts.rawBody) lines.push(`body: ${parts.rawBody.slice(0, 2000)}`)
  if (parts.suggestion) lines.push(`suggestion: ${JSON.stringify(parts.suggestion, null, 2)}`)
  if (parts.answer) lines.push(`answer: ${parts.answer}`)
  return lines.join("\n")
}

/** What a request answers with: the suggestion, and the detail the
 * success toast's Copy puts on the clipboard. */
export interface TagResult {
  suggestion: TagSuggestion
  detail: string
}

export async function requestTagSuggestion(
  image: Blob,
  features: TagFeature[],
  location?: TagLocation | null,
): Promise<TagResult> {
  const form = new FormData()
  form.set("image", image, "picture")
  // The one field beside the picture: the request's JSON (`TagRequest`),
  // the features and, when the picture's block carries one, its location.
  form.set("features", JSON.stringify(location ? { features, location } : { features }))
  // No Content-Type: the browser writes the form's own, boundary and all.
  const response = await sessionFetch(
    "/api/boards/tag",
    { method: "POST", body: form },
    () => new SuggestTagsError("signed_out", "Sign in to suggest tags."),
  )
  const rawBody = await response.text().catch(() => "")
  let body: ParsedBody | null = null
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed === "object" && parsed !== null) body = parsed as ParsedBody
  } catch {
    body = null
  }
  const cfRay = response.headers.get("cf-ray")
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "failed"
    const message = MESSAGES[code] ?? `Couldn’t suggest tags (${response.status}).`
    throw new SuggestTagsError(
      code,
      message,
      suggestTagsDetail({ message, code, status: response.status, body, rawBody, cfRay }),
    )
  }
  if (!body?.suggestion) {
    const message = "Couldn’t suggest tags."
    throw new SuggestTagsError(
      "failed",
      message,
      suggestTagsDetail({ message, code: "failed", status: response.status, body, rawBody, cfRay }),
    )
  }
  return {
    suggestion: body.suggestion,
    detail: suggestTagsDetail({
      message: "Suggested",
      code: "ok",
      status: response.status,
      body,
      cfRay,
      suggestion: body.suggestion,
      answer: typeof body.answer === "string" ? body.answer : undefined,
    }),
  }
}
