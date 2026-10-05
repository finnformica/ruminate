import { useState } from "react"
import { saveAccountPreferences, useAccountPreference } from "../../data/account-preferences"
import { usePending } from "../../hooks/pending"
import { Checkbox } from "../ui/checkbox"
import { SettingsSection } from "../settings-section"

/** Whether a board's pictures are tagged on Workers AI — free, within
 * Cloudflare's daily allowance — rather than with the account's Anthropic
 * key (docs/boards.md, "Tagging with Claude"). A preference of the account
 * (src/data/account-preferences.ts), drawn only while the `cloudflareAi`
 * flag allows it. A label and nothing under it (docs/settings.md). */
export function CloudflareAiSection() {
  const useCloudflare = useAccountPreference("useCloudflareAi")
  const [failed, setFailed] = useState(false)
  const [save, saving] = usePending(async (checked: boolean) => {
    setFailed(false)
    try {
      await saveAccountPreferences({ useCloudflareAi: checked })
    } catch {
      setFailed(true)
    }
  })

  return (
    <SettingsSection title="Cloudflare AI">
      <div className="flex items-center gap-2 leading-4">
        <Checkbox
          id="use-cloudflare-ai"
          checked={useCloudflare}
          disabled={saving}
          onCheckedChange={(checked) => save(checked)}
        />
        <label htmlFor="use-cloudflare-ai" className="flex cursor-pointer flex-col gap-1">
          <span>Use Cloudflare AI</span>
          {failed ? (
            <span className="text-sm leading-4 text-text-danger">
              Couldn't save that — check your connection and try again.
            </span>
          ) : null}
        </label>
      </div>
    </SettingsSection>
  )
}
