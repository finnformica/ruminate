import { useAtomValue } from "jotai"
import React from "react"
import { useAccountPreference } from "../data/account-preferences"
import { resolveAiProvider } from "../data/ai-router"
import { refreshAnthropicKey, useAnthropicKey } from "../data/anthropic-key"
import type { AiProvider } from "../data/auto-tag"
import { useFeature } from "../data/features"
import { isDatabaseModeAtom } from "../global-state"

export interface AiAvailability {
  available: boolean
  provider: AiProvider | null
}

/**
 * Whether an AI feature is on for this account, and who answers it — the
 * router's order (`resolveAiProvider`, src/data/ai-router.ts) over what
 * this sign-in knows: the key kept, the flag, the preference. The one hook
 * everything that shows or enables such a feature reads — the board's
 * Suggest, the writes behind it — so they cannot disagree, and what it
 * shows is what the Worker will choose for itself. Signed out there is no
 * account, so nothing. Whether an Anthropic key is kept is asked for the
 * first time something needs to know, not at every sign-in.
 */
export function useAiAvailable(): AiAvailability {
  const signedIn = useAtomValue(isDatabaseModeAtom)
  const cloudflareAllowed = useFeature("cloudflareAi")
  const cloudflareOptIn = useAccountPreference("useCloudflareAi")
  const key = useAnthropicKey()
  React.useEffect(() => {
    if (signedIn && key === null) void refreshAnthropicKey()
  }, [signedIn, key])
  const hasKey = key?.set === true
  return React.useMemo(() => {
    const provider = signedIn
      ? resolveAiProvider({ hasKey, cloudflareAllowed, cloudflareOptIn })
      : null
    return { available: provider !== null, provider }
  }, [signedIn, hasKey, cloudflareAllowed, cloudflareOptIn])
}
