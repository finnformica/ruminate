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
 * A fold leaves a ghost of the box in its place — a clone of its DOM,
 * outside React, out of the flow (`.block-subtree-ghost`,
 * block-editor.css) — so the rows below, and whatever follows the editor
 * on the page, are already in their final places and slide up over it.
 * Everything starts together, after the change has been laid out
 * (`settleFold`): the state may take its time to commit (on a long note,
 * or through the store), and a ghost swept from the moment it was made
 * would be half covered before the rows below so much as moved, then
 * measured mid-sweep and slid back down over them.
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

/** How long past the fold a ghost stays before it is taken down: the sweep
 * has covered it by then and holds (`fill: forwards`), so the removal, a
 * DOM change that lays out, never lands mid-motion. */
const GHOST_GRACE_MS = 50

/** A ghost whose fold never settles (the change never committed) is taken
 * down anyway, after this. */
const GHOST_ORPHAN_MS = 3000

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

/** The token's value, read once: reading a computed style forces a style
 * pass over everything dirty, which right after a ghost is added is the
 * ghost's every row. `measureRows` warms it while the page is still clean. */
let cachedEasing: string | null = null

function easing(): string {
  if (cachedEasing === null) {
    const token = getComputedStyle(document.documentElement).getPropertyValue("--ease-in-out")
    cachedEasing = token.trim() || EASE_IN_OUT
  }
  return cachedEasing
}

/** The key an element is measured under: a row's occurrence, or a
 * subtree box's parent occurrence. */
function keyOf(el: HTMLElement): string {
  const row = el.getAttribute("data-occurrence")
  return row !== null ? `row:${row}` : `box:${el.getAttribute("data-subtree")}`
}

/**
 * Whatever follows the editor on the page — each later sibling of the
 * editor and of its ancestors, up to the body (an Unassigned basket
 * beneath a note, say) — so a fold near the foot of a note never has the
 * page below jump up over the departing rows.
 */
