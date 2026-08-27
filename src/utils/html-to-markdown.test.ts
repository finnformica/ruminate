// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { htmlToMarkdown } from "./html-to-markdown"

describe("htmlToMarkdown", () => {
  it("converts headings, bold, italic, and links", () => {
    const html =
      "<h1>Title</h1><h3>Sub</h3>" +
      '<p>Some <strong>bold</strong> and <em>italic</em> and a <a href="https://example.com">link</a>.</p>'
    expect(htmlToMarkdown(html)).toBe(
      "# Title\n\n### Sub\n\nSome **bold** and *italic* and a [link](https://example.com).",
    )
  })

  it("converts nested unordered lists with 2-space indentation", () => {
    const html = "<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>"
    expect(htmlToMarkdown(html)).toBe("- a\n  - b\n    - c\n  - d\n- e")
  })

  it("converts an ordered list nested inside an unordered one", () => {
    const html = "<ul><li>steps<ol><li>first</li><li>second</li></ol></li></ul>"
    expect(htmlToMarkdown(html)).toBe("- steps\n  1. first\n  2. second")
  })

  it("respects an ordered list's start attribute", () => {
    const html = '<ol start="3"><li>three</li><li>four</li></ol>'
    expect(htmlToMarkdown(html)).toBe("3. three\n4. four")
  })

  it("converts GFM task-list items", () => {
    const html =
      '<ul><li><input type="checkbox"> open</li><li><input type="checkbox" checked> done</li></ul>'
    expect(htmlToMarkdown(html)).toBe("- [ ] open\n- [x] done")
  })

  it("does not treat a nested item's checkbox as the parent's", () => {
    const html = '<ul><li>parent<ul><li><input type="checkbox"> child</li></ul></li></ul>'
    expect(htmlToMarkdown(html)).toBe("- parent\n  - [ ] child")
  })

  it("treats the Google Docs bold-wrapper quirk as NOT bold", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc">' +
      '<p><span style="font-weight:700">actually bold</span> plain</p></b>'
    expect(htmlToMarkdown(html)).toBe("**actually bold** plain")
  })

  it("converts styled spans (font-weight / font-style) to markdown", () => {
    const html =
      '<p><span style="font-style:italic">it</span> <span style="font-weight:700">b</span></p>'
    expect(htmlToMarkdown(html)).toBe("*it* **b**")
  })

  it("converts inline code and fenced code blocks", () => {
    const html = "<p>Use <code>npm test</code>.</p><pre><code>line one\nline two</code></pre>"
    expect(htmlToMarkdown(html)).toBe("Use `npm test`.\n\n```\nline one\nline two\n```")
  })

  it("converts blockquotes", () => {
    const html = "<blockquote><p>wise words</p></blockquote>"
    expect(htmlToMarkdown(html)).toBe("> wise words")
  })

  it("turns <br> into a line break and separates paragraphs", () => {
    const html = "<p>one<br>two</p><p>three</p>"
    expect(htmlToMarkdown(html)).toBe("one\ntwo\n\nthree")
  })

  it("strips scripts, styles, comments, meta preambles, and full-document wrappers", () => {
    const html =
      "<html><head><meta charset='utf-8'><style>p{color:red}</style><title>x</title></head>" +
      "<body><!-- comment --><script>alert(1)</script><p>kept</p></body></html>"
    expect(htmlToMarkdown(html)).toBe("kept")
  })

  it("strips spans and divs down to their text", () => {
    const html = '<div><span class="fancy" style="color:red">just text</span></div>'
    expect(htmlToMarkdown(html)).toBe("just text")
  })

  it("keeps spaces outside bold markers", () => {
    const html = "<p>foo <b>bar </b>baz</p>"
    expect(htmlToMarkdown(html)).toBe("foo **bar** baz")
  })

  it("returns an empty string for empty or whitespace-only html", () => {
    expect(htmlToMarkdown("")).toBe("")
    expect(htmlToMarkdown("   \n\t  ")).toBe("")
    expect(htmlToMarkdown("<div><span>   </span></div>")).toBe("")
  })

  it("handles an Apple-style body fragment with nested divs per line", () => {
    const html = "<html><body><div>first</div><div>second</div></body></html>"
    expect(htmlToMarkdown(html)).toBe("first\n\nsecond")
  })

  it("keeps multiple paragraphs inside a list item as child lines", () => {
    const html = "<ul><li><p>item</p><p>detail</p></li></ul>"
    expect(htmlToMarkdown(html)).toBe("- item\n  detail")
  })
})
