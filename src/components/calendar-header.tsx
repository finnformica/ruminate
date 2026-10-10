import { addDays, addWeeks, parseISO, startOfToday } from "date-fns"
import { useNavigate } from "@tanstack/react-router"
import React from "react"
import {
  formatDate,
  formatDateDistance,
  formatWeek,
  formatWeekDistance,
  isValidWeekString,
  toDateString,
  toWeekString,
} from "../utils/date"
import { Button } from "./ui/button"
import { IconButton } from "./ui/icon-button"
import { ChevronLeftIcon16, ChevronRightIcon16 } from "./icons"

/** The day or week on the page, named, with the way to the one before, the
 * one after, and back to today. */
export function CalendarHeader({ activeId }: { activeId: string }) {
  const navigate = useNavigate()
  const isWeekly = isValidWeekString(activeId)

  const primaryText = isWeekly ? formatWeek(activeId) : formatDate(activeId)
  const secondaryText = isWeekly ? formatWeekDistance(activeId) : formatDateDistance(activeId)

  const today = startOfToday()
  const todayString = toDateString(today)
  const thisWeekString = toWeekString(today)

  const go = React.useCallback(
    (target: string) => navigate({ to: "/calendar/$", params: { _splat: target }, search: {} }),
    [navigate],
  )
  const navigateByInterval = React.useCallback(
    (direction: "previous" | "next") => {
      const date = parseISO(activeId)
      const increment = direction === "next" ? 1 : -1
      go(
        isWeekly ? toWeekString(addWeeks(date, increment)) : toDateString(addDays(date, increment)),
      )
    },
    [isWeekly, activeId, go],
  )

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col min-w-0">
        <span className="font-bold text-text text-lg leading-8 truncate coarse:leading-10">
          {primaryText}
        </span>
        <span className="text-text-secondary">{secondaryText}</span>
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => go(isWeekly ? thisWeekString : todayString)}
          disabled={isWeekly ? activeId === thisWeekString : activeId === todayString}
        >
          {isWeekly ? "This week" : "Today"}
        </Button>
        <div className="flex rounded bg-bg-secondary">
          <IconButton
            aria-label={isWeekly ? "Previous week" : "Previous day"}
            onClick={() => navigateByInterval("previous")}
          >
            <ChevronLeftIcon16 />
          </IconButton>
          <IconButton
            aria-label={isWeekly ? "Next week" : "Next day"}
            onClick={() => navigateByInterval("next")}
          >
            <ChevronRightIcon16 />
          </IconButton>
        </div>
      </div>
    </div>
  )
}
