// One-off audit captures: selection + edit mode on a deep floor heading.
import { chromium } from "playwright"

const BASE = "http://127.0.0.1:6010/iframe.html"
const OUT = process.argv[2] || "screenshots"

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 800, height: 1000 },
  colorScheme: "light",
  serviceWorkers: "block",
})
const page = await context.newPage()
await page.goto(`${BASE}?id=blockeditor--deep-headings&viewMode=story`, {
  waitUntil: "domcontentloaded",
})
await page.getByTestId("block-body").first().waitFor({ timeout: 10000 })
await page.waitForTimeout(300)

const deep = page.getByTestId("block-body").filter({ hasText: "Level 5 heading" })
const viewBox = await deep.boundingBox()
await deep.click()
await page.screenshot({ path: `${OUT}/audit-deep-selected.png`, fullPage: true })
await page.keyboard.press("Enter")
const ta = page.locator("textarea").first()
await ta.waitFor()
const editBox = await ta.boundingBox()
await page.screenshot({ path: `${OUT}/audit-deep-editing.png`, fullPage: true })
console.log(
  "floor heading view vs edit: dx=%s dy=%s dh=%s",
  Math.abs(viewBox.x - editBox.x).toFixed(1),
  Math.abs(viewBox.y - editBox.y).toFixed(1),
  Math.abs(viewBox.height - editBox.height).toFixed(1),
)
await browser.close()
