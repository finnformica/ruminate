// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { MarkdownContent } from "./markdown"

afterEach(cleanup)

describe("MarkdownContent", () => {
  test("renders [[...]] as literal text — wikilinks are not a feature", () => {
    render(<MarkdownContent>{"Some [[foo]] text"}</MarkdownContent>)

    // The brackets stay in the text and no link is rendered.
    expect(screen.getByText(/Some \[\[foo\]\] text/)).toBeDefined()
    expect(document.querySelector("a")).toBe(null)
    expect(document.querySelector("wikilink")).toBe(null)
  })

  test("renders ![[...]] embed syntax as literal text", () => {
    render(<MarkdownContent>{"Before ![[1234|Some note]] after"}</MarkdownContent>)

    expect(screen.getByText(/Before !\[\[1234\|Some note\]\] after/)).toBeDefined()
    expect(document.querySelector("embed")).toBe(null)
  })

  test("still renders regular markdown links", () => {
    render(<MarkdownContent>{"[https://example.com](https://example.com)"}</MarkdownContent>)

    const anchor = document.querySelector("a")
    expect(anchor?.getAttribute("href")).toBe("https://example.com")
  })
})
