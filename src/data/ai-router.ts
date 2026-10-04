import type { AiProvider } from "./auto-tag"

/**
 * Which provider answers an AI feature for an account, in one fixed order
 * (docs/boards.md, "Tagging with Claude"):
 *
 *   1. **Anthropic**, when the account has a key kept;
 *   2. **Cloudflare**, when the `cloudflareAi` flag allows the account and
 *      **Use Cloudflare AI** is ticked;
 *   3. none.
 *
 * Pure, and the ONE place the order lives: the client's `useAiAvailable`
 * (src/hooks/ai.ts) reads it to draw and enable, and the Worker's tag
 * handler (worker/handlers/board-tag.ts) reads it from its own truth — the
 * key row, the flag's audience, the stored preference — to choose. The
 * client never chooses; it only shows the same answer.
 */
export interface AiRouterState {
  hasKey: boolean
  cloudflareAllowed: boolean
  cloudflareOptIn: boolean
}

export function resolveAiProvider(state: AiRouterState): AiProvider | null {
  if (state.hasKey) return "anthropic"
  if (state.cloudflareAllowed && state.cloudflareOptIn) return "cloudflare"
  return null
}
