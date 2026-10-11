import { useSyncExternalStore } from "react"

/** The width below which the stylesheets lay out for a phone (`max-sm:` in
 * Tailwind, whose `sm` is 40rem). */
const NARROW_QUERY = "(max-width: 39.9375rem)"

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(NARROW_QUERY)
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  if (!list) return () => {}
  list.addEventListener("change", onChange)
  return () => list.removeEventListener("change", onChange)
}

function getSnapshot(): boolean {
  return query()?.matches ?? false
}

/**
 * Whether the screen is a phone's, as the stylesheets' `max-sm:` decides it
 * — for the few things code rather than CSS must settle by the width, such
 * as where a menu is anchored (`src/components/view-controls.tsx`). Where
 * `matchMedia` is missing (jsdom) it is false, so tests see the wide
 * layout unless they stub the query.
 */
export function useNarrowScreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
