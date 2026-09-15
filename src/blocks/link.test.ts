import { describe, expect, it } from "vitest"
import { hostOf, isWebUrl, linkifyPastedText } from "./link"

describe("hostOf", () => {
  it("names the host, without www, as the display text of an address", () => {
    expect(hostOf("https://www.example.co.uk/a?b")).toBe("example.co.uk")
    expect(hostOf("https://mail.google.com/mail/u/0/#inbox/abc?x=1")).toBe("mail.google.com")
    expect(hostOf("not a url")).toBe("not a url")
    expect(isWebUrl("https://e.com/")).toBe(true)
    expect(isWebUrl("ftp://e.com/")).toBe(false)
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
