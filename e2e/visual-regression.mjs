// Visual-regression screenshots over the key Storybook stories.
//
// Modes:
//   node e2e/visual-regression.mjs --check    compare against committed baselines
//   node e2e/visual-regression.mjs --update   rewrite the baselines (CI does this)
//
// Baselines live in e2e/__vr_baselines__/ and are authoritative for the
// platform recorded in baseline-manifest.json (CI: linux-x64). Font rendering
// differs across OSes, so --check on any other platform SKIPS (exit 0) instead
// of producing false failures — developers rely on CI for the real verdict.
// See docs/visual-regression.md.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pixelmatch from "pixelmatch"
import { chromium } from "playwright"
import { PNG } from "pngjs"

const BASE = process.env.VR_BASE_URL || "http://127.0.0.1:6011/iframe.html"
const DIR = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_DIR = path.join(DIR, "__vr_baselines__")
const ARTIFACT_DIR = process.env.VR_ARTIFACT_DIR || path.join(DIR, "__vr_artifacts__")
const MANIFEST = path.join(BASELINE_DIR, "baseline-manifest.json")
const PLATFORM_KEY = `${os.platform()}-${os.arch()}`

// Differing-pixel budget as a fraction of the image. Same-platform Chromium
// renders measured byte-identical across runs, so ANY differing pixel is a
// real change — a 0.02% budget let a genuinely visible change (an ~8px icon
// appearing) pass silently. Loosen per story only with a documented reason
// (e.g. an animated affordance that can't be frozen).
const DEFAULT_MAX_DIFF_RATIO = 0

// The stories under regression. `waitFor` is a selector that must be visible
// before the story counts as rendered.
const STORIES = [
  { id: "blockeditor--mixed", waitFor: '[data-testid="block-body"]' },
  { id: "blockeditor--nested-todo", waitFor: '[data-testid="block-body"]' },
  { id: "blockeditor--zoomed", waitFor: '[data-testid="zoom-breadcrumb"]' },
  // A HEADING zoom (the plain zoomed story zooms a paragraph): covers the
  // hanging # and the depth re-derivation of the title's child headings.
  { id: "blockeditor--deep-headings-zoomed", waitFor: '[data-testid="zoom-title-hash"]' },
  { id: "blockeditor--selection-sweep", waitFor: '[data-testid="block-body"]' },
  { id: "blockeditor--empty", waitFor: '[data-testid="block-body"]' },
  { id: "notetitle--default", waitFor: "text=Meeting notes" },
  // Per-story override example: { id: "...", waitFor: "...", maxDiffRatio: 0.005 },
]
const SCHEMES = ["light", "dark"]

const mode = process.argv.includes("--update")
  ? "update"
  : process.argv.includes("--check")
    ? "check"
    : null
if (!mode) {
  console.error("Usage: node e2e/visual-regression.mjs --check | --update")
  process.exit(2)
}

// --- Platform guard (check mode only) ---------------------------------------
// On CI a missing/foreign-platform baseline set doesn't fail or silently skip:
// we still capture and publish a "refreshed" set as a workflow artifact, so
// `npm run test:vr:accept` can turn any CI run's screenshots into baselines.
// Locally (dev machines render fonts differently) we skip outright.
let seedReason = null
if (mode === "check") {
  if (!existsSync(MANIFEST)) {
    seedReason = `no baselines yet (${MANIFEST} missing)`
  } else {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"))
    if (manifest.platform !== PLATFORM_KEY) {
      seedReason = `baselines are '${manifest.platform}' but this is '${PLATFORM_KEY}'`
    }
  }
  if (seedReason && !process.env.CI) {
    console.log(
      `VR SKIP: ${seedReason}.\n` +
        "CI (the baseline platform) is authoritative for these checks; accept a CI\n" +
        "run's screenshots with `npm run test:vr:accept`.",
    )
    process.exit(0)
  }
}

// --- Capture ----------------------------------------------------------------
const browser = await chromium.launch({
  headless: true,
  // The environment may ship a pre-installed Chromium; PW_CHROMIUM overrides.
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: [
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "--font-render-hinting=none",
    "--hide-scrollbars",
  ],
})

async function capture(scheme, id, waitFor) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block", // Storybook's PWA worker caches across navigations
  })
  const page = await context.newPage()
  // Belt and braces on top of reducedMotion: freeze anything that still moves,
  // and hide the caret so focus state can't flicker a pixel.
  await page.addInitScript(() => {
    const style = document.createElement("style")
    style.textContent =
      "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }"
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style))
  })
  await page.goto(`${BASE}?id=${id}&viewMode=story`, { waitUntil: "domcontentloaded" })
  await page.locator(waitFor).first().waitFor({ timeout: 15000 })
  await page.waitForLoadState("networkidle")
  await page.evaluate(() => document.fonts.ready)
  // Two frames for layout/paint to settle after fonts swap in.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const shot = await page.screenshot({ animations: "disabled" })
  await context.close()
  return shot
}

