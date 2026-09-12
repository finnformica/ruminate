/**
 * The fold's motion, run on the compositor.
 *
 * Folding or unfolding a block changes the editor's state at once — `rows`,
 * the keyboard's order and the selection never wait — and the motion is
 * laid over that change afterwards, never by animating the layout itself.
 * Animating a height (or a grid track) lays the whole editor out again on
 * every frame, and each row lands on a fresh subpixel boundary as it goes,
 * which is the jitter. Here nothing lays out twice, and everything that
 * moves is a `transform`, which every browser runs on the compositor, off
 * the main thread (the FLIP technique, on the Web Animations API): the
 * rows that moved slide from where they were to where they are, and the
 * subtree's box is revealed or covered by its own bottom edge — the edge
 * alone, no fade, the way an accordion's panel opens and shuts.
 *
 * The edge is two transforms under one clip that never animates: the box
 * is clipped to its own bounds (with slack at the top and sides, so a
 * to-do's chevron beside its checkbox and a heading's hash, which reach
 * beyond their row, are never cut), the box slides up by the covered
 * height and its body slides down by the same, so the rows inside hold
 * still while the box's bottom edge — the cut — sweeps over them. Every
 * moving part is then the same kind of animation on the same thread, so
 * the cut and the rows below agree to the pixel; an animated `clip-path`,
 * which some browsers run on the main thread, would fall behind the rows
 * and let the departing text show through them.
 *
 * A folding box leaves the flow first (`.block-subtree-ghost`,
 * block-editor.css), so the rows below — and whatever follows the editor
 * on the page — are already in their final places, and slide up over it.
 *
 * Where the Web Animations API is missing (tests) nothing animates, and the
 * state change simply shows. Reduced motion swaps the motion for a short
 * fade on the box (it aids comprehension) and drops the slide.
 */

/** The fold's length: how long its ghosts stay, and how long the rows
 * slide. One figure for everything, so the sweep and the slide agree, and
 * the chevron's turn (block-item.tsx) is the same length. An accordion's
 * pace: unhurried enough to follow the edge. */
export const FOLD_MS = 300

/** The fade a reduced-motion fold keeps. */
const FADE_MS = 120

/** The motion's easing, `--ease-in-out` (variables.css) — an accordion's
 * curve, gathering pace then settling — read from the page so the token
 * stays the one source; this is its value, as a fallback. */
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)"

/** How far the box's clip reaches beyond its sides and top. Only the
 * bottom edge is ever a cut. */
const CLIP_SLACK = "64px"

/** The clip a box wears while its edge moves: its own bounds, slack at
 * the top and sides. Static — the transforms move the box under it. */
const BOX_CLIP = `inset(-${CLIP_SLACK} -${CLIP_SLACK} 0 -${CLIP_SLACK})`

/** The rows that may slide: a viewport above or below the screen. Further
 * out nobody sees the slide, and a long note would otherwise pay for
 * hundreds of layers. */
const SLIDE_MARGIN_VIEWPORTS = 1

const SLIDE_ID = "block-fold-slide"
const BOX_ID = "block-fold-box"

/** Where the rows (and the subtree boxes, and what follows the editor)
 * were, by key, before a change. */
export type RowPositions = Map<string, number>

function hasWebAnimations(): boolean {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function"
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

function easing(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue("--ease-in-out")
  return token.trim() || EASE_IN_OUT
}

/**
 * Everything that can move when the editor changes height, with a key to
 * match it up again after: its live rows, its subtree boxes, and whatever
 * follows the editor on the page (each later sibling of the editor and of
 * its ancestors, up to the body — an Unassigned basket beneath a note,
 * say), so a fold near the foot of a note never has the page below jump
 * up over the departing rows.
 */
function movable(container: HTMLElement): [string, HTMLElement][] {
  const out: [string, HTMLElement][] = []
  for (const el of container.querySelectorAll<HTMLElement>("[data-occurrence], [data-subtree]")) {
    const row = el.getAttribute("data-occurrence")
    out.push(row !== null ? [`row:${row}`, el] : [`box:${el.getAttribute("data-subtree")}`, el])
  }
  let node: HTMLElement | null = container
  let index = 0
  while (node && node !== document.body) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next instanceof HTMLElement) out.push([`after:${index++}`, next])
    }
    node = node.parentElement
  }
  return out
}

/**
 * Where everything movable is right now, for `slideRows` after the change.
 * Null when nothing will slide anyway (no Web Animations API, reduced
 * motion), so the measuring is skipped too.
 */
