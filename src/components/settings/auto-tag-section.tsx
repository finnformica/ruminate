import { useState } from "react"
import { saveAccountPreferences, useAccountPreference } from "../../data/account-preferences"
import { usePending } from "../../hooks/pending"
import { Checkbox } from "../ui/checkbox"
import { SettingsSection } from "../settings-section"

/** Whether a picture added from a board is tagged by Claude as soon as it
 * has uploaded (docs/boards.md, "Tagging with Claude"). A preference of the
 * account (src/data/account-preferences.ts), off until asked for, and
 * nothing without a key kept. A label and nothing under it
 * (docs/settings.md). */
export function AutoTagSection() {
  const autoTag = useAccountPreference("autoTagPictures")
  const [failed, setFailed] = useState(false)
  const [save, saving] = usePending(async (checked: boolean) => {
    setFailed(false)
    try {
      await saveAccountPreferences({ autoTagPictures: checked })
    } catch {
      setFailed(true)
    }
  })

  return (
    <SettingsSection title="Tagging">
      <div className="flex items-center gap-2 leading-4">
        <Checkbox
          id="auto-tag-pictures"
          checked={autoTag}
          disabled={saving}
          onCheckedChange={(checked) => save(checked)}
        />
        <label htmlFor="auto-tag-pictures" className="flex cursor-pointer flex-col gap-1">
          <span>Tag new pictures automatically</span>
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
