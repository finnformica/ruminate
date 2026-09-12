// The fold's motion, end to end, in a real browser over the Storybook build:
// frame-by-frame checks of what the unit tests cannot see — where things
// actually are on screen while a subtree folds or unfolds. Each check names
// a regression that has happened once.
//
//   node e2e/fold-motion.e2e.mjs        (npm run test:fold builds and serves Storybook first)
//
// The stories: BlockEditor/FoldMotion (a long note with a large nest, a
// nested bullet below it and rows below that), FoldMotionDeferred (the same
// note, each fold committed 150ms after the click, as the app's store-backed
// folds land on a long note), DeepHeadings and NestedTodo.
import { chromium } from "playwright"

const BASE = process.env.FOLD_BASE_URL || "http://127.0.0.1:6012/iframe.html"
const results = []
const check = (name, ok, extra = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`)
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
})
const context = await browser.newContext({
  viewport: { width: 760, height: 900 },
  serviceWorkers: "block",
})
const page = await context.newPage()

async function story(id) {
  await page.goto(`${BASE}?id=${id}&viewMode=story&globals=theme:light`, {
    waitUntil: "domcontentloaded",
  })
  await page.getByTestId("block-body").first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(300)
}

/** The row whose body reads exactly `text`. */
const row = (text) =>
  page
    .locator("[data-occurrence]", {
      has: page.locator('[data-testid="block-body"]', { hasText: text }),
    })
    .first()

/** Hover a parent's marker (so its chevron shows) and click the chevron. */
async function clickToggle(text) {
  const r = row(text)
  await r.locator(".block-toggle-slot, .block-toggle-beside").first().hover({ force: true })
  await page.waitForTimeout(120)
  await r.locator(".block-toggle").click({ force: true })
}

/**
 * Click a parent's chevron and record, every animation frame for `ms`, the
 * viewport-relative tops of the named rows (a ghost's rows by their text
 * too), the ghost's cut (its box's transformed bottom edge) and its
 * transform. `texts` are looked up each frame, live rows and ghost rows
 * alike.
 */
async function record(text, texts, ms = 480) {
  const r = row(text)
  await r.locator(".block-toggle-slot, .block-toggle-beside").first().hover({ force: true })
  await page.waitForTimeout(120)
  return page.evaluate(
    async ({ text, texts, ms }) => {
      const bodies = () => Array.from(document.querySelectorAll('[data-testid="block-body"]'))
      const byText = (t) =>
        bodies()
          .find((b) => b.textContent.trim() === t)
          ?.closest("[data-block-line]")
      const top = (el) => (el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null)
      const sample = () => {
        const ghost = document.querySelector("[data-folding]")
        const out = { ghost: !!ghost }
        for (const t of texts) out[t] = top(byText(t))
        if (ghost) {
          out.cut = Math.round(ghost.getBoundingClientRect().bottom * 10) / 10
          out.ghostTransform = getComputedStyle(ghost).transform
          out.ghostAnimations = ghost.getAnimations().map((a) => a.id)
        }
        return out
      }
      const parent = Array.from(document.querySelectorAll("[data-occurrence]")).find(
        (r) => r.querySelector('[data-testid="block-body"]')?.textContent.trim() === text,
      )
      const before = sample()
      parent.querySelector(".block-toggle").click()
      const frames = []
      const t0 = performance.now()
      await new Promise((done) => {
        const tick = () => {
          frames.push({ t: Math.round(performance.now() - t0), ...sample() })
          if (performance.now() - t0 < ms) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })
      const editor = parent.closest("[tabindex]") ?? document.body
      const rest = {
        ghosts: document.querySelectorAll("[data-folding]").length,
        styledBoxes: document.querySelectorAll("[data-subtree][style]").length,
        animations: editor.getAnimations({ subtree: true }).filter((a) => /block-fold/.test(a.id))
          .length,
      }
      return { before, frames, rest }
    },
    { text, texts, ms },
  )
}

const maxSpread = (values) => {
  const v = values.filter((x) => typeof x === "number")
  return v.length ? Math.max(...v) - Math.min(...v) : 0
}

// ── A fold covers the departing rows where they are, in step with the row
// below; a nest below moves once, as one ────────────────────────────────────
await story("blockeditor--fold-motion")
{
  const texts = ["Child 0 of the big nest", "Sibling nest", "Inside the sibling nest 0", "Below 0"]
  const { before, frames, rest } = await record("The big nest", texts)
  const ghostFrames = frames.filter((f) => f.ghost)
  check(
    "fold: the ghost is there for the fold",
    ghostFrames.length > 5,
    `${ghostFrames.length} frames`,
  )
  // The departing rows never move: not down (their margin, or a slide laid
  // over the sweep), not up (a slide on the rows themselves).
  const departing = ghostFrames.map((f) => f["Child 0 of the big nest"])
  check(
    "fold: the departing rows hold still under the cut",
    maxSpread([before["Child 0 of the big nest"], ...departing]) <= 1,
    `tops ${before["Child 0 of the big nest"]} → ${departing.join(", ")}`,
  )
  // The cut (the ghost's bottom edge) stays just above the row sliding up
  // behind it, so nothing shows through and nothing is cut early.
  const gaps = ghostFrames.map((f) => f["Sibling nest"] - f.cut)
  check(
    "fold: the cut tracks the row sliding up behind it",
    gaps.every((g) => g >= -1 && g <= 6),
    `row − cut: ${gaps.map((g) => g.toFixed(1)).join(", ")}`,
  )
  // A single sweep on the ghost, never a slide laid over it.
  check(
    "fold: the ghost has one animation, its sweep",
    ghostFrames.every(
      (f) => f.ghostAnimations.length === 1 && f.ghostAnimations[0] === "block-fold-box",
    ),
    ghostFrames.map((f) => f.ghostAnimations.join("+")).join(" "),
  )
  // The nest below sets off from where it was, once (a box and the rows in
  // it slid both would start twice as far away), and lands in place.
  const first = frames[0]
  const last = frames[frames.length - 1]
  check(
    "fold: the nest below sets off from where it was",
    Math.abs(first["Inside the sibling nest 0"] - before["Inside the sibling nest 0"]) <= 1 &&
      Math.abs(first["Below 0"] - before["Below 0"]) <= 1,
    `${before["Inside the sibling nest 0"]} → ${first["Inside the sibling nest 0"]}`,
  )
  check(
    "fold: the rows below slide up to rest",
    last["Sibling nest"] < before["Sibling nest"] - 100 && !last.ghost,
    `${before["Sibling nest"]} → ${last["Sibling nest"]}`,
  )
  check(
    "fold: nothing lingers at rest",
    rest.ghosts === 0 && rest.styledBoxes === 0 && rest.animations === 0,
    JSON.stringify(rest),
  )
}

// ── An unfold reveals the returning rows where they are; the nest below
// sets off from its old place, once ─────────────────────────────────────────
{
  const texts = ["Child 0 of the big nest", "Sibling nest", "Inside the sibling nest 0", "Below 0"]
  const { before, frames, rest } = await record("The big nest", texts)
  const returning = frames.map((f) => f["Child 0 of the big nest"]).filter((x) => x !== null)
  check(
    "unfold: the returning rows hold still under the cut",
    maxSpread(returning) <= 1,
    returning.join(", "),
  )
  const first = frames[0]
  check(
    "unfold: the nest below sets off from where it was",
    Math.abs(first["Inside the sibling nest 0"] - before["Inside the sibling nest 0"]) <= 1,
    `${before["Inside the sibling nest 0"]} → ${first["Inside the sibling nest 0"]}`,
  )
  const last = frames[frames.length - 1]
  check(
    "unfold: the rows below slide down to rest",
    last["Sibling nest"] > before["Sibling nest"] + 100,
    `${before["Sibling nest"]} → ${last["Sibling nest"]}`,
  )
  check(
    "unfold: nothing lingers at rest",
    rest.ghosts === 0 && rest.styledBoxes === 0 && rest.animations === 0,
    JSON.stringify(rest),
  )
}

// ── Unfolding again mid-fold drops the ghost and shows the rows ─────────────
{
  await clickToggle("Sibling nest")
  await page.waitForTimeout(60)
  await clickToggle("Sibling nest")
  await page.waitForTimeout(500)
  const state = await page.evaluate(() => ({
    ghosts: document.querySelectorAll("[data-folding]").length,
    live: !!Array.from(
      document.querySelectorAll("[data-occurrence] [data-testid='block-body']"),
    ).find((b) => b.textContent.trim() === "Inside the sibling nest 0"),
  }))
  check(
    "mid-fold unfold: no ghost, the rows are live",
    state.ghosts === 0 && state.live,
    JSON.stringify(state),
  )
}

// ── The chevron keeps the hover through an unfold ───────────────────────────
{
  await clickToggle("Sibling nest")
  await page.waitForTimeout(500)
  await page.mouse.move(700, 850)
  await page.waitForTimeout(200)
  const r = row("Sibling nest")
  await r.locator(".block-toggle").hover({ force: true })
  await page.waitForTimeout(250)
  const hover = await page.evaluate(async () => {
    const parent = Array.from(document.querySelectorAll("[data-occurrence]")).find(
      (r) => r.querySelector('[data-testid="block-body"]')?.textContent.trim() === "Sibling nest",
    )
    const toggle = parent.querySelector(".block-toggle")
    const sample = () => ({
      hover: toggle.matches(":hover"),
      opacity: getComputedStyle(toggle).opacity,
    })
    const before = sample()
    toggle.click()
    const frames = []
    const t0 = performance.now()
    await new Promise((done) => {
      const tick = () => {
        frames.push(sample())
        if (performance.now() - t0 < 350) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    return {
      before,
      lost: frames.filter((f) => !f.hover || f.opacity !== "1").length,
      frames: frames.length,
    }
  })
  check(
    "unfold: the chevron keeps the hover and stays shown",
    hover.before.hover && hover.lost === 0,
    `hovered before: ${hover.before.hover}, frames lost: ${hover.lost}/${hover.frames}`,
  )
}

// ── A fold committed late (the app's store) still moves everything together
// and never lets the departing rows drift ───────────────────────────────────
await story("blockeditor--fold-motion-deferred")
{
  const texts = ["Child 0 of the big nest", "Sibling nest"]
  const { before, frames, rest } = await record("The big nest", texts, 700)
  // Until the change lands nothing moves: no cut, no slide.
  const early = frames.filter((f) => f.t < 120)
  check(
    "deferred fold: nothing moves before the change lands",
    early.length > 0 &&
      early.every(
        (f) =>
          Math.abs(f["Sibling nest"] - before["Sibling nest"]) <= 1 &&
          (!f.ghost || f.ghostTransform === "none"),
      ),
    early.map((f) => `${f.t}:${f["Sibling nest"]}/${f.ghostTransform ?? "-"}`).join(" "),
  )
  const departing = frames.filter((f) => f.ghost).map((f) => f["Child 0 of the big nest"])
  check(
    "deferred fold: the departing rows never drift",
    maxSpread([before["Child 0 of the big nest"], ...departing]) <= 1,
    `tops ${before["Child 0 of the big nest"]} → ${[...new Set(departing)].join(", ")}`,
  )
  // The cut and the row behind it agree once they move, and the ghost stays
  // until the sweep has covered it.
  const moving = frames.filter((f) => f.ghost && f.ghostTransform !== "none")
  const gaps = moving.map((f) => f["Sibling nest"] - f.cut)
  check(
    "deferred fold: the cut tracks the row behind it",
    moving.length > 5 && gaps.every((g) => g >= -1 && g <= 6),
    `row − cut: ${gaps.map((g) => g.toFixed(1)).join(", ")}`,
  )
  const lastGhost = frames.filter((f) => f.ghost).at(-1)
  const lastMoving = moving.at(-1)
  check(
    "deferred fold: the ghost stays until covered",
    lastGhost &&
      lastMoving &&
      lastGhost.t >= lastMoving.t &&
      lastGhost["Sibling nest"] - before["Child 0 of the big nest"] < 40,
    `ghost until ${lastGhost?.t}ms, still moving at ${lastMoving?.t}ms, row behind at ${lastGhost?.["Sibling nest"]}`,
  )
  check(
    "deferred fold: nothing lingers at rest",
    rest.ghosts === 0 && rest.styledBoxes === 0 && rest.animations === 0,
    JSON.stringify(rest),
  )
}

// ── A heading's top margin never pushes the ghost's rows down ───────────────
await story("blockeditor--deep-headings")
{
  const { before, frames } = await record("Inner bullet", ["Heading under bullets"], 150)
  const tops = frames.filter((f) => f.ghost).map((f) => f["Heading under bullets"])
  check(
    "fold: a heading first in the nest starts where it was",
    tops.length > 0 && maxSpread([before["Heading under bullets"], ...tops]) <= 1,
    `${before["Heading under bullets"]} → ${[...new Set(tops)].join(", ")}`,
  )
}

// ── A to-do parent's beside-chevron survives a fold and unfold ──────────────
await story("blockeditor--nested-todo")
{
  await clickToggle("Parent todo")
  await page.waitForTimeout(450)
  await clickToggle("Parent todo")
  await page.waitForTimeout(500)
  const ok = await page.evaluate(() => {
    const el = document.querySelector(".block-toggle-beside .block-toggle")
    if (!el) return false
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!at && (el === at || el.contains(at))
  })
  check("to-do parent: the beside-chevron is hittable after a fold and unfold", ok)
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
