// Minimal screenshot capture against built Storybook on :6010.
// Usage: node shots.mjs <outDir> [suffix]
import { chromium } from "playwright"

const BASE = "http://127.0.0.1:6010/iframe.html"
const OUT = process.argv[2] || "."
const SUFFIX = process.argv[3] ? `-${process.argv[3]}` : ""

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
})

async function capture(scheme) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 1000 },
    colorScheme: scheme,
    serviceWorkers: "block",
  })
  const page = await context.newPage()
  for (const id of ["blockeditor--deep-headings", "blockeditor--deep-headings-zoomed"]) {
    await page.goto(`${BASE}?id=${id}&viewMode=story`, { waitUntil: "domcontentloaded" })
    await page.getByTestId("block-body").first().waitFor({ timeout: 10000 })
    await page.waitForTimeout(300) // fonts settle
    await page.screenshot({
      path: `${OUT}/${id.replace("blockeditor--", "")}-${scheme}${SUFFIX}.png`,
      fullPage: true,
    })
  }
  await context.close()
}

await capture("light")
await capture("dark")
await browser.close()
console.log("done")
