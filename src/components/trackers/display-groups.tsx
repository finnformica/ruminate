import React from "react"
import { DropdownMenu } from "../ui/dropdown-menu"

const VIEWS = ["heatmap", "cards"] as const
/** What a narrow window shows under the Today strip: the activity card
 * (activity.tsx) or the month's cards (month-grid.tsx). */
export type TrackerView = (typeof VIEWS)[number]
const VIEW_LABELS: Record<TrackerView, string> = { heatmap: "Heatmap", cards: "Cards" }

/**
 * The display options, in the note's ⋯ menu on a narrow window: **Heatmap**
 * or **Cards**, one of them ticked (Finn, 2026-11-02). A wide window shows
 * the two side by side, so its menu has no display options. The week, the
 * year and the journal grid are gone.
 */
export function DisplayGroups({
  view,
  onViewChange,
}: {
  view: TrackerView
  onViewChange: (view: TrackerView) => void
}) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.GroupLabel>Display</DropdownMenu.GroupLabel>
      {VIEWS.map((option) => (
        <DropdownMenu.Item
          key={option}
          closeOnClick={false}
          selected={option === view}
          onClick={() => onViewChange(option)}
        >
          {VIEW_LABELS[option]}
        </DropdownMenu.Item>
      ))}
    </DropdownMenu.Group>
  )
}
