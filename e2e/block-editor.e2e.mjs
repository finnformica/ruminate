import { chromium } from "playwright"

const BASE = "http://127.0.0.1:6010/iframe.html"
const OUT =
  process.argv[2] ||
  "/tmp/claude-0/-home-user-percolate/f5cc8d33-cf81-50b9-b7c5-503497dde442/scratchpad"
const results = []
const check = (name, ok, extra = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`)
}

const browser = await chromium.launch({
  headless: true,
  // The environment ships a pre-installed Chromium; point at it rather than
  // downloading one (set PW_CHROMIUM to override).
  executablePath: process.env.PW_CHROMIUM || undefined,
})
// Block Storybook's PWA service worker — it caches across navigations and
// leaves later stories half-rendered in a reused page.
const context = await browser.newContext({
  viewport: { width: 800, height: 600 },
  serviceWorkers: "block",
})
const page = await context.newPage()

async function story(id) {
  await page.goto(`${BASE}?id=${id}&viewMode=story`, { waitUntil: "domcontentloaded" })
  await page.getByTestId("block-body").first().waitFor({ timeout: 10000 })
}
const serialized = () => page.locator('[data-testid="serialized"]').textContent()
// A block's rendered body by its text. (The body is a plain div — an earlier
// markup gave it role="button", which these tests used to query by.)
const block = (name) => page.getByTestId("block-body").filter({ hasText: name })

// --- Mixed: visual + block types render ---
await story("blockeditor--mixed")
await page.screenshot({ path: `${OUT}/01-mixed.png` })
check("heading renders", await block("Project ideas").isVisible())
check("checkbox renders", (await page.locator("input[type=checkbox]").count()) >= 2)
check("bullet renders", await block("A bullet point").isVisible())

// --- Seamless view↔edit: a block must not move or resize when edited ---
// Switching a block between its rendered view and its edit textarea must not
// shift the text horizontally OR vertically, and must not change the block's
// height (which would nudge every block below it — the visible "shift").
async function measureViewVsEdit(name) {
  const view = block(name)
  const viewBox = await view.boundingBox()
  await view.click()
  await page.keyboard.press("Enter") // select -> edit
  const ta = page.locator("textarea").first()
  await ta.waitFor()
  const editBox = await ta.boundingBox()
  const inputValue = await ta.inputValue()
  return { viewBox, editBox, inputValue, ta }
}

// Screenshot the header block in both states so the pair is captured.
await block("Project ideas").scrollIntoViewIfNeeded()
await page.screenshot({ path: `${OUT}/02a-viewing.png` })
{
  const { viewBox, editBox, inputValue } = await measureViewVsEdit("Project ideas")
  await page.screenshot({ path: `${OUT}/02b-editing.png` })
  const dx = Math.abs(viewBox.x - editBox.x)
  const dy = Math.abs(viewBox.y - editBox.y)
  const dh = Math.abs(viewBox.height - editBox.height)
  check("heading: no horizontal shift when editing", dx <= 1, `dx=${dx.toFixed(1)}px`)
  check("heading: no vertical shift when editing", dy <= 1, `dy=${dy.toFixed(1)}px`)
  check("heading: block height unchanged when editing", dh <= 1, `dh=${dh.toFixed(1)}px`)
  // The raw "# " marker is not shown in the textarea (edits the stripped body).
  check("textarea shows stripped body", inputValue === "Project ideas", inputValue)
  await page.keyboard.press("Escape")
}

// The same must hold for every block type — a marker'd block (bullet) and a
// plain paragraph, not just the heading.
for (const name of ["Some intro text", "A bullet point"]) {
  const { viewBox, editBox } = await measureViewVsEdit(name)
  const dx = Math.abs(viewBox.x - editBox.x)
  const dy = Math.abs(viewBox.y - editBox.y)
  const dh = Math.abs(viewBox.height - editBox.height)
  check(
    `"${name}": no shift/resize when editing`,
    dx <= 1 && dy <= 1 && dh <= 1,
    `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dh=${dh.toFixed(1)}`,
  )
  await page.keyboard.press("Escape")
}

// --- Markdown shortcuts on an empty note ---
await story("blockeditor--empty")
const bodyCount = await page.getByTestId("block-body").count()
console.log("empty block-body count:", bodyCount)
await page
  .getByTestId("block-body")
  .first()
  .evaluate((el) => el.focus())
await page.keyboard.press("Enter") // edit the empty starter block
await page.locator("textarea").first().waitFor()
await page.keyboard.type("# Heading one")
await page.keyboard.press("Enter")
await page.keyboard.type("- Bullet one")
await page.keyboard.press("Enter")
await page.keyboard.type("[] A todo")
await page.waitForTimeout(200)
const md = await serialized()
check("heading serialized once", md.includes("# Heading one"))
check("bullet NOT doubled", md.includes("- Bullet one") && !md.includes("- - Bullet one"))
check("todo serialized", md.includes("[] A todo") || md.includes("[ ] A todo"))
await page.screenshot({ path: `${OUT}/03-shortcuts.png` })

// --- Typing a marker switches an existing block's type ---
await story("blockeditor--mixed")
{
  const todo = block("A todo")
  await todo.click()
  await page.keyboard.press("Enter") // edit
  await page.keyboard.press("Home")
  await page.keyboard.type("- ")
  await page.waitForTimeout(150)
  let md = await serialized()
  check(
    "checkbox → bullet on '- '",
    md.includes("- A todo") && !md.includes("[ ] A todo"),
    md.includes("- A todo") ? "" : "no bullet",
  )
  await page.keyboard.press("Home")
  await page.keyboard.type("# ")
  await page.waitForTimeout(150)
  md = await serialized()
  check("bullet → heading on '# '", md.includes("# A todo") && !md.includes("- A todo"))
  await page.screenshot({ path: `${OUT}/05-type-switch.png` })
}

// --- Shift-Enter splits into a new same-type block below the caret ---
await story("blockeditor--mixed")
{
  const bullet = block("A bullet point")
  await bullet.click()
  await page.keyboard.press("Enter") // edit (caret at end)
  await page.keyboard.press("Shift+Enter") // split: new same-type block below
  await page.keyboard.type("BELOW")
  await page.waitForTimeout(150)
  const md = await serialized()
  const belowAt = md.indexOf("- BELOW")
  const bulletAt = md.indexOf("A bullet point")
  check(
    "Shift-Enter splits into a same-type block below",
    belowAt !== -1 && bulletAt !== -1 && bulletAt < belowAt,
    `below@${belowAt} bullet@${bulletAt}`,
  )
}

// --- Undo works across blocks (the browser's per-textarea undo can't) ---
await story("blockeditor--empty")
{
  const mod = process.platform === "darwin" ? "Meta" : "Control"
  await page
    .getByTestId("block-body")
    .first()
    .evaluate((el) => el.focus())
  await page.keyboard.press("Enter") // edit the empty starter block
  await page.locator("textarea").first().waitFor()
  await page.keyboard.type("AAA")
  await page.keyboard.press("Enter") // new block below
  await page.keyboard.type("BBB")
  await page.waitForTimeout(120)
  let md = await serialized()
  check("two blocks present before undo", md.includes("AAA") && md.includes("BBB"))

  await page.keyboard.press(`${mod}+z`) // undo the "BBB" text run
  await page.waitForTimeout(120)
  md = await serialized()
  check("undo removes the second block's text", md.includes("AAA") && !md.includes("BBB"))

  await page.keyboard.press(`${mod}+z`) // undo the Enter (structural)
  await page.keyboard.press(`${mod}+z`) // undo the "AAA" text run
  await page.waitForTimeout(120)
  md = await serialized()
  check("undo walks back across blocks to empty", !md.includes("AAA") && !md.includes("BBB"))

  await page.keyboard.press(`${mod}+Shift+z`) // redo the "AAA" run
  await page.waitForTimeout(120)
  md = await serialized()
  check("redo restores an undone change", md.includes("AAA"))
}

// --- Pasting multi-line markdown populates separate blocks ---
async function pasteText(text) {
  await page.evaluate((t) => {
    const el = document.activeElement
    const dt = new DataTransfer()
    dt.setData("text/plain", t)
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, text)
}
await story("blockeditor--empty")
{
  await page
    .getByTestId("block-body")
    .first()
    .evaluate((el) => el.focus())
  await page.keyboard.press("Enter") // edit the empty starter block
  await page.locator("textarea").first().waitFor()
  await pasteText("# Heading\n[ ] todo one\nplain paragraph\n- bullet")
  await page.waitForTimeout(150)
  await page.keyboard.press("Escape")
  const md = await serialized()
  check("paste → heading block", md.includes("# Heading"))
  check("paste → todo block", md.includes("[ ] todo one"))
  check("paste → paragraph block", md.includes("plain paragraph"))
  check("paste → bullet block (not doubled)", md.includes("- bullet") && !md.includes("- - bullet"))
  const bodies = await page.getByTestId("block-body").count()
  check("paste created four separate blocks", bodies === 4, `blocks=${bodies}`)
  await page.screenshot({ path: `${OUT}/06-paste.png` })
}

// --- Enter in the middle of a line moves the tail to the new block ---
await story("blockeditor--empty")
{
  await page
    .getByTestId("block-body")
    .first()
    .evaluate((el) => el.focus())
  await page.keyboard.press("Enter")
  await page.locator("textarea").first().waitFor()
  await page.keyboard.type("helloworld")
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft") // caret: hello|world
  await page.keyboard.press("Enter")
  await page.waitForTimeout(120)
  await page.keyboard.press("Escape")
  const md = await serialized()
  const helloAt = md.indexOf("hello")
  const worldAt = md.indexOf("world")
  check(
    "Enter mid-line splits the tail into a new block",
    helloAt !== -1 && worldAt !== -1 && helloAt < worldAt && !md.includes("helloworld"),
    `hello@${helloAt} world@${worldAt}`,
  )
}

// --- ArrowUp navigates within a wrapped block before leaving it ---
await story("blockeditor--empty")
{
  await page
    .getByTestId("block-body")
    .first()
    .evaluate((el) => el.focus())
  await page.keyboard.press("Enter")
  await page.locator("textarea").first().waitFor()
  await page.keyboard.type("SHORT")
  await page.keyboard.press("Enter") // a second block below
  const longText = "wrap ".repeat(40).trim() // ~200 chars → wraps several lines
  await page.keyboard.type(longText)
  const ta = () => page.locator("textarea").first()

  // One ArrowUp from the last visual line stays inside the wrapped block.
  await page.keyboard.press("ArrowUp")
  await page.waitForTimeout(50)
  check("ArrowUp stays within a wrapped block", (await ta().inputValue()) === longText)

  // Keep going up: leaving the block COMMITS the edit — edit mode exits and
  // the block above is highlighted (select mode), not opened for editing.
  let left = false
  for (let i = 0; i < 8 && !left; i++) {
    await page.keyboard.press("ArrowUp")
    await page.waitForTimeout(20)
    left = (await page.locator("textarea").count()) === 0
  }
  check("ArrowUp from the first visual line exits edit mode", left)
  const highlighted = await page.evaluate(
    () => document.querySelector("[data-block-line].bg-bg-secondary")?.textContent ?? "",
  )
  check("the block above is highlighted, not edited", highlighted.includes("SHORT"), highlighted)
}

// --- ArrowDown on the last block exits edit mode, selecting the block itself ---
await story("blockeditor--empty")
{
  await page
    .getByTestId("block-body")
    .first()
    .evaluate((el) => el.focus())
  await page.keyboard.press("Enter")
  await page.locator("textarea").first().waitFor()
  await page.keyboard.type("LAST")
  await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(50)
  check(
    "ArrowDown at the last block exits edit mode",
    (await page.locator("textarea").count()) === 0,
  )
  const highlighted = await page.evaluate(
    () => document.querySelector("[data-block-line].bg-bg-secondary")?.textContent ?? "",
  )
  check("the exited block stays highlighted", highlighted.includes("LAST"), highlighted)
}

// --- Select-mode shortcuts: x toggles a todo, Space collapses a subtree ---
await story("blockeditor--mixed")
{
  // Select a todo and toggle its checkbox with `x`.
  await block("A todo").click()
  await page.keyboard.press("x")
  await page.waitForTimeout(120)
  let md = await serialized()
  check("x checks the todo", md.includes("[x] A todo"))
  await page.keyboard.press("x")
  await page.waitForTimeout(120)
  md = await serialized()
  check("x unchecks the todo", md.includes("[ ] A todo"))

  // Select a block with children and collapse/expand it with Space.
  const child = block("A nested bullet")
  await block("A bullet point").click()
  check("child visible before collapse", await child.isVisible())
  await page.keyboard.press("Space")
  await page.waitForTimeout(120)
  check("Space collapses the block", (await child.count()) === 0)
  await page.keyboard.press("Space")
  await page.waitForTimeout(120)
  check("Space expands the block again", await child.isVisible())
}

// --- A new note opens with the first block already in edit mode ---
{
  await page.goto(`${BASE}?id=blockeditor--auto-focus&viewMode=story`, {
    waitUntil: "domcontentloaded",
  })
  await page.locator("textarea").first().waitFor({ timeout: 10000 })
  const editors = await page.locator("textarea").count()
  const focused = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA")
  check("new note starts editing the first block", editors === 1 && focused)
}

// --- The editable note title renders `# name` and renames on Enter ---
{
  await page.goto(`${BASE}?id=notetitle--default&viewMode=story`, {
    waitUntil: "domcontentloaded",
  })
  // The title starts in view mode (a focusable heading); click to edit it.
  const title = page.getByRole("button").filter({ hasText: "Meeting notes" })
  await title.waitFor({ timeout: 10000 })
  check("title shows a leading #", await page.getByText("#", { exact: true }).isVisible())
  await title.click()
  const input = page.getByRole("textbox", { name: "Note name" })
  await input.waitFor({ timeout: 10000 })
  check("title input holds the note name", (await input.inputValue()) === "Meeting notes")
  await input.fill("Renamed note")
  await input.press("Enter")
  await page.waitForTimeout(100)
  const name = await page.locator('[data-testid="note-name"]').textContent()
  check("editing the title renames the note", name === "Renamed note", name)
}

// --- Copying a multi-block selection yields markdown, not just rendered text ---
await story("blockeditor--mixed")
{
  const md = await page.evaluate(() => {
    const bodies = document.querySelectorAll("[data-block-id]")
    const range = document.createRange()
    range.setStartBefore(bodies[0])
    range.setEndAfter(bodies[2])
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const dt = new DataTransfer()
    bodies[1].dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }),
    )
    return dt.getData("text/plain")
  })
  check(
    "copy keeps markdown markers across blocks",
    md.includes("# Project ideas") &&
      md.includes("- A bullet point") &&
      md.includes("Some intro text"),
    JSON.stringify(md),
  )
}

