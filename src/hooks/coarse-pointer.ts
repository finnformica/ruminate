import { useSyncExternalStore } from "react"

/** The media query the stylesheets key touch behaviour off (`coarse:` in
 * tailwind.config.cjs, `@media (pointer: coarse)` in the CSS). */
const COARSE_QUERY = "(pointer: coarse)"

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(COARSE_QUERY)
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
 * Whether the primary pointer is a finger (`pointer: coarse`) — a phone or
 * a tablet. The one place code, as opposed to the stylesheets, asks: the
 * editor's touch behaviour (a tap edits, the edit bar above the keyboard,
 * the block menu's structure moves) keys off it. Where `matchMedia` is
 * missing (jsdom) it is false, so tests see the pointer behaviour unless
 * they stub the query.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