function followers(container: HTMLElement): [string, HTMLElement][] {
  const out: [string, HTMLElement][] = []
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
 * Everything that can move when the editor changes height, with a key to
 * match it up again after: every live row, every subtree box, and the
 * page below the editor. Measured before a change, when it is not yet
 * known which of them will slide as one.
 */
function movable(container: HTMLElement): [string, HTMLElement][] {
  const out: [string, HTMLElement][] = []
  for (const el of container.querySelectorAll<HTMLElement>("[data-occurrence], [data-subtree]")) {
    if (!el.hasAttribute("data-folding")) out.push([keyOf(el), el])
  }
  return out.concat(followers(container))
}

/**
 * What slides after a change, each once: the units. A subtree box that
 * was there before and does not hold the change — a ghost, or the box
 * just unfolded — moves rigidly, so it is one unit and its rows are left
 * to it; a box that holds the change is walked into, and its rows and
 * its boxes are the units. A ghost is no unit: its sweep carries its
 * own shift (`settleFold`), and a slide on top would replace the sweep
 * outright. Sliding a box and the rows inside it both would carry those
 * rows twice the distance: an unrelated nest below the fold would set off
 * from the top of the screen.
 */
function units(container: HTMLElement, before: RowPositions): [string, HTMLElement][] {
  const changed = Array.from(container.querySelectorAll<HTMLElement>("[data-subtree]")).filter(
    (box) => box.hasAttribute("data-folding") || !before.has(keyOf(box)),
  )
  const out: [string, HTMLElement][] = []
  const walk = (el: Element) => {
    for (const child of el.children) {
      if (!(child instanceof HTMLElement)) continue
      if (child.hasAttribute("data-folding")) continue
      if (child.hasAttribute("data-occurrence")) {
        out.push([keyOf(child), child])
      } else if (child.hasAttribute("data-subtree")) {
        const rigid = before.has(keyOf(child)) && !changed.some((box) => child.contains(box))
        if (rigid) out.push([keyOf(child), child])
        else walk(child)
      } else {
        walk(child)
      }
    }
  }
  walk(container)
  return out.concat(followers(container))
}

/**
 * Where everything movable is right now, for `settleFold` after the
 * change. Null when nothing will slide anyway (no Web Animations API,
 * reduced motion), so the measuring is skipped too.
 */
export function measureRows(container: HTMLElement): RowPositions | null {
  if (!hasWebAnimations() || prefersReducedMotion()) return null
  easing()
  const positions: RowPositions = new Map()
  for (const [key, el] of movable(container)) positions.set(key, el.getBoundingClientRect().top)
  return positions
}

/** The slides the last toggle started, to drop before measuring again. */
let slides: Animation[] = []

/** The ghosts made since the last settle, each with the height of the box
 * it stands for, waiting for the change to land so their sweep can start
 * with everything else. */
let pendingGhosts: { ghost: HTMLElement; height: number; key: string }[] = []

/**
 * Settle a toggle once the change has been laid out (a layout effect,
 * before paint), FLIP-fashion: every unit (`units`) that is somewhere else
 * now — a live row, a nest that moved as one, the page below the editor —
 * slides from where it was, on a `transform` the compositor runs, to rest
 * where it is; and every ghost made for the toggle starts its sweep, its
 * rows setting off where the box was and ending up under their parent,
 * wherever that has gone. What is off screen
 * both before and after just lands. A slide still running from an
 * earlier toggle is dropped first, so the fresh measurement is the
 * element's true place. `before` is null when nothing slides (no Web
 * Animations API, reduced motion): the ghosts still fade, or just go.
 *
 * Every read comes before every write: starting an animation dirties its
 * element's style, and a measurement after that lays the page out again —
 * once per row, on a long note, which is the difference between a few
 * milliseconds and a frozen frame.
 */
export function settleFold(container: HTMLElement, before: RowPositions | null): void {
  for (const anim of slides) anim.cancel()
  slides = []
  const ghosts = pendingGhosts.filter((g) => container.contains(g.ghost))
  pendingGhosts = []
  const moves: [HTMLElement, number][] = []
  const shifts: [number, number][] = []
  if (before) {
    const viewport = window.innerHeight || document.documentElement.clientHeight
    const lower = -SLIDE_MARGIN_VIEWPORTS * viewport
    const upper = (1 + SLIDE_MARGIN_VIEWPORTS) * viewport
    for (const [key, el] of units(container, before)) {
      const was = before.get(key)
      if (was === undefined) continue
      const rect = el.getBoundingClientRect()
      const delta = was - rect.top
      if (Math.abs(delta) < 0.5) continue
      // Off screen both before and after, top to bottom (a tall nest can
      // start a long way above what it shows): it just lands.
      const offBefore = was + rect.height < lower || was > upper
      const offAfter = rect.bottom < lower || rect.top > upper
      if (offBefore && offAfter) continue
      moves.push([el, delta])
    }
    for (const { ghost, key } of ghosts) {
      // The rows set off where the box was and end up under their parent,
      // wherever it has gone (the page shortened and the scroll clamped,
      // say); the ghost's own place is neither — out of the flow, a margin
      // that collapsed through the box no longer does.
      const was = before.get(key)
      const now = ghost.getBoundingClientRect().top
      const parent = ghost.previousElementSibling
      const parentWas =
        parent instanceof HTMLElement && parent.hasAttribute("data-occurrence")
          ? before.get(keyOf(parent))
          : undefined
      const parentMoved =
        parent && parentWas !== undefined ? parentWas - parent.getBoundingClientRect().top : 0
      shifts.push(was === undefined ? [0, 0] : [was - now, was - parentMoved - now])
    }
  }
  const ease = easing()
  ghosts.forEach(({ ghost, height }, i) => {
    const [start, end] = shifts[i] ?? [0, 0]
    foldBox(ghost, height, start, end)
    window.setTimeout(() => ghost.remove(), FOLD_MS + GHOST_GRACE_MS)
  })
  for (const [el, delta] of moves) {
    slides.push(
      el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
        id: SLIDE_ID,
        duration: FOLD_MS,
        easing: ease,
      }),
    )
  }
}

/** The animations each box is running (its own and its body's), so a
 * later sweep can drop them without asking the DOM — `getAnimations` on a
 * ghost just added to the page would lay the whole page out for it there
 * and then — and so a finished or cancelled sweep only tidies up after
 * itself, never after its successor. */
const boxMotion = new WeakMap<HTMLElement, Animation[]>()

function cancelBox(el: HTMLElement): void {
  for (const anim of boxMotion.get(el) ?? []) anim.cancel()
  boxMotion.delete(el)
}

/** Take an inline property off, and the attribute with it once empty, so
 * an element at rest carries no trace of the sweep. */
function unset(el: HTMLElement, property: "clipPath" | "pointerEvents"): void {
  el.style[property] = ""
  if (!el.getAttribute("style")) el.removeAttribute("style")
}

/**
 * Sweep a box's bottom edge: `from` to `to` are how much of the box is
 * covered, in pixels. The box slides up by that and its body down by the
 * same, so the rows hold still under the moving cut; the clip is worn for
 * the sweep and taken off after (a box at rest is never clipped), unless
 * it is held (`fill`), as a ghost is until it goes. `startShift` and
 * `endShift` set the box off the place it is laid out, at the start and
 * at the end, carried by the box alone (its body does not follow): a
 * ghost's rows set off where the box was and end up under their parent.
 *
 * While it moves, the box itself is nothing to the pointer: slid up by the
 * covered height, its clipped area lies over the rows above it — over the
 * chevron that was just clicked — and would take the hover from them, so
 * the chevron fades out and the key fades in until the browser looks
 * again. Its body, which stays where the rows are, keeps the pointer.
 */
