import type { TagFeature, TagResponse, TagSuggestion } from "./auto-tag"
import { sessionFetch } from "./session-fetch"

/**
 * The request for a picture's caption and tags (docs/boards.md, "Tagging
 * with Claude"): `POST /api/boards/tag` as a form — the picture's bytes
 * as `image`, fitted for the model by the caller (`visionCopy`,
 * src/data/image-fit.ts), and the board's features as `features`, a JSON
 * string. The route's refusals (worker/handlers/board-tag.ts) come back as
 * one error with the words a toast shows.
 */

export class SuggestTagsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
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

export async function requestTagSuggestion(
  image: Blob,
  features: TagFeature[],
): Promise<TagSuggestion> {
  const form = new FormData()
  form.set("image", image, "picture")
  form.set("features", JSON.stringify(features))
  // No Content-Type: the browser writes the form's own, boundary and all.
  const response = await sessionFetch(
    "/api/boards/tag",
    { method: "POST", body: form },
    () => new SuggestTagsError("signed_out", "Sign in to suggest tags."),
  )
  const body = (await response.json().catch(() => null)) as
    (Partial<TagResponse> & { error?: string }) | null
  if (!response.ok) {
    const code = body?.error ?? "failed"
    throw new SuggestTagsError(
      code,
      MESSAGES[code] ?? `Couldn’t suggest tags (${response.status}).`,
    )
  }
  if (!body?.suggestion) throw new SuggestTagsError("failed", "Couldn’t suggest tags.")
  return body.suggestion
}
