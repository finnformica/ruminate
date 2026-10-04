import { useEffect, useRef, useState } from "react"

/**
 * Whether an element is on screen, by an IntersectionObserver on it: a
 * page can offer something else once what the element holds has scrolled
 * away (the board's add buttons, `add-images.tsx`). Starts true, so
 * nothing stands in for the element before it has been measured, and
 * stays true where there is no observer (jsdom).
 */
export function useInView<T extends Element>(): {
  ref: React.RefObject<T>
  inView: boolean
} {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, inView }
}

/**
 * Whether an element has come within `margin` of the screen — once: a
 * thing that loads itself when it is about to be seen (a board's tile,
 * `board-picture.tsx`) and need not unload when it scrolls away again.
 * Starts false where there is an observer, so nothing is fetched for what
 * is far down the page, and true where there is none (jsdom), so
 * everything loads as before.
 *
 * The observer's root is the element's own scroll container, not the
 * viewport: an element scrolled out of an inner container is clipped by it
 * whatever margin the viewport is given, so a margin only reaches past the
 * fold when it is the container's.
 */
export function useNearView<T extends Element>(
  margin: string,
): {
  /** A callback ref: the element may mount after the first render (a
   * tile that was drawing its upload, then had an asset to fetch). */
  ref: (element: T | null) => void
  near: boolean
} {
  const [element, setElement] = useState<T | null>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    if (near || !element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setNear(true)
        observer.disconnect()
      },
      { root: scrollParentOf(element), rootMargin: margin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [near, element, margin])
  return { ref: setElement, near }
}

/** The nearest ancestor that scrolls, or null for the viewport. */
function scrollParentOf(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
  }
  return null
}
