// The multi-block selection and its keys, end to end, in a real browser over
// the Storybook build: what the unit tests cannot see — a real mouse sweep
// leaving a real text selection, the browser's own Shift+click, the keys as
// Chromium delivers them, and the selection bar risen at the bottom of the
// window. Every key the docs promise for a selection (docs/keyboard-shortcuts.md,
// "With more than one block selected") is pressed here over a run of rows
// and checked against the serialized note.
//
//   node e2e/multi-select.e2e.mjs        (npm run test:select builds and serves Storybook first)
//
// The story: BlockEditor/MultiSelect (six plain rows, A to F).
import { chromium } from "playwright"

const BASE = process.env.SELECT_BASE_URL || "http://127.0.0.1:6013/iframe.html"
const results = []
const check = (name, ok, extra = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
})
const context = await browser.newContext({
  viewport: { width: 760, height: 700 },
  serviceWorkers: "block",
})
// The cut-and-paste round trip needs the real clipboard.
await context.grantPermissions(["clipboard-read", "clipboard-write"])
const page = await context.newPage()

async function story(id) {
  await page.goto(`${BASE}?id=${id}&viewMode=story&globals=theme:light`, {
    waitUntil: "domcontentloaded",
  })
  await page.getByTestId("block-body").first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(300)
}

/** The note's content lines, nesting kept, `id::` lines dropped. */
const lines = async () =>
  (await page.locator('[data-testid="serialized"]').textContent())
    .split("\n")
    .filter((l) => !l.includes("id::") && l.trim() !== "")
/** The highlighted rows' text, in order. */
const highlighted = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-block-line].bg-bg-secondary")).map((el) =>
      el.querySelector('[data-testid="block-body"]').textContent.trim(),
    ),
  )
const barOpen = () =>
  page.evaluate(() => {
    const bar = document.querySelector("[data-selection-bar]")
    return !!bar && !bar.classList.contains("hidden") && getComputedStyle(bar).display !== "none"
  })
const barCount = () => page.locator('[data-testid="selection-count"]').textContent()
const body = (text) => page.getByTestId("block-body").filter({ hasText: text }).first()

/** Drag the mouse from the middle of one row's text to another's. */
async function sweep(from, to) {
  const a = await body(from).boundingBox()
  const b = await body(to).boundingBox()
  await page.mouse.move(a.x + 4, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}

const FLAT = ["A", "B", "C", "D", "E", "F"]

// ── A mouse sweep selects the rows it crossed, and Tab acts on all of them ──
await story("blockeditor--multi-select")
{
  await sweep("B", "D")
  check("sweep B→D selects B, C and D", same(await highlighted(), ["B", "C", "D"]))
  check("the bar rises with the count", (await barOpen()) && (await barCount()) === "3 selected")
  check("the text selection is spent", await page.evaluate(() => window.getSelection().isCollapsed))
  await page.keyboard.press("Tab")
  check("Tab indents every selected row", same(await lines(), ["A", "  B", "  C", "  D", "E", "F"]))
  check("the selection follows the rows", same(await highlighted(), ["B", "C", "D"]))
  await page.keyboard.press("Tab")
  check(
    "a second Tab is a no-op: B leads its parent",
    same(await lines(), ["A", "  B", "  C", "  D", "E", "F"]),
  )
  await page.keyboard.press("Shift+Tab")
  check("Shift+Tab outdents every selected row", same(await lines(), FLAT))
}

// ── A sweep upwards anchors at its start, so Shift+Arrow grows the other end ──
{
  await sweep("D", "B")
  check("sweep D→B selects B, C and D", same(await highlighted(), ["B", "C", "D"]))
  await page.keyboard.press("Shift+ArrowUp")
  check("Shift+↑ grows from the top", same(await highlighted(), ["A", "B", "C", "D"]))
  await page.keyboard.press("Escape")
  check("Escape collapses to one row", (await highlighted()).length === 1)
  await page.waitForTimeout(250)
  check("the bar sinks away", !(await barOpen()))
}

// ── Shift+click extends the selection ────────────────────────────────────────
{
  await body("B").click()
  await body("D").click({ modifiers: ["Shift"] })
  check("Shift+click B→D selects B, C and D", same(await highlighted(), ["B", "C", "D"]))
  await body("E").click({ modifiers: ["Shift"] })
  check("another Shift+click extends further", same(await highlighted(), ["B", "C", "D", "E"]))
  await body("C").click()
  check("a plain click collapses it", same(await highlighted(), ["C"]))
}

// ── Move, duplicate, remove, turn into ───────────────────────────────────────
{
  await sweep("B", "C")
  await page.keyboard.press("Alt+ArrowDown")
  check("Alt+↓ moves the group down", same(await lines(), ["A", "D", "B", "C", "E", "F"]))
  await page.keyboard.press("Alt+ArrowUp")
  check("Alt+↑ moves it back", same(await lines(), FLAT))
  await page.keyboard.press("Shift+Alt+ArrowDown")
  check(
    "Shift+Alt+↓ duplicates the group below",
    same(await lines(), ["A", "B", "C", "B", "C", "D", "E", "F"]),
  )
  check("the copies are selected", same(await highlighted(), ["B", "C"]))
  await page.keyboard.press("Backspace")
  check("Backspace removes the selected rows", same(await lines(), FLAT))
  await sweep("B", "C")
  await page.keyboard.press("-")
  check(
    "`-` turns the selection into bullets",
    same(await lines(), ["A", "- B", "- C", "D", "E", "F"]),
  )
  await page.keyboard.press("-")
  check("`-` again turns them back to text", same(await lines(), FLAT))
  await page.keyboard.press("#")
  check(
    "`#` turns the selection into headings",
    same(await lines(), ["A", "# B", "# C", "D", "E", "F"]),
  )
  await page.keyboard.press("#")
  check("`#` again turns them back", same(await lines(), FLAT))
}

// ── Cut and paste round-trips the selection through the clipboard ────────────
{
  const mod = process.platform === "darwin" ? "Meta" : "Control"
  await sweep("B", "C")
  await page.keyboard.press(`${mod}+x`)
  check("⌘X removes the selected rows", same(await lines(), ["A", "D", "E", "F"]))
  await body("E").click()
  await page.keyboard.press(`${mod}+v`)
  await page.waitForTimeout(300)
  // A Ruminate clipboard payload lands under the selected row, as its first
  // children (block-editor.tsx, `handleContainerPaste`).
  check(
    "⌘V pastes them under the selected row",
    same(await lines(), ["A", "D", "E", "  B", "  C", "F"]),
  )
}

// ── The bar's menu runs on the selection and hands the keyboard back ─────────
await story("blockeditor--multi-select")
{
  await sweep("C", "D")
  await page.getByRole("button", { name: "Actions" }).click()
  await page.getByRole("menuitem", { name: "Indent" }).click()
  await page.waitForTimeout(200)
  check(
    "Actions → Indent indents the selection",
    same(await lines(), ["A", "B", "  C", "  D", "E", "F"]),
  )
  await page.keyboard.press("Shift+Tab")
  check("the keys work again straight after the menu", same(await lines(), FLAT))
  await page.getByRole("button", { name: "Clear selection" }).click()
  check("Clear selection leaves one row", (await highlighted()).length === 1)
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