function sweep(
  el: HTMLElement,
  from: number,
  to: number,
  fill: FillMode | undefined,
  startShift = 0,
  endShift = startShift,
): void {
  const body = el.firstElementChild
  if (!(body instanceof HTMLElement)) return
  cancelBox(el)
  const options = { id: BOX_ID, duration: FOLD_MS, easing: easing(), fill }
  el.style.clipPath = BOX_CLIP
  el.style.pointerEvents = "none"
  body.style.pointerEvents = "auto"
  const anim = el.animate(
    [
      { transform: `translateY(${startShift - from}px)` },
      { transform: `translateY(${endShift - to}px)` },
    ],
    options,
  )
  const bodyAnim = body.animate(
    [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }],
    options,
  )
  const running = [anim, bodyAnim]
  boxMotion.set(el, running)
  const done = () => {
    if (boxMotion.get(el) !== running) return
    boxMotion.delete(el)
    if (fill) return
    unset(el, "clipPath")
    unset(el, "pointerEvents")
    unset(body, "pointerEvents")
  }
  anim.onfinish = done
  anim.oncancel = done
}

/**
 * Unfold a subtree's box that has just appeared: its edge sweeps down from
 * its top to reveal it while the rows below slide down out of its way
 * (`settleFold`). The rows inside are full size from the first frame —
 * only the edge moves.
 */
export function unfoldBox(el: HTMLElement): void {
  if (!hasWebAnimations()) return
  if (prefersReducedMotion()) {
    cancelBox(el)
    boxMotion.set(el, [
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        id: BOX_ID,
        duration: FADE_MS,
        easing: "ease",
      }),
    ])
    return
  }
  sweep(el, el.getBoundingClientRect().height, 0, undefined)
}

/**
 * Fold a subtree's box that has just left the flow (a ghost): its edge
 * sweeps up from its bottom to cover it, at exactly the pace the rows
 * below slide up over it, and holds until the ghost goes. `height` is the
 * box's, as the fold found it (measuring a ghost would lay the whole page
 * out for it there and then); `startShift` and `endShift` set the box off
 * its place, so its rows set off where the box was and end up under their
 * parent (`settleFold`).
 */
export function foldBox(
  el: HTMLElement,
  height: number,
  startShift = 0,
  endShift = startShift,
): void {
  if (!hasWebAnimations()) return
  if (prefersReducedMotion()) {
    cancelBox(el)
    boxMotion.set(el, [
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        id: BOX_ID,
        duration: FADE_MS,
        easing: "ease",
        fill: "forwards",
      }),
    ])
    return
  }
  sweep(el, 0, height, "forwards", startShift, endShift)
}

/**
 * Leave a ghost of a subtree's box that is about to fold away, without a
 * render: a plain clone of its DOM, outside React, in the box's place,
 * out of the flow at the box's size (`.block-subtree-ghost`,
 * block-editor.css), inert. Cloning is cheap next to rendering the rows
 * again, twice (into a ghost, then out), which for a large nest was most
 * of the fold's cost. Nothing in the ghost is a row: it carries no row
 * identity, no ids, and no subtree of its own, so nothing addresses or
 * measures it but the ghost itself, which keeps the box's key so its
 * sweep can follow its parent. The sweep starts when the change has
 * landed (`settleFold`), with everything else.
 *
 * In the flow, the first row's top margin (a heading's) collapses through
 * the box, which starts below it; out of the flow it cannot, and would
 * push the ghost's rows down by that much. The ghost's copy of that row
 * has no top margin.
 */
export function ghostFold(box: HTMLElement): void {
  const rect = box.getBoundingClientRect()
  const ghost = box.cloneNode(true) as HTMLElement
  for (const el of ghost.querySelectorAll("[data-folding]")) el.remove()
  for (const el of ghost.querySelectorAll(
    "[data-occurrence], [data-block-row], [data-subtree], [id]",
  )) {
    el.removeAttribute("data-occurrence")
    el.removeAttribute("data-block-row")
    el.removeAttribute("data-subtree")
    el.removeAttribute("id")
  }
  const firstRow = ghost.firstElementChild?.firstElementChild
  if (firstRow instanceof HTMLElement) firstRow.style.marginTop = "0"
  ghost.setAttribute("data-folding", "true")
  ghost.setAttribute("aria-hidden", "true")
  ghost.setAttribute("inert", "")
  ghost.className = "block-subtree-ghost"
  if (rect.height > 0) {
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
  }
  box.after(ghost)
  pendingGhosts.push({ ghost, height: rect.height, key: keyOf(box) })
  window.setTimeout(() => {
    if (pendingGhosts.some((g) => g.ghost === ghost)) {
      pendingGhosts = pendingGhosts.filter((g) => g.ghost !== ghost)
      ghost.remove()
    }
  }, GHOST_ORPHAN_MS)
}

/** Take down the ghost of a subtree that is unfolding again mid-fold, so
 * the returning rows never meet it. */
export function dropGhost(container: HTMLElement, parentKey: string): void {
  container.querySelector(`[data-folding][data-subtree="${parentKey}"]`)?.remove()
}
