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