export function measureRows(container: HTMLElement): RowPositions | null {
  if (!hasWebAnimations() || prefersReducedMotion()) return null
  const positions: RowPositions = new Map()
  for (const [key, el] of movable(container)) positions.set(key, el.getBoundingClientRect().top)
  return positions
}

/**
 * FLIP, after the change: everything movable that is somewhere else now —
 * a live row, a box folding away, the page below the editor — slides from
 * where it was, on a `transform` the compositor runs, to rest where it is.
 * What is off screen both before and after just lands. A slide still
 * running from an earlier toggle is dropped first, so the fresh
 * measurement is the element's true place.
 */
export function slideRows(container: HTMLElement, before: RowPositions): void {
  const elements = movable(container)
  for (const [, el] of elements) {
    for (const anim of el.getAnimations()) if (anim.id === SLIDE_ID) anim.cancel()
  }
  const viewport = window.innerHeight || document.documentElement.clientHeight
  const lower = -SLIDE_MARGIN_VIEWPORTS * viewport
  const upper = (1 + SLIDE_MARGIN_VIEWPORTS) * viewport
  const ease = easing()
  for (const [key, el] of elements) {
    const was = before.get(key)
    if (was === undefined) continue
    const now = el.getBoundingClientRect().top
    const delta = was - now
    if (Math.abs(delta) < 0.5) continue
    if ((was < lower || was > upper) && (now < lower || now > upper)) continue
    el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
      id: SLIDE_ID,
      duration: FOLD_MS,
      easing: ease,
    })
  }
}

/** The box animation each box is running, so a finished or cancelled one
 * only tidies up after itself, never after its successor. */
const boxMotion = new WeakMap<HTMLElement, Animation>()

function cancelBox(el: HTMLElement): void {
  for (const anim of el.getAnimations()) if (anim.id === BOX_ID) anim.cancel()
  const body = el.firstElementChild
  if (body) for (const anim of body.getAnimations()) if (anim.id === BOX_ID) anim.cancel()
}

/**
 * Sweep a box's bottom edge: `from` to `to` are how much of the box is
 * covered, in pixels. The box slides up by that and its body down by the
 * same, so the rows hold still under the moving cut; the clip is worn for
 * the sweep and taken off after (a box at rest is never clipped), unless
 * it is held (`fill`), as a ghost is until it goes.
 */
function sweep(el: HTMLElement, from: number, to: number, fill: FillMode | undefined): void {
  const body = el.firstElementChild
  if (!(body instanceof HTMLElement)) return
  cancelBox(el)
  const options = { id: BOX_ID, duration: FOLD_MS, easing: easing(), fill }
  el.style.clipPath = BOX_CLIP
  const anim = el.animate(
    [{ transform: `translateY(${-from}px)` }, { transform: `translateY(${-to}px)` }],
    options,
  )
  body.animate(
    [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }],
    options,
  )
  boxMotion.set(el, anim)
  const done = () => {
    if (boxMotion.get(el) !== anim) return
    boxMotion.delete(el)
    if (fill) return
    el.style.clipPath = ""
    if (!el.getAttribute("style")) el.removeAttribute("style")
  }
  anim.onfinish = done
  anim.oncancel = done
}

/**
 * Unfold a subtree's box that has just appeared: its edge sweeps down from
 * its top to reveal it while the rows below slide down out of its way
 * (`slideRows`). The rows inside are full size from the first frame —
 * only the edge moves.
 */
export function unfoldBox(el: HTMLElement): void {
  if (!hasWebAnimations()) return
  if (prefersReducedMotion()) {
    cancelBox(el)
    el.animate([{ opacity: 0 }, { opacity: 1 }], { id: BOX_ID, duration: FADE_MS, easing: "ease" })
    return
  }
  sweep(el, el.getBoundingClientRect().height, 0, undefined)
}

/**
 * Fold a subtree's box that has just left the flow (a ghost): its edge
 * sweeps up from its bottom to cover it, at exactly the pace the rows
 * below slide up over it, and holds until the ghost goes.
 */
export function foldBox(el: HTMLElement): void {
  if (!hasWebAnimations()) return
  if (prefersReducedMotion()) {
    cancelBox(el)
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      id: BOX_ID,
      duration: FADE_MS,
      easing: "ease",
      fill: "forwards",
    })
    return
  }
  sweep(el, 0, el.getBoundingClientRect().height, "forwards")
}
