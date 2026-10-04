// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useNearView } from "./in-view"

/** Just enough of IntersectionObserver to be told what it watches and to
 * answer for it: `intersect(element)` plays the element coming into view. */
class FakeObserver {
  static instances: FakeObserver[] = []
  readonly watched = new Set<Element>()
  disconnected = false
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.instances.push(this)
  }
  observe(element: Element) {
    this.watched.add(element)
  }
  disconnect() {
    this.disconnected = true
  }
  unobserve() {}
  takeRecords() {
    return []
  }
  intersect(element: Element, isIntersecting = true) {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function Tile() {
  const { ref, near } = useNearView<HTMLDivElement>("100% 0px")
  return <div ref={ref} data-testid="tile" data-near={near} />
}

describe("useNearView", () => {
  const hadObserver = "IntersectionObserver" in globalThis
  beforeEach(() => {
    FakeObserver.instances = []
    vi.stubGlobal("IntersectionObserver", FakeObserver)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (!hadObserver) delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  })

  it("is not near until the observer says so, then stays near and stops watching", () => {
    render(<Tile />)
    const tile = screen.getByTestId("tile")
    expect(tile.dataset.near).toBe("false")
    const [observer] = FakeObserver.instances
    expect(observer.watched.has(tile)).toBe(true)
    expect(observer.options?.rootMargin).toBe("100% 0px")

    act(() => observer.intersect(tile, false))
    expect(tile.dataset.near).toBe("false")
    act(() => observer.intersect(tile))
    expect(tile.dataset.near).toBe("true")
    expect(observer.disconnected).toBe(true)

    // Once near, always near: nothing is watched again.
    act(() => observer.intersect(tile, false))
    expect(tile.dataset.near).toBe("true")
    expect(FakeObserver.instances).toHaveLength(1)
  })

  it("watches from the element's own scroll container", () => {
    render(
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <div>
          <Tile />
        </div>
      </div>,
    )
    expect(FakeObserver.instances[0].options?.root).toBe(screen.getByTestId("scroller"))
  })

  it("is near from the start where there is no observer", () => {
    vi.unstubAllGlobals()
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    render(<Tile />)
    expect(screen.getByTestId("tile").dataset.near).toBe("true")
  })
})
