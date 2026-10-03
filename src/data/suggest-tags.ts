import type { TagFeature, TagResponse, TagSuggestion } from "./auto-tag"
import { sessionFetch } from "./session-fetch"

/**
 * The request for a picture's caption and tags from Claude (docs/boards.md,
 * "Tagging with Claude"): `POST /api/boards/tag` with the asset's id and
 * the board's features. The route's refusals (worker/handlers/board-tag.ts)
 * come back as one error with the words a toast shows.
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
  no_api_key: "Add your Anthropic API key under Settings → Boards to suggest tags.",
  feature_off: "Tagging isn’t switched on for this account.",
  invalid_api_key: "Anthropic refused your API key — check it under Settings → Boards.",
  daily_limit: "Tagging has made its calls for today.",
  rate_limited: "Anthropic asked to slow down — try again in a minute.",
  image_too_large: "That picture is too large to tag.",
  unsupported_image: "That picture is in a format Claude can’t read.",
  not_found: "That picture hasn’t finished uploading.",
  refused: "Claude declined to tag that picture.",
  anthropic_error: "Anthropic couldn’t answer — try again in a moment.",
}

export async function requestTagSuggestion(
  imageId: string,
  features: TagFeature[],
): Promise<TagSuggestion> {
  const response = await sessionFetch(
    "/api/boards/tag",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageId, features }),
    },
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
