import { describe, expect, it } from "vitest"
import {
  hostOf,
  isWebUrl,
  linkLine,
  linkPropsOf,
  linkifyPastedText,
  linkifyTypedAddress,
  linksInText,
  wholeTextLink,
  withLinkPreview,
} from "./link"

describe("link block props", () => {
  it("reads the address and the preview leniently", () => {
    expect(
      linkPropsOf({
        props: { url: "https://e.com/x", description: "Desc", site: "E", image: "", align: "left" },
      }),
    ).toEqual({ url: "https://e.com/x", description: "Desc", site: "E" })
    expect(linkPropsOf({ props: null })).toEqual({ url: "" })
    expect(linkPropsOf({ props: { url: 42 } })).toEqual({ url: "" })
  })

  it("writes a fetched preview over the old one, keeping the address and layout", () => {
    const block = {
      props: { url: "https://e.com/x", description: "Old", image: "old.png", size: 50 },
    }
    expect(
      withLinkPreview(block, {
        url: "https://e.com/final",
        title: "T",
        description: "New",
        site: "E",
        favicon: "",
      }),
    ).toEqual({ url: "https://e.com/x", description: "New", site: "E", size: 50 })
    expect(block.props).toEqual({
      url: "https://e.com/x",
      description: "Old",
      image: "old.png",
      size: 50,
    })
  })

  it("names the host, without www, as the display text of an address", () => {
    expect(hostOf("https://www.example.co.uk/a?b")).toBe("example.co.uk")
    expect(hostOf("https://mail.google.com/mail/u/0/#inbox/abc?x=1")).toBe("mail.google.com")
    expect(hostOf("not a url")).toBe("not a url")
  })

  it("writes the block as its markdown line, and knows a web address", () => {
    expect(linkLine({ text: "A **bold** title", props: { url: "https://e.com/x?y=1" } })).toBe(
      "[A **bold** title](https://e.com/x?y=1)",
    )
    expect(isWebUrl("https://e.com/")).toBe(true)
    expect(isWebUrl("ftp://e.com/")).toBe(false)
  })
})

describe("wholeTextLink", () => {
  it("is the link a block's text is, and nothing else", () => {
    expect(wholeTextLink("https://e.com/x")).toEqual({ url: "https://e.com/x", title: "" })
    expect(wholeTextLink("  https://e.com/x \n")).toEqual({ url: "https://e.com/x", title: "" })
    expect(wholeTextLink("[Title](https://e.com/x)")).toEqual({
      url: "https://e.com/x",
      title: "Title",
    })
    expect(wholeTextLink("See https://e.com/x")).toBeNull()
    expect(wholeTextLink("https://e.com/x and https://e.com/y")).toBeNull()
    expect(wholeTextLink("[top](#anchor)")).toBeNull()
    expect(wholeTextLink("")).toBeNull()
  })
})

describe("linkifyPastedText", () => {
  it("gives a bare address its host for display text, keeping the address whole", () => {
    expect(linkifyPastedText("see https://www.example.com/a/b?c=1.")).toBe(
      "see [example.com](https://www.example.com/a/b?c=1).",
    )
    expect(linkifyPastedText("https://mail.google.com/mail/u/0/#inbox/18f2c3")).toBe(
      "[mail.google.com](https://mail.google.com/mail/u/0/#inbox/18f2c3)",
    )
    expect(linkifyPastedText("two: https://a.com/x, https://b.org/y!")).toBe(
      "two: [a.com](https://a.com/x), [b.org](https://b.org/y)!",
    )
    expect(linkifyPastedText("- https://a.com/x\n  id:: blk_a\n")).toBe(
      "- [a.com](https://a.com/x)\n  id:: blk_a\n",
    )
  })

  it("takes a www. address, or a name with a common ending, as an address too", () => {
    expect(linkifyPastedText("try www.example.com/a?b=1 and google.com, or bbc.co.uk.")).toBe(
      "try [example.com](https://www.example.com/a?b=1) and [google.com](https://google.com), or [bbc.co.uk](https://bbc.co.uk).",
    )
    expect(linkifyPastedText("socket.io/docs")).toBe("[socket.io](https://socket.io/docs)")
    expect(linkifyPastedText("GOOGLE.COM")).toBe("[google.com](https://GOOGLE.COM)")
  })

  it("leaves words, files, versions, emails and paths alone", () => {
    for (const text of [
      "node.js and Next.js",
      "open file.txt",
      "v1.2.3 shipped, e.g. today",
      "see docs/links.md",
      "mail finn@gmail.com",
      "a.b",
      "sub.example.com.au",
    ]) {
      expect(linkifyPastedText(text), text).toBe(text)
    }
  })

  it("leaves links already written out, images, autolinks and code alone", () => {
    for (const text of [
      "[the guide](https://e.com/g) first",
      "![pic](https://e.com/a.png)",
      "<https://e.com/x>",
      "run `curl https://e.com/x` now",
      "```\ncurl https://e.com/x\n```",
      "plain text, no address",
    ]) {
      expect(linkifyPastedText(text)).toBe(text)
    }
    expect(linkifyPastedText("[x](https://e.com/a) and https://e.com/b")).toBe(
      "[x](https://e.com/a) and [e.com](https://e.com/b)",
    )
  })
})

describe("linkifyTypedAddress", () => {
  it("writes out an address once a space is typed after it, and places the caret", () => {
    const text = "see https://www.e.com/x "
    expect(linkifyTypedAddress(text, text.length)).toEqual({
      text: "see [e.com](https://www.e.com/x) ",
      caret: "see [e.com](https://www.e.com/x) ".length,
    })
    // Mid-text: what follows the caret is kept.
    expect(linkifyTypedAddress("https://e.com/a. then", "https://e.com/a. ".length)).toEqual({
      text: "[e.com](https://e.com/a). then",
      caret: "[e.com](https://e.com/a). ".length,
    })
  })

  it("leaves alone what is not a bare address before a typed space", () => {
    for (const text of [
      "see [x](https://e.com/x) ",
      "<https://e.com/x> ",
      "`https://e.com/x` ",
      "see https://e.com/x",
      "plain words ",
      "(https://e.com/x ",
      "node.js ",
      "finn@gmail.com ",
    ]) {
      expect(linkifyTypedAddress(text, text.length), text).toBeNull()
    }
    expect(linkifyTypedAddress("try google.com ", "try google.com ".length)).toEqual({
      text: "try [google.com](https://google.com) ",
      caret: "try [google.com](https://google.com) ".length,
    })
  })
})

describe("linksInText", () => {
  it("lists a block's links in order, bare or written out", () => {
    expect(
      linksInText(
        "Read [the guide](https://e.com/g), then https://e.com/x or bbc.co.uk. And [top](#top).",
      ),
    ).toEqual([
      { href: "https://e.com/g", title: "the guide" },
      { href: "https://e.com/x", title: "https://e.com/x" },
      { href: "https://bbc.co.uk", title: "bbc.co.uk" },
    ])
    expect(linksInText("no links")).toEqual([])
  })
})
