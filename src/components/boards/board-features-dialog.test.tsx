// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BoardFeatureState } from "../../data/boards"
import type { BoardWrites } from "../../hooks/board"
import { BoardFeaturesDialog } from "./board-features-dialog"

/** Whether a model can be asked, and whether the pointer is a finger, as
 * the dialog reads them — set per test. */
const ai = vi.hoisted(() => ({ available: false }))
const pointer = vi.hoisted(() => ({ coarse: false }))
vi.mock("../../hooks/ai", () => ({
  useAiAvailable: () => ({ available: ai.available, provider: ai.available ? "anthropic" : null }),
}))
vi.mock("../../hooks/coarse-pointer", () => ({ useCoarsePointer: () => pointer.coarse }))

afterEach(cleanup)

const FEATURES: BoardFeatureState[] = [
  {
    feature: { id: "f1", label: "Location", type: "place", multi: false, notes: "where" },
    values: [],
  },
  { feature: { id: "f2", label: "Link", type: "link", multi: true, notes: "" }, values: [] },
]

const writes = {
  addFeature: () => null,
  updateFeature: () => {},
  removeFeature: () => {},
} as unknown as BoardWrites

const dialog = () =>
  render(<BoardFeaturesDialog open features={FEATURES} writes={writes} onClose={() => {}} />)

describe("BoardFeaturesDialog", () => {
  it("is a table of the features with Name and Multiple, and Notes only while a model can be asked", () => {
    ai.available = false
    dialog()
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "Multiple" })).toBeTruthy()
    expect(screen.queryByRole("columnheader", { name: "Notes" })).toBeNull()
    expect(screen.queryByLabelText(/^Notes on/)).toBeNull()
    expect(screen.getAllByTestId("board-feature")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Type: Place" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove Location" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add feature" })).toBeTruthy()
    cleanup()

    ai.available = true
    dialog()
    expect(screen.getByRole("columnheader", { name: "Notes" })).toBeTruthy()
    // Notes for the place feature, none for the link.
    expect(screen.getAllByLabelText(/^Notes on/)).toHaveLength(1)
    expect((screen.getByLabelText("Notes on Location") as HTMLTextAreaElement).value).toBe("where")
  })

  it("is a sheet on a coarse pointer, with the same cells", () => {
    ai.available = true
    pointer.coarse = true
    dialog()
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.getAllByTestId("board-feature")).toHaveLength(2)
    expect(screen.getAllByLabelText("Name")).toHaveLength(2)
    expect(screen.getAllByLabelText("Multiple values")).toHaveLength(2)
    expect(screen.getAllByLabelText(/^Notes on/)).toHaveLength(1)
    pointer.coarse = false
  })
})
