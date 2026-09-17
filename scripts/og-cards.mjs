// The Open Graph cards — the picture a Ruminate link unfurls as when it is
// pasted into a message, a chat or a timeline.
//
//   node scripts/og-cards.mjs
//
// Writes public/og-card.png (the app's own link) and public/og-invite.png (an
// invite link) at 1200×630, the size every unfurler crops to. Both are drawn
// from the one template below and screenshotted with the same Chromium the
// visual-regression runner uses, so they are reproducible: change the
// template, run this, commit the PNGs. Nothing builds them at deploy time —
// they are assets, served straight from `public/`.
//
// The cards are drawn in the app's own clothes: the icon's black, the editor's
// text face (iA Writer Quattro, read from public/fonts) and the cyan accent a
// ticked box is filled with. Someone who has seen the app recognises it; the
// rows down the right say what the app is to someone who has not.
//
// Which tags point at these, and for which paths, is worker/handlers/social.ts.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(DIR, "..")
const PUBLIC = path.join(ROOT, "public")

const WIDTH = 1200
const HEIGHT = 630

/** The app's colours, as `src/styles/` has them. */
const INK = "#ffffff"
const INK_DIM = "#8d8d86"
const BACKDROP = "#000000"
const ACCENT = "#00a2c7"

/**
 * The cards. `lead` is the line that carries the card, `tag` sits under it,
 * and `leadSize` steps the lead down where it runs to a second line, so both
 * cards hold the same amount of the frame.
 */
const CARDS = [
  {
    file: "og-card.png",
    lead: "Ruminate",
    leadSize: 76,
    tag: "A block-based note-taking app for better thinking.",
  },
  {
    file: "og-invite.png",
    lead: "You’re invited to Ruminate",
    leadSize: 62,
    tag: "Sign in with GitHub for a private notes database of your own.",
  },
]

/**
 * The card as a page. One template for both cards, so the two can only differ
 * in the words they carry.
 *
 * The outline on the right is drawn, not rendered by the editor: the editor
 * needs the app running, and a picture that has to be kept in step with a
 * component is a picture that goes stale. These are four rows of what a note
 * looks like, no more — a bullet, a nested bullet, a ticked box, an open one.
 */
const page = ({ lead, leadSize, tag }) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: "iA Writer Quattro";
        src: url("fonts/iAWriterQuattroV.woff2") format("woff2-variations");
        font-weight: 400 700;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        background: ${BACKDROP};
        color: ${INK};
        font-family: "iA Writer Quattro", system-ui, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 96px;
        padding: 0 84px;
        overflow: hidden;
      }
      .say { flex: 0 1 auto; min-width: 0; }
      .mark {
        width: 68px; height: 68px;
        border: 3px solid ${INK};
        border-radius: 16px;
        display: flex; align-items: center; justify-content: center;
        font-size: 40px; font-weight: 700; line-height: 1;
        margin-bottom: 44px;
      }
      .lead {
        font-size: ${leadSize}px; font-weight: 700; line-height: 1.12;
        letter-spacing: -0.02em;
      }
      .tag {
        margin-top: 26px;
        font-size: 30px; line-height: 1.4; color: ${INK_DIM};
        max-width: 15.5em;
      }
      /* The outline: the same 15px marker slot the editor gives every row,
         and the same indent step, at the card's scale. */
      .note { flex: 0 0 330px; display: flex; flex-direction: column; gap: 26px; }
      .row { display: flex; align-items: center; gap: 16px; font-size: 26px; color: ${INK_DIM}; }
      .row.deep { padding-left: 42px; }
      .slot { width: 22px; display: flex; justify-content: center; flex: 0 0 22px; }
      .dot { width: 10px; height: 10px; border-radius: 999px; background: #5c5c57; }
      .box {
        width: 22px; height: 22px; border-radius: 5px;
        border: 2px solid #4a4a46;
        display: flex; align-items: center; justify-content: center;
      }
      .box.done { background: ${ACCENT}; border-color: ${ACCENT}; }
      .box svg { display: block; }
      .done-text { color: #55554f; text-decoration: line-through; }
      /* The two rows whose words are not the point: a note's texture, not its
         content — drawn as bars so the eye reads "an outline" and moves on. */
      .bar { height: 12px; border-radius: 6px; background: #2a2a27; }
    </style>
  </head>
  <body>
    <div class="say">
      <div class="mark">#</div>
      <div class="lead">${lead}</div>
      <div class="tag">${tag}</div>
    </div>
    <div class="note">
      <div class="row"><span class="slot"><span class="dot"></span></span><span class="bar" style="width: 190px"></span></div>
      <div class="row deep"><span class="slot"><span class="dot"></span></span><span class="bar" style="width: 130px"></span></div>
      <div class="row deep"><span class="slot"><span class="box done"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.4l3 3 6-6.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span><span class="done-text">write it down</span></div>
      <div class="row deep"><span class="slot"><span class="box"></span></span><span>think it through</span></div>
    </div>
  </body>
</html>`

// The browser Playwright downloaded, unless CHROMIUM_PATH names another —
// which is how this runs where the pinned build is not the one installed.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
try {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  })
  const tab = await context.newPage()
  mkdirSync(PUBLIC, { recursive: true })
  // The page is written INTO public/ and opened from there, so the
  // `@font-face` URL resolves to the real font file rather than quietly
  // falling back to a system face.
  const scratch = path.join(PUBLIC, "__og-card.html")
  try {
    for (const card of CARDS) {
      writeFileSync(scratch, page(card))
      await tab.goto(`file://${scratch}`)
      await tab.evaluate(() => document.fonts.ready)
      const png = await tab.screenshot({ type: "png" })
      writeFileSync(path.join(PUBLIC, card.file), png)
      console.log(`wrote public/${card.file} (${png.length} bytes)`)
    }
  } finally {
    rmSync(scratch, { force: true })
  }
} finally {
  await browser.close()
}
