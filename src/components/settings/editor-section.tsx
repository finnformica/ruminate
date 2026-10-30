import { useAtom } from "jotai"
import React from "react"
import { DEFAULT_NEW_BLOCK_MARKER } from "../../blocks/markers"
import { MAX_EXPANDED_LEVELS, MIN_EXPANDED_LEVELS } from "../../blocks/default-collapsed"
import type { RootTap } from "../../data/root-frame"
import {
  expandedLevelsAtom,
  newBlockMarkerAtom,
  pageWidthAtom,
  rootTapAtom,
} from "../../global-state"
import type { Width } from "../../schema"
import { WidthFixedIcon16, WidthFullIcon16 } from "../icons"
import { Button } from "../ui/button"
import { TextInput } from "../ui/text-input"
import { SettingsSection } from "../settings-section"

const WIDTH_OPTIONS: Array<{ value: Width; label: string; icon: React.ReactNode }> = [
  { value: "fixed", label: "Fixed", icon: <WidthFixedIcon16 /> },
  { value: "full", label: "Full width", icon: <WidthFullIcon16 /> },
]

/** What a tap on any block of the notes page does (`RootTap`). */
const ROOT_TAP_OPTIONS: Array<{ value: RootTap; label: string }> = [
  { value: "phone", label: "Phone only" },
  { value: "always", label: "Every device" },
  { value: "never", label: "Never" },
]

/** Quick picks for the new-block marker; anything else can be typed in. */
const NEW_BLOCK_MARKER_PRESETS: Array<{ value: string; label: string }> = [
  { value: DEFAULT_NEW_BLOCK_MARKER, label: "Bullet" },
  { value: "", label: "Paragraph" },
  { value: "[ ] ", label: "To-do" },
  { value: "> ", label: "Quote" },
]

export function EditorSection() {
  const [newBlockMarker, setNewBlockMarker] = useAtom(newBlockMarkerAtom)
  const [expandedLevels, setExpandedLevels] = useAtom(expandedLevelsAtom)
  const [pageWidth, setPageWidth] = useAtom(pageWidthAtom)
  const [rootTap, setRootTap] = useAtom(rootTapAtom)

  return (
    <SettingsSection title="Editor">
      <div className="flex flex-col gap-2">
        <span id="page-width-label" className="text-sm leading-4 text-text-secondary">
          Page width
        </span>
        <div role="group" aria-labelledby="page-width-label" className="flex flex-wrap gap-1">
          {WIDTH_OPTIONS.map((option) => (
            <Button
              key={option.value}
              size="small"
              aria-pressed={pageWidth === option.value}
              onClick={() => setPageWidth(option.value)}
              selected={pageWidth === option.value}
            >
              {option.icon}
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span id="root-tap-label" className="text-sm leading-4 text-text-secondary">
          Tap a block on the notes page to open it
        </span>
        <div role="group" aria-labelledby="root-tap-label" className="flex flex-wrap gap-1">
          {ROOT_TAP_OPTIONS.map((option) => (
            <Button
              key={option.value}
              size="small"
              aria-pressed={rootTap === option.value}
              onClick={() => setRootTap(option.value)}
              selected={rootTap === option.value}
            >
              {option.label}
            </Button>
          ))}
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
