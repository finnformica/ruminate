import { useEffect, useState } from "react"

/**
 * Whether something that has been closed should still be rendered, because
 * its exit is playing.
 *
 * For a panel whose width belongs to a layout rather than to itself (the help
 * sidebar is a resizable panel): the layout can only change by the panel
 * leaving, so the panel's contents slide out first, and the panel goes when
 * they have gone. Opening is immediate — the layout changes and the contents
 * arrive into the space. The exit takes the app's slow duration, read from
 * the stylesheet (`--duration-slow`, src/styles/variables.css) so the timing
 * lives in one place.
 */
export function usePresence(open: boolean): boolean {
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    const timer = setTimeout(() => setPresent(false), slowDuration())
    return () => clearTimeout(timer)
  }, [open])
  return open || present
}

function slowDuration(): number {
  if (typeof document === "undefined") return 0
  const value = getComputedStyle(document.documentElement).getPropertyValue("--duration-slow")
  const ms = parseFloat(value)
  return Number.isFinite(ms) ? ms * (value.trim().endsWith("ms") ? 1 : 1000) : 300
}
