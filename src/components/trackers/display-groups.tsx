import React from "react"
import { TRACKER_RANGES, type TrackerRange } from "../../data/tracker"
import { DropdownMenu } from "../ui/dropdown-menu"

const RANGE_LABELS: Record<TrackerRange, string> = { week: "Week", month: "Month", year: "Year" }

const LAYOUTS = ["cards", "grid"] as const
export type TrackerLayout = (typeof LAYOUTS)[number]
const LAYOUT_LABELS: Record<TrackerLayout, string> = { cards: "Cards", grid: "Grid" }

/**
 * The display options, in the note's ⋯ menu on a phone and a desktop alike
 * (Finn, 2026-10-29): the range and the layout, as two groups of which one
 * row each is ticked. A pick leaves the menu open, so both can be set at
 * once. On a narrow window the Range group starts with **Heatmap**: the
 * activity card (activity.tsx), ticked instead of a range while it is the
 * view shown. A wide window shows the card beside the range, so it has no
 * Heatmap row.
 */
export function DisplayGroups({
  range,
  layout,
  heatmap,
  onHeatmap,
  onRangeChange,
  onLayoutChange,
}: {
  range: TrackerRange
  layout: TrackerLayout
  /** On a narrow window, whether the activity card is shown (the Heatmap
   * row is ticked); undefined on a wide one, which has no Heatmap row. */
  heatmap: boolean | undefined
  onHeatmap: () => void
  onRangeChange: (range: TrackerRange) => void
  onLayoutChange: (layout: TrackerLayout) => void
}) {
  return (
    <>
      <DropdownMenu.Group>
        <DropdownMenu.GroupLabel>Range</DropdownMenu.GroupLabel>
        {heatmap !== undefined ? (
          <DropdownMenu.Item closeOnClick={false} selected={heatmap} onClick={onHeatmap}>
            Heatmap
          </DropdownMenu.Item>
        ) : null}
        {TRACKER_RANGES.map((option) => (
          <DropdownMenu.Item
            key={option}
            closeOnClick={false}
            selected={option === range && heatmap !== true}
            onClick={() => onRangeChange(option)}
          >
            {RANGE_LABELS[option]}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Group>
        <DropdownMenu.GroupLabel>Layout</DropdownMenu.GroupLabel>
        {LAYOUTS.map((option) => (
          <DropdownMenu.Item
            key={option}
            closeOnClick={false}
            selected={option === layout}
            onClick={() => onLayoutChange(option)}
          >
            {LAYOUT_LABELS[option]}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Group>
    </>
  )
}
