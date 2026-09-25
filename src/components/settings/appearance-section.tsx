import { useAtom } from "jotai"
import { Button } from "../ui/button"
import { IconButton } from "../ui/icon-button"
import { AccentColor, accentAtom, themeAtom, type Theme } from "../../global-state"
import { cx } from "../../utils/cx"
import { SettingsSection } from "../settings-section"

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

/** Each option's swatch shows its ramp's solid step 9 (the checked-checkbox
 * color). The ramps themselves adapt to light/dark via radix-colors.css. */
const ACCENT_OPTIONS: Array<{ value: AccentColor; label: string; swatchColor: string }> = [
  { value: "neutral", label: "Neutral", swatchColor: "var(--sand-9)" },
  { value: "cyan", label: "Cyan", swatchColor: "var(--cyan-9)" },
  { value: "green", label: "Green", swatchColor: "var(--green-9)" },
  { value: "violet", label: "Violet", swatchColor: "var(--violet-9)" },
  { value: "amber", label: "Amber", swatchColor: "var(--amber-9)" },
]

export function AppearanceSection() {
  const [theme, setTheme] = useAtom(themeAtom)
  const [accent, setAccent] = useAtom(accentAtom)

  return (
    <SettingsSection title="Appearance">
      <div className="flex flex-col gap-2">
        <span id="theme-label" className="text-sm leading-4 text-text-secondary">
          Theme
        </span>
        <div role="group" aria-labelledby="theme-label" className="flex flex-wrap gap-1">
          {THEME_OPTIONS.map((option) => {
            const isSelected = theme === option.value
            return (
              <Button
                key={option.value}
                size="small"
                aria-pressed={isSelected}
                onClick={() => setTheme(option.value)}
                selected={isSelected}
              >
                {option.label}
              </Button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span id="accent-color-label" className="text-sm leading-4 text-text-secondary">
          Accent color
        </span>
        <div role="group" aria-labelledby="accent-color-label" className="flex flex-wrap gap-1">
          {ACCENT_OPTIONS.map((option) => {
            const isSelected = accent === option.value
            return (
              <IconButton
                key={option.value}
                aria-label={option.label}
                aria-pressed={isSelected}
                onClick={() => setAccent(option.value)}
              >
                {/* The documented exception to "chosen is a fill": a swatch IS
                  a fill, so the choice has to be drawn around it. The ring is
                  ink, not accent — an accent ring on an accent swatch would
                  vanish, and it keeps the button's own accent focus ring
                  legible concentric with it. */}
                <span
                  aria-hidden="true"
                  className={cx(
                    "h-4 w-4 rounded-full",
                    isSelected &&
                      "ring-2 ring-[var(--color-text)] ring-offset-2 ring-offset-bg-card",
                  )}
                  style={{ backgroundColor: option.swatchColor }}
                />
              </IconButton>
            )
          })}
        </div>
        <span className="text-sm leading-5 text-text-secondary">
          {ACCENT_OPTIONS.find((option) => option.value === accent)?.label}
        </span>
      </div>
    </SettingsSection>
  )
}
