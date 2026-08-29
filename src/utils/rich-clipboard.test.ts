// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { htmlToMarkdown } from "./html-to-markdown"
import {
  clipboardBlocksToDoc,
  clipboardBlocksToDocWithIds,
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

  it("gives fresh ids on every rebuild through the duplicate path", () => {
    const { html } = richClipboardFormats("- a\n  - b")
    const blocks = extractClipboardBlocks(html)!
    const one = clipboardBlocksToDoc(blocks)
    const two = clipboardBlocksToDoc(blocks)
    expect(Object.keys(one.blocks)).not.toEqual(Object.keys(two.blocks))
  })
})

describe("block ids in the payload (paste as link)", () => {
  /** The exact selection markdown the editor's copy paths now emit: content
   * lines plus `id::` lines, two-space nesting. */
  const WITH_IDS = [
    "# Head",
    "  id:: blk_head000000",
    "  - bullet",
    "    id:: blk_bullet0000",
    "    [ ] task",
    "      id:: blk_task000000",
  ].join("\n")
  const WITHOUT_IDS = ["# Head", "  - bullet", "    [ ] task"].join("\n")

  it("round-trips declared ids through the embedded payload", () => {
    const { html } = richClipboardFormats(WITH_IDS)
    expect(extractClipboardBlocks(html)).toEqual([
      {
        id: "blk_head000000",
        content: "# Head",
        children: [
          {
            id: "blk_bullet0000",
            content: "- bullet",
            children: [{ id: "blk_task000000", content: "[ ] task", children: [] }],
          },
        ],
      },
    ])
  })

  it("omits ids the source markdown never declared (parse-minted ids stay private)", () => {
    const { html } = richClipboardFormats(WITHOUT_IDS)
    for (const block of extractClipboardBlocks(html)!) {
      const walk = (b: { id?: string; children: { id?: string; children: never[] }[] }) => {
        expect("id" in b).toBe(false)
        b.children.forEach(walk)
      }
      walk(block as never)
    }
  })

  it("leaves both visible flavors byte-identical to the id-less copy", () => {
    const withIds = richClipboardFormats(WITH_IDS)
    const withoutIds = richClipboardFormats(WITHOUT_IDS)
    // The plain flavor, pinned to the exact bytes external apps receive.
    expect(withIds.plain).toBe("# Head\n\n- bullet\n  - [ ] task")
    expect(withIds.plain).toBe(withoutIds.plain)
    // The visible html (everything but the private meta payload) too.
    const visible = (html: string) => html.replace(/<meta[^>]*>/g, "")
    expect(visible(withIds.html)).toBe(visible(withoutIds.html))
    expect(withIds.html).not.toContain("blk_head000000") // payload is base64
  })

  it("clipboardBlocksToDocWithIds keeps embedded ids and mints only the missing ones", () => {
    const { html } = richClipboardFormats(WITH_IDS)
    const doc = clipboardBlocksToDocWithIds(extractClipboardBlocks(html)!)
    expect(doc.rootBlockIds).toEqual(["blk_head000000"])
    expect(doc.blocks["blk_head000000"].children).toEqual(["blk_bullet0000"])
    expect(doc.blocks["blk_bullet0000"].children).toEqual(["blk_task000000"])

    const mixed = clipboardBlocksToDocWithIds([
      { id: "blk_kept000000", content: "- kept", children: [] },
      { content: "- minted", children: [] },
    ])
    expect(mixed.rootBlockIds[0]).toBe("blk_kept000000")
    expect(mixed.rootBlockIds[1]).toMatch(/^blk_/)
    expect(mixed.rootBlockIds[1]).not.toBe("blk_kept000000")
  })

  it("clipboardBlocksToDocWithIds remints a duplicate id within one payload", () => {
    const doc = clipboardBlocksToDocWithIds([
      { id: "blk_dupe000000", content: "- one", children: [] },
      { id: "blk_dupe000000", content: "- two", children: [] },
    ])
    expect(doc.rootBlockIds[0]).toBe("blk_dupe000000")
    expect(doc.rootBlockIds[1]).not.toBe("blk_dupe000000")
    expect(Object.keys(doc.blocks)).toHaveLength(2)
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