// --- Selection ladder: Cmd+A escalates by structure, Cmd+Shift+A steps back ---
await story("blockeditor--mixed")
{
  const mod = process.platform === "darwin" ? "Meta" : "Control"
  const highlighted = () =>
    page.evaluate(() => document.querySelectorAll("[data-block-line].bg-bg-secondary").length)
  await block("A nested bullet").click() // a leaf, one level deep
  check("ladder: click selects one block", (await highlighted()) === 1)
  await page.keyboard.press(`${mod}+a`)
  await page.waitForTimeout(80)
  check("ladder: Cmd+A selects the parent's subtree", (await highlighted()) === 2)
  await page.keyboard.press(`${mod}+a`)
  await page.waitForTimeout(80)
  check("ladder: Cmd+A again selects the whole page", (await highlighted()) === 7)
  await page.keyboard.press(`${mod}+Shift+a`)
  await page.waitForTimeout(80)
  check("ladder: Cmd+Shift+A shrinks back one rung", (await highlighted()) === 2)
  await page.keyboard.press("Escape")
}

// --- Zoom: a zoomed story shows only the subtree, with a breadcrumb ---
await story("blockeditor--zoomed")
{
  await page.screenshot({ path: `${OUT}/07-zoomed.png` })
  check("zoom: breadcrumb renders", await page.getByTestId("zoom-breadcrumb").isVisible())
  check("zoom: blocks outside the subtree are hidden", (await block("Project ideas").count()) === 0)
  check("zoom: the zoomed block renders as the title", await block("A bullet point").isVisible())
  check("zoom: its child renders below", await block("A nested bullet").isVisible())
}

