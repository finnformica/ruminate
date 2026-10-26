import { describe, expect, it } from "vitest"
import { arrowOfTyped, drawArrows } from "./arrows"

/** The rule run on `text` as typed, the caret at its end. */
const typedAtEnd = (text: string) => arrowOfTyped(text, text.length)

describe("arrowOfTyped", () => {
  it("turns -> into →, <- into ←, and => into ⇒", () => {
    expect(typedAtEnd("a ->")).toEqual({ text: "a →", caret: 3, typed: "a ->" })
    expect(typedAtEnd("a <-")).toEqual({ text: "a ←", caret: 3, typed: "a <-" })
    expect(typedAtEnd("a =>")).toEqual({ text: "a ⇒", caret: 3, typed: "a =>" })
  })

  it("turns ← then > into ↔, the typed <-> what an undo gives back", () => {
    expect(typedAtEnd("a ←>")).toEqual({ text: "a ↔", caret: 3, typed: "a <->" })
  })

  it("turns a <-> left as typed into ↔", () => {
    expect(typedAtEnd("a <->")).toEqual({ text: "a ↔", caret: 3, typed: "a <->" })
  })

  it("turns an arrow typed mid-text, the caret after it", () => {
    expect(arrowOfTyped("a -> b", 4)).toEqual({ text: "a → b", caret: 3, typed: "a -> b" })
  })

  it("leaves text that ends in no arrow", () => {
    expect(typedAtEnd("a -")).toBeNull()
    expect(typedAtEnd("a >")).toBeNull()
    expect(typedAtEnd("a >=")).toBeNull()
    expect(arrowOfTyped("a -> b", 6)).toBeNull()
  })

  it("leaves an arrow in a code span, and turns one after it", () => {
    expect(typedAtEnd("call `a->")).toBeNull()
    expect(typedAtEnd("call `a->b` ->")?.text).toBe("call `a->b` →")
  })

  it("leaves an arrow in $$…$$ maths, and turns one after it", () => {
    expect(typedAtEnd("$$a ->")).toBeNull()
    expect(typedAtEnd("$$a$$ ->")?.text).toBe("$$a$$ →")
  })
})

describe("drawArrows", () => {
  it("draws each arrow stored as typed, <-> as one arrow", () => {
    expect(drawArrows("a -> b <- c <-> d => e")).toBe("a → b ← c ↔ d ⇒ e")
  })
})
