import React from "react"
import {
  refreshAnthropicKey,
  removeAnthropicKey,
  saveAnthropicKey,
  useAnthropicKey,
} from "../../data/anthropic-key"
import { usePending } from "../../hooks/pending"
import { AsyncButton } from "../ui/async-button"
import { Button } from "../ui/button"
import { TextInput } from "../ui/text-input"
import { SettingsSection } from "../settings-section"

/**
 * The user's own Anthropic API key, for tagging a board's pictures with
 * Claude (docs/boards.md, "Tagging with Claude"). Kept on the server and
 * never shown again: with one kept the card says its last characters and
 * offers to remove it; without, a box to paste one into and Save. A label
 * and nothing under it (docs/settings.md).
 */
export function AnthropicKeySection() {
  const key = useAnthropicKey()
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (key === null) void refreshAnthropicKey()
  }, [key])

  const [save, saving] = usePending(async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      await saveAnthropicKey(draft.trim())
      setDraft("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn’t save that key.")
    }
  })

  return (
    <SettingsSection title="Anthropic API key">
      {key?.set ? (
        <div className="flex items-center justify-between gap-4">
          <span className="font-mono text-text-secondary">sk-ant-…{key.last4}</span>
          <AsyncButton
            className="shrink-0"
            onClick={async () => {
              setError(null)
              try {
                await removeAnthropicKey()
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Couldn’t remove the key.")
              }
            }}
          >
            Remove
          </AsyncButton>
        </div>
      ) : (
        <form className="flex items-center gap-2" onSubmit={save}>
          {/* The card's heading names the box; the box carries it for a
              screen reader. */}
          <TextInput
            aria-label="Anthropic API key"
            type="password"
            className="font-mono"
            value={draft}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {/* The form's submit holds the flight, so `loading` rather than an
              AsyncButton (docs/design-principles.md, Busy controls). */}
          <Button
            type="submit"
            variant="primary"
            className="shrink-0"
            disabled={draft.trim() === "" || key === null}
            loading={saving}
          >
            Save
          </Button>
        </form>
      )}
      {error ? <span className="text-sm leading-4 text-text-danger">{error}</span> : null}
    </SettingsSection>
  )
}
