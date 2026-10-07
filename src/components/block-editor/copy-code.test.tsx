// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import { BlockContent } from "./block-content"
import { BlockEditor } from "./block-editor"

/** What a copy button put on the clipboard. */
const clipboard = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock("copy-to-clipboard", () => ({ default: clipboard.copy }))

afterEach(() => {
  cleanup()
  clipboard.copy.mockReset()
})

const CODE = "```ts\nconst a = 1\n  b()\n```"

describe("copying code", () => {
  it("copies an inline code chip's text from the button beside it", () => {
    const { container } = render(<BlockContent content="Run `npm test` first" />)
    const chip = container.querySelector("code")!
    const button = chip.querySelector<HTMLElement>('[data-testid="copy-code"]')!
    expect(button.getAttribute("aria-label")).toBe("Copy code")
    fireEvent.click(button)
    expect(clipboard.copy).toHaveBeenCalledWith("npm test")
    expect(button.getAttribute("aria-label")).toBe("Copied")
  })

  it("puts the button inside a chip wide enough to hold it, and outside a short one", () => {
    const { container } = render(<BlockContent content="Run `npm run test:watch` or `x`" />)
    const [long, short] = Array.from(container.querySelectorAll("code"))
    const placement = (chip: Element) =>
      chip.querySelector("[data-placement]")!.getAttribute("data-placement")
    vi.spyOn(long, "getBoundingClientRect").mockReturnValue({ width: 160 } as DOMRect)
    vi.spyOn(short, "getBoundingClientRect").mockReturnValue({ width: 24 } as DOMRect)
    fireEvent.pointerEnter(long)
    fireEvent.pointerEnter(short)
    expect(placement(long)).toBe("inside")
    expect(placement(short)).toBe("outside")
  })

  it("copies a code block's text from the layout toolbar in an editable editor", () => {
    const { container } = render(<BlockEditor doc={parse(CODE)} onChange={() => {}} />)
    const toolbar = container.querySelector('[data-testid="code-toolbar"]')!
    fireEvent.click(toolbar.querySelector('[data-testid="copy-code"]')!)
    expect(clipboard.copy).toHaveBeenCalledWith("const a = 1\n  b()")
  })

  it("copies a code block's text from the panel's corner when read only", () => {
    const { container } = render(<BlockEditor doc={parse(CODE)} onChange={() => {}} readOnly />)
    expect(container.querySelector('[data-testid="code-toolbar"]')).toBeNull()
    const panel = container.querySelector('[data-testid="code-panel"]')!
    fireEvent.click(panel.querySelector('[data-testid="copy-code"]')!)
    expect(clipboard.copy).toHaveBeenCalledWith("const a = 1\n  b()")
  })
})
