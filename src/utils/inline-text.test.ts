import { describe, expect, it } from "vitest"
import { inlineText } from "./inline-text"

describe("inlineText", () => {
  it("strips the inline marks a row cannot render, keeping their text", () => {
    expect(inlineText("🌿 **Grow**: Connect your _notes_ with `links`.")).toBe(
      "🌿 Grow: Connect your notes with links.",
    )
    expect(inlineText("see [the docs](https://example.com) and ![alt](x.png)")).toBe(
      "see the docs and alt",
    )
    expect(inlineText("__bold__ and *it*")).toBe("bold and it")
  })

  it("leaves a mark inside a word, and everything else, alone", () => {
    expect(inlineText("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4")
    expect(inlineText("$$a^2$$ stays")).toBe("$$a^2$$ stays")
  })

  it("is one line", () => {
    expect(inlineText("  a\n  b  ")).toBe("a b")
    expect(inlineText("")).toBe("")
  })
})
