// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FOLD_MS, foldBox, measureRows, slideRows, unfoldBox } from "./fold-motion"

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions }

/** jsdom has no Web Animations API: stand one in that records its calls and
 * hands back cancellable animations. */
type Stub = { id: string; cancel: () => void; onfinish?: () => void; oncancel?: () => void }

function stubAnimations() {
  const calls = new Map<Element, Call[]>()
  const running = new Map<Element, Stub[]>()
  const animations = new Map<Element, Stub[]>()
  Element.prototype.animate = function (this: Element, keyframes, options) {
    const list = calls.get(this) ?? []
    list.push({ keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions })
    calls.set(this, list)
    const anim: Stub = {
      id: (options as KeyframeAnimationOptions).id ?? "",
      cancel: () =>
        running.set(
          this,
          (running.get(this) ?? []).filter((a) => a !== anim),
        ),
    }
    running.set(this, [...(running.get(this) ?? []), anim])
    animations.set(this, [...(animations.get(this) ?? []), anim])
    return anim as unknown as Animation
  }
  Element.prototype.getAnimations = function (this: Element) {
    return (running.get(this) ?? []) as unknown as Animation[]
  }
  return { calls, running, animations }
}

/** A row at a given top, whose place can be moved between measurements. */
function rowAt(container: HTMLElement, key: string, top: number, attr = "data-occurrence") {
  const el = document.createElement("div")
  el.setAttribute(attr, key)
  el.getBoundingClientRect = () => ({ top, height: 24 }) as DOMRect
  container.appendChild(el)
  return {
    el,
    moveTo: (next: number) => (el.getBoundingClientRect = () => ({ top: next }) as DOMRect),
  }
}

