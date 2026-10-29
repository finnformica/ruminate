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
 * The tracker's display options in the note menu: on a narrow window the
 * Range group starts with Heatmap, ticked while the activity card is the
 * view; a wide window has no Heatmap row.
 */

afterEach(cleanup)

function renderMenu(heatmap: boolean | undefined) {
  const onHeatmap = vi.fn()
  const onRangeChange = vi.fn()
  render(
    <Provider store={createStore()}>
      <NoteActionsMenu
        noteId="n1"
        surface="tracker"
        groups={
          <DisplayGroups
            range="month"
            layout="cards"
            heatmap={heatmap}
            onHeatmap={onHeatmap}
            onRangeChange={onRangeChange}
            onLayoutChange={vi.fn()}
          />
        }
      />
    </Provider>,
  )
  return { onHeatmap, onRangeChange }
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
  it("starts the Range group with Heatmap on a narrow window, ticked in the activity view", async () => {
    const { onHeatmap } = renderMenu(true)
    await openMenu()
    expect(rows().slice(0, 4)).toEqual(["Heatmap ✓", "Week", "Month", "Year"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Heatmap" }))
    expect(onHeatmap).toHaveBeenCalled()
    expect(screen.getByRole("menu")).toBeTruthy()
  })

  it("ticks the range instead in the range view", async () => {
    renderMenu(false)
    await openMenu()
    expect(rows().slice(0, 4)).toEqual(["Heatmap", "Week", "Month ✓", "Year"])
  })

  it("has no Heatmap row on a wide window", async () => {
    const { onRangeChange } = renderMenu(undefined)
    await openMenu()
    expect(screen.queryByRole("menuitem", { name: "Heatmap" })).toBeNull()
    expect(rows().slice(0, 3)).toEqual(["Week", "Month ✓", "Year"])
    fireEvent.click(screen.getByRole("menuitem", { name: "Year" }))
    expect(onRangeChange).toHaveBeenCalledWith("year")
  })
})
