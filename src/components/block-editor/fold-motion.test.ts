// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FOLD_MS, foldBox, measureRows, slideRows, unfoldBox } from "./fold-motion"

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions }

/** jsdom has no Web Animations API: stand one in that records its calls and
 * hands back cancellable animations. */
function stubAnimations() {
  const calls = new Map<Element, Call[]>()
  const running = new Map<Element, { id: string; cancel: () => void }[]>()
  Element.prototype.animate = function (this: Element, keyframes, options) {
    const list = calls.get(this) ?? []
    list.push({ keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions })
    calls.set(this, list)
    const anim = {
      id: (options as KeyframeAnimationOptions).id ?? "",
      cancel: () =>
        running.set(
          this,
          (running.get(this) ?? []).filter((a) => a !== anim),
        ),
    }
    running.set(this, [...(running.get(this) ?? []), anim])
    return anim as unknown as Animation
  }
  Element.prototype.getAnimations = function (this: Element) {
    return (running.get(this) ?? []) as unknown as Animation[]
  }
  return { calls, running }
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

  it("reveals a box from the top and covers it from the bottom, only the bottom edge ever cutting", () => {
    const { calls } = stubAnimations()
    const box = document.createElement("div")
    unfoldBox(box)
    foldBox(box)
    const [open, close] = calls.get(box)!
    expect(open.keyframes[0]).toEqual({ clipPath: "inset(-64px -64px 100% -64px)" })
    expect(open.keyframes[1]).toEqual({ clipPath: "inset(-64px -64px 0% -64px)" })
    expect(open.options.fill).toBeUndefined()
    expect(close.keyframes[0]).toEqual({ clipPath: "inset(-64px -64px 0% -64px)" })
    expect(close.keyframes[1]).toEqual({ clipPath: "inset(-64px -64px 100% -64px)" })
    // A ghost stays covered until it goes.
    expect(close.options.fill).toBe("forwards")
    expect(open.options.duration).toBe(FOLD_MS)
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
