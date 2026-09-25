import { useState } from "react"
import { saveAccountPreferences, useAccountPreference } from "../../data/account-preferences"
import { usePending } from "../../hooks/pending"
import { Checkbox } from "../ui/checkbox"
import { SettingsSection } from "../settings-section"

/** The what's-new card, and whether it greets an update at all. Off until
 * asked for, and a preference of the account (src/data/account-preferences.ts)
 * rather than the device, so it is answered once; **Changelog** in the
 * sidebar reaches the changelog either way. A label and nothing under it
 * (docs/settings.md). */
export function ChangelogSection() {
  const showWhatsNew = useAccountPreference("whatsNewCard")
  const [failed, setFailed] = useState(false)
  // The box shows the new value at once and is held until the server has it
  // (docs/design-principles.md, Busy controls); refused, the value goes back
  // and the row says so.
  const [save, saving] = usePending(async (checked: boolean) => {
    setFailed(false)
    try {
      await saveAccountPreferences({ whatsNewCard: checked })
    } catch {
      setFailed(true)
    }
  })

  return (
    <SettingsSection title="Changelog">
      {/* `htmlFor` points at the checkbox, which renders a <button> — a
          labelable element — so clicking the label toggles it. */}
      {/* Centred, not top-aligned with a nudge: that layout was for a label
          with a line under it, and with the label alone it sat the box 2px
          low. */}
      <div className="flex items-center gap-2 leading-4">
        <Checkbox
          id="show-whats-new"
          checked={showWhatsNew}
          disabled={saving}
          onCheckedChange={(checked) => save(checked)}
        />
        <label htmlFor="show-whats-new" className="flex cursor-pointer flex-col gap-1">
          <span>Show what's new after an update</span>
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
