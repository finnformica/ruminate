import type { SharesListBody, SliceBody } from "../../worker/shares/wire"
import type { AnthropicKeyBody } from "../data/auto-tag"
import type { LoggedKeyEvent } from "../data/key-events"
import type { McpTokenSummary } from "../data/mcp-tokens"
import type { FeaturesBody } from "../data/feature-flags"
import type { PreferencesBody } from "../data/preferences"

/**
 * One set of screenshot fixtures (docs/screenshots.md): everything the
 * signed-in app asks the Worker for, answered in the browser by the mock
 * API (`mock-api.ts`). The demo set is committed (`shots/demo/`, made by
 * `scripts/shots-demo.ts`); the profile set is made from a copy of
 * production by `scripts/shots-profile.mjs` and is kept outside the repo.
 */
export interface ShotsFixtures {
  kind: "demo" | "profile"
  /**
   * The day the set's dates were written against (`YYYY-MM-DD`). The mock
   * API moves every date forward by the days from it to today, so a demo
   * tracker always ends today. Null leaves the dates as they are.
   */
  anchorDay: string | null
  /** The signed-in user. */
  user: { id: number; login: string; name: string; email: string }
  /** The tenant's per-key log, oldest first, each with its `seq`. The cache
   * and the first screen are folded from it. */
  events: LoggedKeyEvent[]
  features: FeaturesBody
  preferences: PreferencesBody
  shares: SharesListBody
  /** The slice of each received share, by share id. */
  slices: Record<string, SliceBody>
  mcpTokens: McpTokenSummary[]
  anthropicKey: AnthropicKeyBody
  /** `GET /api/reminders` (habit reminders, PR #319): the server's push
   * key, and this device's reminder. */
  reminders: {
    publicKey: string | null
    reminder: { reminderTime: string; timeZone: string; lastSentDay: string | null } | null
  }
}
