import { useAtom } from "jotai"
import { DEFAULT_NEW_BLOCK_MARKER } from "../../blocks/markers"
import { MAX_EXPANDED_LEVELS, MIN_EXPANDED_LEVELS } from "../../blocks/default-collapsed"
import type { LinkDirections } from "../../data/graph"
import { expandedLevelsAtom, linkDirectionsAtom, newBlockMarkerAtom } from "../../global-state"
import { Button } from "../ui/button"
import { TextInput } from "../ui/text-input"
import { SettingsSection } from "../settings-section"

/** Quick picks for the new-block marker; anything else can be typed in. */
const NEW_BLOCK_MARKER_PRESETS: Array<{ value: string; label: string }> = [
  { value: DEFAULT_NEW_BLOCK_MARKER, label: "Bullet" },
  { value: "", label: "Paragraph" },
  { value: "[ ] ", label: "To-do" },
  { value: "> ", label: "Quote" },
]

/** Which links a note's rows follow (`LinkDirections`). */
const LINK_DIRECTION_OPTIONS: Array<{ value: LinkDirections; label: string }> = [
  { value: "downstream", label: "Downstream" },
  { value: "upstream", label: "Upstream" },
  { value: "both", label: "Both" },
]

export function EditorSection() {
  const [newBlockMarker, setNewBlockMarker] = useAtom(newBlockMarkerAtom)
  const [expandedLevels, setExpandedLevels] = useAtom(expandedLevelsAtom)
  const [linkDirections, setLinkDirections] = useAtom(linkDirectionsAtom)

  return (
    <SettingsSection title="Editor">
      <div className="flex flex-col gap-2">
        <span id="link-directions-label" className="text-sm leading-4 text-text-secondary">
          Show links
        </span>
        <div role="group" aria-labelledby="link-directions-label" className="flex flex-wrap gap-1">
          {LINK_DIRECTION_OPTIONS.map((option) => {
            const isSelected = linkDirections === option.value
            return (
              <Button
                key={option.value}
                size="small"
                aria-pressed={isSelected}
                onClick={() => setLinkDirections(option.value)}
                selected={isSelected}
              >
                {option.label}
              </Button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="expanded-levels" className="text-sm leading-4 text-text-secondary">
          Default expand
        </label>
        <div className="flex items-center gap-3">
          <input
            id="expanded-levels"
            type="range"
            min={MIN_EXPANDED_LEVELS}
            max={MAX_EXPANDED_LEVELS}
            step={1}
            value={expandedLevels}
            onChange={(event) => setExpandedLevels(Number(event.target.value))}
            className="focus-ring h-2 w-full max-w-64 cursor-pointer accent-[var(--color-border-focus)]"
          />
          <span className="w-6 tabular-nums" aria-live="polite">
            {expandedLevels}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="new-block-marker" className="text-sm leading-4 text-text-secondary">
          New block markdown
        </label>
        <TextInput
          id="new-block-marker"
          className="font-mono"
          value={newBlockMarker}
          placeholder="(none)"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setNewBlockMarker(event.target.value)}
        />
        <div role="group" aria-label="New block markdown presets" className="flex flex-wrap gap-1">
          {NEW_BLOCK_MARKER_PRESETS.map((preset) => {
            const isSelected = newBlockMarker === preset.value
            return (
              <Button
                key={preset.label}
                size="small"
                aria-pressed={isSelected}
                onClick={() => setNewBlockMarker(preset.value)}
                selected={isSelected}
              >
                {preset.label}
                {preset.value ? (
                  <span className="ml-1 font-mono text-text-secondary">{preset.value.trim()}</span>
                ) : null}
              </Button>
            )
          })}
        </div>
      </div>
    </SettingsSection>
  )
}
