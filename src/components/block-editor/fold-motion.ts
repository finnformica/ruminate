/**
 * The fold's motion, run on the compositor.
 *
 * Folding or unfolding a block changes the editor's state at once — `rows`,
 * the keyboard's order and the selection never wait — and the motion is
 * laid over that change afterwards, never by animating the layout itself.
 * Animating a height (or a grid track) lays the whole editor out again on
 * every frame, and each row lands on a fresh subpixel boundary as it goes,
 * which is the jitter. Here nothing lays out twice: the rows that moved
 * slide from where they were to where they are on a `transform`, and the
 * subtree's box is revealed or covered by a `clip-path` with a fade, all of
 * which the compositor runs off the main thread (the FLIP technique, on the
 * Web Animations API). A folding box leaves the flow first
 * (`.block-subtree-ghost`, block-editor.css), so the rows below are already
 * in their final places and the sweep over the departing rows is the rows
 * below sliding up — the clip keeps the departing rows exactly under them.
 *
 * Where the Web Animations API is missing (tests) nothing animates, and the
 * state change simply shows. Reduced motion keeps a short fade on the box
 * (it aids comprehension) and drops the slide and the sweep.
 */

/** The fold's length: how long its ghosts stay, and how long the rows
 * slide. One figure for everything, so the sweep and the slide agree. */
export const FOLD_MS = 200

/** The fade a reduced-motion fold keeps. */
const FADE_MS = 120

/** The motion's easing, `--ease-out-strong` (variables.css), read from the
 * page so the token stays the one source; this is its value, as a
 * fallback. */
const EASE_OUT_STRONG = "cubic-bezier(0.23, 1, 0.32, 1)"

/** How far a `clip-path` reaches beyond the box's sides and top, so a to-do's
 * chevron beside its checkbox (in the row's margin) or a heading's hash,
 * both of which reach beyond their row, are never cut during the sweep.
 * Only the bottom edge moves. */
const CLIP_SLACK = "64px"

/** The rows that may slide: a viewport above or below the screen. Further
 * out nobody sees the slide, and a long note would otherwise pay for
 * hundreds of layers. */
const SLIDE_MARGIN_VIEWPORTS = 1

const SLIDE_ID = "block-fold-slide"
const BOX_ID = "block-fold-box"

/** Where the rows (and the subtree boxes) were, by key, before a change. */
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
  const token = getComputedStyle(document.documentElement).getPropertyValue("--ease-out-strong")
  return token.trim() || EASE_OUT_STRONG
}

/** The key a measured element is filed under: a row's occurrence, or a
 * subtree box's parent occurrence. */
function keyOf(el: Element): string | null {
  const row = el.getAttribute("data-occurrence")
  if (row !== null) return `row:${row}`
  const box = el.getAttribute("data-subtree")
  if (box !== null) return `box:${box}`
  return null
}

/**
 * Where every live row and subtree box is right now, for `slideRows` after
 * the change. Null when nothing will slide anyway (no Web Animations API,
 * reduced motion), so the measuring is skipped too.
 */
export function measureRows(container: HTMLElement): RowPositions | null {
  if (!hasWebAnimations() || prefersReducedMotion()) return null
  const positions: RowPositions = new Map()
  for (const el of container.querySelectorAll("[data-occurrence], [data-subtree]")) {
    const key = keyOf(el)
    if (key !== null) positions.set(key, el.getBoundingClientRect().top)
  }
  return positions
}

/**
 * FLIP, after the change: every live row — and every box folding away —
 * that is somewhere else now slides from where it was, on a `transform`
 * the compositor runs, to rest where it is. Rows off screen both before
 * and after just land. A slide still running from an earlier toggle is
 * dropped first, so the fresh measurement is the row's true place.
 */
export function slideRows(container: HTMLElement, before: RowPositions): void {
  const elements = container.querySelectorAll<HTMLElement>("[data-occurrence], [data-folding]")
  for (const el of elements) {
    for (const anim of el.getAnimations()) if (anim.id === SLIDE_ID) anim.cancel()
  }
  const viewport = window.innerHeight || document.documentElement.clientHeight
  const lower = -SLIDE_MARGIN_VIEWPORTS * viewport
  const upper = (1 + SLIDE_MARGIN_VIEWPORTS) * viewport
  const ease = easing()
  for (const el of elements) {
    const key = keyOf(el)
    if (key === null) continue
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

/** A box's clip, open (`bottom` 0) or closed (`bottom` 100%): the sides and
 * top are slack, so only the bottom edge is ever a cut. */
function clip(bottom: string): string {
  return `inset(-${CLIP_SLACK} -${CLIP_SLACK} ${bottom} -${CLIP_SLACK})`
}

function cancelBox(el: HTMLElement): void {
  for (const anim of el.getAnimations()) if (anim.id === BOX_ID) anim.cancel()
}

/**
 * Unfold a subtree's box that has just appeared: revealed from its top
 * down, fading in, while the rows below slide down out of its way
 * (`slideRows`). The rows inside are full size from the first frame —
 * only the edge moves.
 */
export function unfoldBox(el: HTMLElement): void {
  if (!hasWebAnimations()) return
  cancelBox(el)
  if (prefersReducedMotion()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { id: BOX_ID, duration: FADE_MS, easing: "ease" })
    return
  }
  el.animate(
    [
      { clipPath: clip("100%"), opacity: 0 },
      { clipPath: clip("0%"), opacity: 1 },
    ],
    { id: BOX_ID, duration: FOLD_MS, easing: easing() },
  )
}

/**
 * Fold a subtree's box that has just left the flow (a ghost): covered from
 * its bottom up, fading out, at exactly the pace the rows below slide up
 * over it, and held covered until the ghost goes (`fill: forwards`).
 */
export function foldBox(el: HTMLElement): void {
  if (!hasWebAnimations()) return
  cancelBox(el)
  if (prefersReducedMotion()) {
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      id: BOX_ID,
      duration: FADE_MS,
      easing: "ease",
      fill: "forwards",
    })
    return
  }
  el.animate(
    [
      { clipPath: clip("0%"), opacity: 1 },
      { clipPath: clip("100%"), opacity: 0 },
    ],
    { id: BOX_ID, duration: FOLD_MS, easing: easing(), fill: "forwards" },
  )
}