const names = []
const shots = new Map()
for (const scheme of SCHEMES) {
  for (const { id, waitFor, maxDiffRatio } of STORIES) {
    const name = `${id}--${scheme}`
    names.push(name)
    process.stdout.write(`capture ${name} ... `)
    shots.set(name, {
      png: await capture(scheme, id, waitFor),
      maxDiffRatio: maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO,
    })
    console.log("done")
  }
}
await browser.close()

// --- Update -----------------------------------------------------------------
if (mode === "update") {
  mkdirSync(BASELINE_DIR, { recursive: true })
  // Drop stale baselines for stories no longer in the list.
  for (const f of readdirSync(BASELINE_DIR)) {
    if (f.endsWith(".png") && !names.includes(f.slice(0, -4))) {
      rmSync(path.join(BASELINE_DIR, f))
      console.log(`removed stale baseline ${f}`)
    }
  }
  for (const [name, { png }] of shots) {
    writeFileSync(path.join(BASELINE_DIR, `${name}.png`), png)
  }
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      { platform: PLATFORM_KEY, generatedAt: new Date().toISOString(), names },
      null,
      2,
    ) + "\n",
  )
  console.log(`\nWrote ${shots.size} baselines for '${PLATFORM_KEY}' to ${BASELINE_DIR}`)
  process.exit(0)
}

// --- Check ------------------------------------------------------------------
rmSync(ARTIFACT_DIR, { recursive: true, force: true })

// On CI, always publish the full captured set as a ready-to-accept baseline
// refresh (seeding a new platform, or accepting an intentional visual change).
if (process.env.CI) {
  const refreshedDir = path.join(ARTIFACT_DIR, "refreshed")
  mkdirSync(refreshedDir, { recursive: true })
  for (const [name, { png }] of shots) {
    writeFileSync(path.join(refreshedDir, `${name}.png`), png)
  }
  writeFileSync(
    path.join(refreshedDir, "baseline-manifest.json"),
    JSON.stringify(
      { platform: PLATFORM_KEY, generatedAt: new Date().toISOString(), names },
      null,
      2,
    ) + "\n",
  )
}

if (seedReason) {
  console.log(
    `VR SEED: ${seedReason}.\n` +
      "Captured screenshots were published in the run artifacts; run\n" +
      "`npm run test:vr:accept` locally to commit them as baselines.",
  )
  process.exit(0)
}
let failures = 0
const saveArtifacts = (name, actual, expected, diff) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(path.join(ARTIFACT_DIR, `${name}--actual.png`), actual)
  if (expected) writeFileSync(path.join(ARTIFACT_DIR, `${name}--expected.png`), expected)
  if (diff) writeFileSync(path.join(ARTIFACT_DIR, `${name}--diff.png`), PNG.sync.write(diff))
}

for (const [name, { png: actualBuf, maxDiffRatio }] of shots) {
  const baselinePath = path.join(BASELINE_DIR, `${name}.png`)
  if (!existsSync(baselinePath)) {
    failures++
    saveArtifacts(name, actualBuf)
    console.log(`FAIL  ${name} — no baseline (new story?); run the update workflow`)
    continue
  }
  const expectedBuf = readFileSync(baselinePath)
  const actual = PNG.sync.read(actualBuf)
  const expected = PNG.sync.read(expectedBuf)
  if (actual.width !== expected.width || actual.height !== expected.height) {
    failures++
    saveArtifacts(name, actualBuf, expectedBuf)
    console.log(
      `FAIL  ${name} — size ${actual.width}x${actual.height} vs baseline ${expected.width}x${expected.height}`,
    )
    continue
  }
  const diff = new PNG({ width: actual.width, height: actual.height })
  const differing = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.1,
  })
  const ratio = differing / (actual.width * actual.height)
  if (ratio > maxDiffRatio) {
    failures++
    saveArtifacts(name, actualBuf, expectedBuf, diff)
    console.log(
      `FAIL  ${name} — ${differing} px differ (${(ratio * 100).toFixed(3)}% > ${(maxDiffRatio * 100).toFixed(3)}%)`,
    )
  } else {
    console.log(`PASS  ${name}${differing ? ` (${differing} px within budget)` : ""}`)
  }
}

// Baselines with no matching story are a config smell, but not a CI failure.
for (const f of readdirSync(BASELINE_DIR)) {
  if (f.endsWith(".png") && !names.includes(f.slice(0, -4))) {
    console.log(`WARN  stale baseline ${f} — run the update workflow to prune it`)
  }
}

if (failures) {
  console.log(
    `\n${failures}/${shots.size} screenshots differ. Diff images: ${ARTIFACT_DIR}\n` +
      "If the change is intentional, dispatch the 'Update VR baselines' workflow.",
  )
  process.exit(1)
}
console.log(`\nAll ${shots.size} screenshots match the '${PLATFORM_KEY}' baselines.`)
