// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { htmlToMarkdown } from "./html-to-markdown"
import {
  clipboardBlocksToDoc,
  clipboardBlocksToMarkdown,
  extractClipboardBlocks,
  richClipboardFormats,
  writeRichClipboard,
} from "./rich-clipboard"

/** A nested selection exercising every block type (block-format markdown:
 * content verbatim, two-space nesting). */
const EVERY_TYPE = [
  "# Head",
  "  - bullet",
  "    [ ] task",
  "    [x] done",
  "  1. first",
  "  > quoted",
  "  plain `code` **bold** [link](https://e.com)",
].join("\n")

describe("richClipboardFormats", () => {
  it("writes clean display markdown as the plain flavor", () => {
    const { plain } = richClipboardFormats(EVERY_TYPE)
    expect(plain).toContain("# Head")
    expect(plain).toContain("- [ ] task") // GFM todo, not the bare marker
    expect(plain).not.toContain("id::")
  })

  it("embeds the exact block tree in the html flavor", () => {
    const { html } = richClipboardFormats(EVERY_TYPE)
    expect(html).toContain('<meta name="x-ruminate-blocks"')
    const blocks = extractClipboardBlocks(html)!
    expect(blocks).toEqual([
      {
        content: "# Head",
        children: [
          {
            content: "- bullet",
            children: [
              { content: "[ ] task", children: [] },
              { content: "[x] done", children: [] },
            ],
          },
          { content: "1. first", children: [] },
          { content: "> quoted", children: [] },
          { content: "plain `code` **bold** [link](https://e.com)", children: [] },
        ],
      },
    ])
  })

  it("round-trips exactly through the embedded payload (paste path)", () => {
    const { html } = richClipboardFormats(EVERY_TYPE)
    const blocks = extractClipboardBlocks(html)!
    // Select-mode paste rebuilds a BlockDoc directly…
    const doc = clipboardBlocksToDoc(blocks)
    expect(serialize(doc).replace(/^\s*id:: .*\n/gm, "")).toBe(EVERY_TYPE + "\n")
    // …and edit-mode paste splices the identical block markdown back in.
    expect(clipboardBlocksToMarkdown(blocks)).toBe(EVERY_TYPE)
  })

  it("round-trips unicode content through the base64 payload", () => {
    const markdown = "- héllo wörld 你好 🚀"
    const { html } = richClipboardFormats(markdown)
    expect(clipboardBlocksToMarkdown(extractClipboardBlocks(html)!)).toBe(markdown)
  })

  it("renders html that survives the no-meta path as equivalent markdown", () => {
    const { html } = richClipboardFormats(EVERY_TYPE)
    // A foreign app that strips the meta tag: the visible html still converts
    // to equivalent markdown (prose children flatten, same as the plain flavor).
    const stripped = html.replace(/<meta[^>]*>/g, "")
    expect(extractClipboardBlocks(stripped)).toBeNull()
    const markdown = htmlToMarkdown(stripped)
    const doc = parse(markdown)
    const lines = serialize(doc)
      .split("\n")
      .filter((line) => !line.includes("id::") && line.trim() !== "")
    expect(lines).toEqual([
      "# Head",
      "- bullet",
      "  [ ] task",
      "  [x] done",
      "1. first",
      "> quoted",
      "plain `code` **bold** [link](https://e.com)",
    ])
  })

  it("gives fresh ids on every rebuild (ids are never carried in the payload)", () => {
    const { html } = richClipboardFormats("- a\n  - b")
    const blocks = extractClipboardBlocks(html)!
    const one = clipboardBlocksToDoc(blocks)
    const two = clipboardBlocksToDoc(blocks)
    expect(Object.keys(one.blocks)).not.toEqual(Object.keys(two.blocks))
  })
})

describe("extractClipboardBlocks", () => {
  it("returns null for html without the meta tag", () => {
    expect(extractClipboardBlocks("<p>hello</p>")).toBeNull()
  })

  it("returns null for a corrupted payload", () => {
    expect(
      extractClipboardBlocks('<meta name="x-ruminate-blocks" content="!!!not-base64!!!"><p>x</p>'),
    ).toBeNull()
    const bogus = btoa(JSON.stringify({ blocks: [{ nope: true }] }))
    expect(
      extractClipboardBlocks(`<meta name="x-ruminate-blocks" content="${bogus}"><p>x</p>`),
    ).toBeNull()
  })
})

describe("writeRichClipboard", () => {
  // jsdom has no execCommand; the tests install and remove their own stub.
  const doc = document as unknown as { execCommand?: (command: string) => boolean }

  afterEach(() => {
    delete doc.execCommand
    vi.restoreAllMocks()
  })

  it("writes both formats through a synthetic copy event", () => {
    const setData = vi.fn()
    // Stub execCommand to fire a copy event the one-shot listener overrides,
    // like a real browser does.
    doc.execCommand = vi.fn((command: string) => {
      expect(command).toBe("copy")
      const event = new Event("copy", { bubbles: true, cancelable: true })
      Object.assign(event, { clipboardData: { setData } })
      document.dispatchEvent(event)
      return true
    })
    writeRichClipboard({ plain: "plain text", html: "<p>html</p>" })
    expect(setData).toHaveBeenCalledWith("text/plain", "plain text")
    expect(setData).toHaveBeenCalledWith("text/html", "<p>html</p>")
  })

  it("falls back to navigator.clipboard.writeText when execCommand fails", () => {
    doc.execCommand = vi.fn(() => false)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    writeRichClipboard({ plain: "plain text", html: "<p>html</p>" })
    expect(writeText).toHaveBeenCalledWith("plain text")
  })
})