describe("fold motion", () => {
  const originalAnimate = Element.prototype.animate
  const originalGetAnimations = Element.prototype.getAnimations
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true })
  })
  afterEach(() => {
    Element.prototype.animate = originalAnimate
    Element.prototype.getAnimations = originalGetAnimations
  })

  it("without the Web Animations API nothing is measured and nothing animates", () => {
    // @ts-expect-error jsdom ships without it; make sure of that.
    delete Element.prototype.animate
    const container = document.createElement("div")
    rowAt(container, "a", 10)
    expect(measureRows(container)).toBeNull()
    expect(() => unfoldBox(container)).not.toThrow()
    expect(() => foldBox(container)).not.toThrow()
  })

  it("slides the rows that moved from where they were to where they are, and no other", () => {
    const { calls } = stubAnimations()
    const container = document.createElement("div")
    const still = rowAt(container, "a", 10)
    const moved = rowAt(container, "b", 700)
    const fresh = document.createElement("div")
    const before = measureRows(container)!
    expect(before.get("row:b")).toBe(700)
    moved.moveTo(100)
    fresh.setAttribute("data-occurrence", "c")
    fresh.getBoundingClientRect = () => ({ top: 124 }) as DOMRect
    container.appendChild(fresh)
    slideRows(container, before)
    expect(calls.has(still.el)).toBe(false)
    // A row that was not there before has nowhere to slide from.
    expect(calls.has(fresh)).toBe(false)
    const [slide] = calls.get(moved.el)!
    expect(slide.keyframes).toEqual([{ transform: "translateY(600px)" }, { transform: "none" }])
    expect(slide.options.duration).toBe(FOLD_MS)
  })

  it("lets a row off screen both before and after just land", () => {
    const { calls } = stubAnimations()
    const container = document.createElement("div")
    const far = rowAt(container, "a", 5000)
    const before = measureRows(container)!
    far.moveTo(4400)
    slideRows(container, before)
    expect(calls.has(far.el)).toBe(false)
  })

  it("a ghost box slides with its parent, by the box's own key", () => {
    const { calls } = stubAnimations()
    const container = document.createElement("div")
    const box = rowAt(container, "p", 300, "data-subtree")
    const before = measureRows(container)!
    expect(before.get("box:p")).toBe(300)
    box.el.setAttribute("data-folding", "true")
    box.moveTo(250)
    slideRows(container, before)
    expect(calls.get(box.el)![0].keyframes[0]).toEqual({ transform: "translateY(50px)" })
  })

  it("drops a slide still running before measuring again", () => {
    const { running } = stubAnimations()
    const container = document.createElement("div")
    const row = rowAt(container, "a", 500)
    const before = measureRows(container)!
    row.moveTo(100)
    slideRows(container, before)
    expect(running.get(row.el)!.length).toBe(1)
    row.moveTo(500)
    slideRows(container, new Map([["row:a", 100]]))
    // The first slide was cancelled; only the new one runs.
    expect(running.get(row.el)!.length).toBe(1)
  })

  it("sweeps a box's edge with two transforms under one static clip: nothing that lays out or paints", () => {
    const { calls, animations } = stubAnimations()
    const box = document.createElement("div")
    const body = document.createElement("div")
    box.appendChild(body)
    box.getBoundingClientRect = () => ({ height: 200 }) as DOMRect
    unfoldBox(box)
    const [open] = calls.get(box)!
    const [openBody] = calls.get(body)!
    // The box slides up by the covered height and its body down by the
    // same, so the rows hold still under the moving cut.
    expect(open.keyframes).toEqual([
      { transform: "translateY(-200px)" },
      { transform: "translateY(0px)" },
    ])
    expect(openBody.keyframes).toEqual([
      { transform: "translateY(200px)" },
      { transform: "translateY(0px)" },
    ])
    expect(open.options.duration).toBe(FOLD_MS)
    expect(open.options.fill).toBeUndefined()
    // The clip is worn for the sweep (the sides and top slack), then taken off.
    expect(box.style.clipPath).toBe("inset(-64px -64px 0 -64px)")
    animations.get(box)![0].onfinish?.()
    expect(box.hasAttribute("style")).toBe(false)
  })

  it("a ghost keeps its cover until it goes", () => {
    const { calls, animations } = stubAnimations()
    const box = document.createElement("div")
    box.appendChild(document.createElement("div"))
    box.getBoundingClientRect = () => ({ height: 120 }) as DOMRect
    foldBox(box)
    const [close] = calls.get(box)!
    expect(close.keyframes).toEqual([
      { transform: "translateY(0px)" },
      { transform: "translateY(-120px)" },
    ])
    expect(close.options.fill).toBe("forwards")
    animations.get(box)![0].onfinish?.()
    expect(box.style.clipPath).toBe("inset(-64px -64px 0 -64px)")
  })

  it("a sweep cut short by its successor never tidies up after it", () => {
    const { animations } = stubAnimations()
    const box = document.createElement("div")
    box.appendChild(document.createElement("div"))
    box.getBoundingClientRect = () => ({ height: 120 }) as DOMRect
    foldBox(box)
    const first = animations.get(box)![0]
    unfoldBox(box)
    // The fold was cancelled by the unfold; its late cancel event must not
    // strip the clip the unfold is wearing.
    first.oncancel?.()
    expect(box.style.clipPath).toBe("inset(-64px -64px 0 -64px)")
  })

  it("slides what follows the editor on the page along with the rows", () => {
    const { calls } = stubAnimations()
    const page = document.createElement("div")
    document.body.appendChild(page)
    const container = document.createElement("div")
    page.appendChild(container)
    const basket = document.createElement("section")
    basket.getBoundingClientRect = () => ({ top: 900 }) as DOMRect
    page.appendChild(basket)
    const before = measureRows(container)!
    expect(before.get("after:0")).toBe(900)
    basket.getBoundingClientRect = () => ({ top: 300 }) as DOMRect
    slideRows(container, before)
    expect(calls.get(basket)![0].keyframes[0]).toEqual({ transform: "translateY(600px)" })
    page.remove()
  })

  it("with reduced motion swaps the motion for a fade on the box and drops the slide", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia
    const { calls } = stubAnimations()
    const container = document.createElement("div")
    rowAt(container, "a", 10)
    expect(measureRows(container)).toBeNull()
    const box = document.createElement("div")
    unfoldBox(box)
    foldBox(box)
    const [open, close] = calls.get(box)!
    expect(open.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(close.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }])
    expect(close.options.fill).toBe("forwards")
  })
})
