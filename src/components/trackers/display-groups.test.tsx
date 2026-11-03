// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DisplayGroups } from "./display-groups"

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/trackers/n1" }),
}))

const { NoteActionsMenu } = await import("../note-actions-menu")

/**
 * The tracker's display options in the note menu: Heatmap and Cards, one
 * of them ticked, and nothing else (Finn, 2026-11-02).
 */

afterEach(cleanup)

function renderMenu(view: "heatmap" | "cards") {
  const onViewChange = vi.fn()
  render(
    <Provider store={createStore()}>
      <NoteActionsMenu
        noteId="n1"
        surface="tracker"
        groups={<DisplayGroups view={view} onViewChange={onViewChange} />}
      />
    </Provider>,
  )
  return { onViewChange }
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Note actions" }))
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
}

/** The rows of the menu, each with a tick when it is the one picked. */
const rows = () =>
  screen
    .getAllByRole("menuitem")
    .map((item) => `${item.textContent}${item.querySelector("svg") ? " ✓" : ""}`)

describe("the tracker's display options", () => {
  it("offers Heatmap and Cards, ticking the one shown", async () => {
    const { onViewChange } = renderMenu("heatmap")
    await openMenu()
    expect(rows().slice(0, 2)).toEqual(["Heatmap ✓", "Cards"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Cards" }))
    expect(onViewChange).toHaveBeenCalledWith("cards")
    expect(screen.getByRole("menu")).toBeTruthy()
  })

  it("has no week, month, year or grid rows", async () => {
    renderMenu("cards")
    await openMenu()
    expect(rows().slice(0, 2)).toEqual(["Heatmap", "Cards ✓"])
    for (const name of ["Week", "Month", "Year", "Grid"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull()
    }
  })
})