// --- Zoom flow: F in, edit a child, Shift+F out — content + selection intact ---
await story("blockeditor--mixed")
{
  await block("A bullet point").click()
  await page.keyboard.press("f")
  await page.getByTestId("zoom-breadcrumb").waitFor({ timeout: 5000 })
  check("F zooms into the selected block", (await block("A todo").count()) === 0)

  // Edit the nested child while zoomed.
  await block("A nested bullet").click()
  await page.keyboard.press("Enter")
  await page.locator("textarea").first().waitFor()
  await page.keyboard.press("End")
  await page.keyboard.type(" EDITED")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(120)

  await page.keyboard.press("Shift+F")
  await page.waitForTimeout(120)
  check(
    "Shift+F zooms back out",
    (await page.getByTestId("zoom-breadcrumb").count()) === 0 &&
      (await block("Project ideas").isVisible()),
  )
  const md = await serialized()
  check("the zoomed-in edit survived", md.includes("A nested bullet EDITED"))
  const highlighted = await page.evaluate(
    () => document.querySelector("[data-block-line].bg-bg-secondary")?.textContent ?? "",
  )
  check(
    "zoom-out selects the block zoomed out from",
    highlighted.includes("A bullet point"),
    highlighted,
  )
}

// --- Keyboard navigation highlights, doesn't edit ---
await story("blockeditor--mixed")
await block("Project ideas").click() // select first
await page.keyboard.press("ArrowDown")
await page.keyboard.press("ArrowDown")
await page.waitForTimeout(100)
const editorsOpen = await page.locator("textarea").count()
check("arrow navigation does not open an editor", editorsOpen === 0, `textareas=${editorsOpen}`)
await page.screenshot({ path: `${OUT}/04-navigation.png` })

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
