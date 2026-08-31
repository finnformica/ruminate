import { useEffect, useRef, useState } from "react"

/** True when the key event came from somewhere the user is typing (mirrors
 * the guard in src/shortcuts/global-shortcuts.tsx). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

/**
 * Linear-style keyboard navigation for a filterable list page (the notes
 * index, the tags page): a roving highlight the caller renders with the
 * selection accent (`.list-highlight` — the editor's selection tokens).
 *
 * - `↓`/`↑` move the highlight (from nothing: `↓` starts at the first item,
 *   `↑` at the last); `Home`/`End` jump while a highlight exists.
 * - `↓` **inside the page's search input** hands the keyboard to the list:
 *   the input blurs and the first result highlights (the query stays applied).
 * - `Enter` activates the highlighted item; `Escape` clears the highlight and
 *   returns focus to the search input.
 * - `→`/`←` are optional (`onExpand`/`onCollapse`): a tree-shaped list — the
 *   block search results — uses them to open and close a row. Lists that pass
 *   neither leave the arrows alone.
 * - The highlight follows filtering: when `resetKey` (the query) changes, an
 *   existing highlight resets to the first result; it also clamps when the
 *   list shrinks.
 *
 * The listener is document-level but inert while typing anywhere (except the
 * `↓` hand-off from this page's own search input) and ignores modifier
 * combos and already-handled events, so it can never fight the global keys
 * (`g` chords, `?`, `i`, `/`) or the block editor.
 *
 * Rows must carry `data-list-index={i}` inside the container so the highlight
 * can scroll into view (`nearest`).
 */
export function useListKeyboardNav({
  count,
  resetKey,
  onActivate,
  onExpand,
  onCollapse,
  enabled = true,
}: {
  /** How many items are currently listed (the highlight stays within). */
  count: number
  /** The filter query; changing it resets an existing highlight to the top. */
  resetKey: string
  /** Open the item at this index (Enter). */
  onActivate: (index: number) => void
  /** `→` on the highlighted item (tree lists only). */
  onExpand?: (index: number) => void
  /** `←` on the highlighted item (tree lists only). */
  onCollapse?: (index: number) => void
  /** Mount the document listener at all (false for embedded lists). */
  enabled?: boolean
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  // The element containing both the page's search input and the list rows.
  const containerRef = useRef<HTMLDivElement | null>(null)

  const countRef = useRef(count)
  countRef.current = count
  const activeIndexRef = useRef(activeIndex)
  activeIndexRef.current = activeIndex
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const onExpandRef = useRef(onExpand)
  onExpandRef.current = onExpand
  const onCollapseRef = useRef(onCollapse)
  onCollapseRef.current = onCollapse

  useEffect(() => {
    if (!enabled) return
    const searchInput = () =>
      containerRef.current?.querySelector<HTMLInputElement>('input[type="search"]') ?? null

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const count = countRef.current
      const active = activeIndexRef.current
      const search = searchInput()

      // ↓ in this page's search input hands the keyboard to the list.
      if (search !== null && event.target === search) {
        if (event.key === "ArrowDown" && count > 0) {
          event.preventDefault()
          search.blur()
          setActiveIndex(0)
        }
        return
      }
      if (isTypingTarget(event.target)) return

      switch (event.key) {
        case "ArrowDown":
          if (count === 0) return
          event.preventDefault()
          setActiveIndex(active === null ? 0 : Math.min(active + 1, count - 1))
          return
        case "ArrowUp":
          if (count === 0) return
          event.preventDefault()
          setActiveIndex(active === null ? count - 1 : Math.max(active - 1, 0))
          return
        case "Home":
          if (active === null || count === 0) return
          event.preventDefault()
          setActiveIndex(0)
          return
        case "End":
          if (active === null || count === 0) return
          event.preventDefault()
          setActiveIndex(count - 1)
          return
        case "ArrowRight":
          if (active === null || !onExpandRef.current) return
          event.preventDefault()
          onExpandRef.current(active)
          return
        case "ArrowLeft":
          if (active === null || !onCollapseRef.current) return
          event.preventDefault()
          onCollapseRef.current(active)
          return
        case "Enter":
          if (active === null) return
          event.preventDefault()
          onActivateRef.current(active)
          return
        case "Escape":
          if (active === null) return
          event.preventDefault()
          setActiveIndex(null)
          search?.focus()
          return
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [enabled])

  // The highlight follows filtering: a query change puts it back on the first
  // result (or clears it when nothing matches). Never *creates* a highlight.
  const prevResetKey = useRef(resetKey)
  useEffect(() => {
    if (prevResetKey.current === resetKey) return
    prevResetKey.current = resetKey
    setActiveIndex((index) => (index === null ? null : countRef.current > 0 ? 0 : null))
  }, [resetKey])

  // Clamp when the list shrinks under the highlight (load-more, deletions).
  useEffect(() => {
    setActiveIndex((index) =>
      index === null ? null : count === 0 ? null : Math.min(index, count - 1),
    )
  }, [count])

  // Keep the highlighted row on screen — reveal, don't recentre.
  useEffect(() => {
    if (activeIndex === null) return
    const row = containerRef.current?.querySelector<HTMLElement>(
      `[data-list-index="${activeIndex}"]`,
    )
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  // `setActiveIndex` is exposed for tree lists, where `←` on an already-closed
  // child moves the highlight to its parent row.
  return { activeIndex, setActiveIndex, containerRef }
}
