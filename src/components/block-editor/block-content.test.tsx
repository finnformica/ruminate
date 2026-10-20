// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { BlockContent } from "./block-content"

afterEach(cleanup)

describe("BlockContent maths", () => {
  it("sets $$…$$ within a line as inline MathML", () => {
    const { container } = render(<BlockContent content="Einstein: $$E = mc^2$$ (1905)" />)
    const math = container.querySelector("math")
    expect(math).not.toBeNull()
    expect(math?.getAttribute("display")).toBeNull()
    expect(container.textContent).toContain("Einstein:")
    expect(container.textContent).toContain("(1905)")
    expect(container.querySelector(".katex-html")).toBeNull()
  })

  it("sets a line that is only maths in display mode", () => {
    const { container } = render(<BlockContent content="$$\\int_0^1 x^2 \\, dx$$" />)
    expect(container.querySelector("math")?.getAttribute("display")).toBe("block")
  })

  it("keeps each line of a multi-line block independent", () => {
    const { container } = render(<BlockContent content={"Proof:\n$$a^2 + b^2 = c^2$$"} />)
    const maths = container.querySelectorAll("math")
    expect(maths).toHaveLength(1)
    expect(maths[0].getAttribute("display")).toBe("block")
  })

  it("leaves single-dollar text alone", () => {
    const { container } = render(<BlockContent content="Costs $5 to $10 a day" />)
    expect(container.querySelector("math")).toBeNull()
    expect(container.textContent).toBe("Costs $5 to $10 a day")
  })

  it("shows a $$ that never closes as typed", () => {
    const { container } = render(<BlockContent content="Opening $$ only" />)
    expect(container.querySelector("math")).toBeNull()
    expect(container.textContent).toBe("Opening $$ only")
  })
})

describe("BlockContent arrows", () => {
  it("draws -> as an arrow", () => {
    const { container } = render(<BlockContent content="Idea -> draft -> note" />)
    expect(container.textContent).toBe("Idea → draft → note")
  })

  it("draws an arrow inside formatting and a link's text", () => {
    const { container } = render(
      <BlockContent content="**a -> b** and [x -> y](https://example.com/a->b)" />,
    )
    expect(container.querySelector("strong")?.textContent).toBe("a → b")
    const link = container.querySelector("a")
    expect(link?.textContent).toBe("x → y")
    expect(link?.getAttribute("href")).not.toContain("→")
  })

  it("leaves -> in a code span as typed", () => {
    const { container } = render(<BlockContent content="Call `a->b` -> done" />)
    expect(container.querySelector("code")?.firstChild?.textContent).toBe("a->b")
    expect(container.textContent).toContain("a->b")
    expect(container.textContent).toContain("→ done")
  })

  it("leaves -> in maths to KaTeX", () => {
    const { container } = render(<BlockContent content="$$a -> b$$" />)
    expect(container.querySelector("math")).not.toBeNull()
    expect(container.textContent).not.toContain("→")
  })
})
