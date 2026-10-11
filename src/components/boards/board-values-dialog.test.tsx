// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BoardFeatureState } from "../../data/boards"
import type { BoardWrites } from "../../hooks/board"
import { BoardValuesDialog } from "./board-values-dialog"

afterEach(cleanup)

const LOCATION: BoardFeatureState = {
  feature: { id: "f1", label: "Location", type: "place", multi: false, notes: "" },
  values: [
    { id: "v1", text: "Mauritius" },
    { id: "v2", text: "Lisbon" },
  ],
}

function writesWith(renamed = true) {
  const renameValue = vi.fn(() => renamed)
  const deleteValue = vi.fn()
  return {
    writes: { renameValue, deleteValue } as unknown as BoardWrites,
    renameValue,
    deleteValue,
  }
}

describe("BoardValuesDialog", () => {
  it("lists the feature's values, each a name to edit and a delete", () => {
    const { writes } = writesWith()
    render(<BoardValuesDialog state={LOCATION} writes={writes} onClose={() => {}} />)
    expect(screen.getByRole("dialog", { name: "Location values" })).toBeTruthy()
    expect(screen.getAllByTestId("board-value")).toHaveLength(2)
    expect((screen.getByLabelText("Name of Mauritius") as HTMLInputElement).value).toBe("Mauritius")
    expect(screen.getByRole("button", { name: "Delete Lisbon" })).toBeTruthy()
  })

  it("says so when there are none, and draws nothing while no feature is open", () => {
    const { writes } = writesWith()
    render(
      <BoardValuesDialog state={{ ...LOCATION, values: [] }} writes={writes} onClose={() => {}} />,
    )
    expect(screen.getByText("No values yet.")).toBeTruthy()
    cleanup()
    render(<BoardValuesDialog state={null} writes={writes} onClose={() => {}} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("renames on Enter or on leaving the box, and puts a refused name back", () => {
    const { writes, renameValue } = writesWith(false)
    render(<BoardValuesDialog state={LOCATION} writes={writes} onClose={() => {}} />)
    const box = screen.getByLabelText("Name of Mauritius") as HTMLInputElement
    fireEvent.change(box, { target: { value: "Lisbon" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(renameValue).toHaveBeenCalledWith("f1", "v1", "Lisbon")
    // Refused — Lisbon is taken — so the box shows the name it has.
    expect(box.value).toBe("Mauritius")
    // Nothing is written for the name it already has.
    fireEvent.blur(box)
    expect(renameValue).toHaveBeenCalledTimes(1)
  })

  it("asks before deleting, naming the value, and deletes on Delete", () => {
    const { writes, deleteValue } = writesWith()
    render(<BoardValuesDialog state={LOCATION} writes={writes} onClose={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Delete Mauritius" }))
    const question = screen.getByRole("alertdialog", { name: "Delete “Mauritius”?" })
    expect(question.textContent).toContain("This cannot be undone.")
    expect(deleteValue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(deleteValue).toHaveBeenCalledWith("f1", "v1")
  })
})
