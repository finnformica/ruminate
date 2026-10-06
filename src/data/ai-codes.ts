/**
 * The codes a route that asks a model answers with (docs/boards.md,
 * "Tagging with Claude") — each a refusal the client puts into words — and
 * two the client raises for itself. Named once, so the Worker's responses
 * and the client's words cannot drift: the Worker answers with
 * `SUGGEST_CODES`, at the status `SUGGEST_STATUS` pairs with the code, and
 * the client's message table is keyed by the same codes.
 */
export const SUGGEST_CODES = {
  /** 400: not the request the route takes. */
  invalidBody: "invalid_body",
  /** 405: not a POST. */
  methodNotAllowed: "method_not_allowed",
  /** 412: nothing set up — Settings → AI. */
  noProvider: "no_provider",
  /** 501: Cloudflare chosen, but no binding. */
  aiDisabled: "ai_disabled",
  /** 429: the account's calls for today are spent. */
  dailyLimit: "daily_limit",
  /** 429: the API said to slow down (its Retry-After passed on). */
  rateLimited: "rate_limited",
  /** 413: past the API's five megabytes of base64. */
  imageTooLarge: "image_too_large",
  /** 415: a format the API does not read (AVIF). */
  unsupportedImage: "unsupported_image",
  /** 422: Anthropic refused the key. */
  invalidApiKey: "invalid_api_key",
  /** 422: the model declined. */
  refused: "refused",
  /** 422: the answer is not a suggestion (the answer is in `detail`). */
  badAnswer: "bad_answer",
  /** 502: the provider failed (its words are in `message`). */
  providerError: "provider_error",
  /** The client's own: there is no session to ask through. */
  signedOut: "signed_out",
  /** The client's own: the route answered with nothing it could read. */
  failed: "failed",
} as const

export type SuggestCode = (typeof SUGGEST_CODES)[keyof typeof SUGGEST_CODES]

/** The codes the Worker answers with, each at its status. */
export const SUGGEST_STATUS = {
  [SUGGEST_CODES.invalidBody]: 400,
  [SUGGEST_CODES.methodNotAllowed]: 405,
  [SUGGEST_CODES.noProvider]: 412,
  [SUGGEST_CODES.aiDisabled]: 501,
  [SUGGEST_CODES.dailyLimit]: 429,
  [SUGGEST_CODES.rateLimited]: 429,
  [SUGGEST_CODES.imageTooLarge]: 413,
  [SUGGEST_CODES.unsupportedImage]: 415,
  [SUGGEST_CODES.invalidApiKey]: 422,
  [SUGGEST_CODES.refused]: 422,
  [SUGGEST_CODES.badAnswer]: 422,
  [SUGGEST_CODES.providerError]: 502,
} as const satisfies Partial<Record<SuggestCode, number>>

/** A code the Worker answers with. */
export type ServerSuggestCode = keyof typeof SUGGEST_STATUS

/** How long, in seconds, a caller is told to wait once the day's calls
 * are spent: the `Retry-After` on a `daily_limit`. */
export const DAILY_LIMIT_RETRY_AFTER = "3600"
