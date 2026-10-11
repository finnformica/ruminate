import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  eachWeekOfInterval,
  endOfMonth,
  getISOWeek,
  nextSunday,
  parseISO,
  startOfISOWeek,
  startOfMonth,
} from "date-fns"
import { useAtom } from "jotai"
import React from "react"
import { Link } from "@tanstack/react-router"
import { calendarLayoutAtom } from "../global-state"
import { cx } from "../utils/cx"
import { DAY_NAMES, MONTH_NAMES, formatWeek, toDateString, toWeekString } from "../utils/date"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"
import { ChevronDownIcon16, ChevronUpIcon16, MoreIcon16, UndoIcon16 } from "./icons"
import { surface } from "./ui/surface"

/**
 * The calendar's strip (a week) or grid (a month): a way to the day pages
 * (`/calendar/<day>`) and the week pages (`/calendar/<week>`). A day is
 * dotted when something was written on it, or a note names the date
 * (`marked`, docs/event-sourcing.md); a week when any of its days is.
 */
export function Calendar({
  activeId,
  marked,
  className,
}: {
  /** The day or week on the page. */
  activeId: string
  /** The days and weeks with something to show. */
  marked: ReadonlySet<string>
  className?: string
}) {
  const date = parseISO(activeId)
  const [layout, setLayout] = useAtom(calendarLayoutAtom)

  // Local state for the displayed date anchor (independent of activeId)
  const [displayedDate, setDisplayedDate] = React.useState(() => date)

  // Sync displayed date when activeId changes (adjust state during render)
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevActiveId, setPrevActiveId] = React.useState(activeId)
  if (activeId !== prevActiveId) {
    setPrevActiveId(activeId)
    setDisplayedDate(date)
  }

  const displayedWeekStart = React.useMemo(() => startOfISOWeek(displayedDate), [displayedDate])
  const displayedMonthStart = React.useMemo(() => startOfMonth(displayedDate), [displayedDate])
  const endOfWeek = React.useMemo(() => nextSunday(displayedWeekStart), [displayedWeekStart])

  const daysOfWeek = React.useMemo(
    () => eachDayOfInterval({ start: displayedWeekStart, end: endOfWeek }),
    [displayedWeekStart, endOfWeek],
  )

  const navigateByWeek = React.useCallback((direction: "previous" | "next") => {
    const increment = direction === "next" ? 1 : -1
    setDisplayedDate((prev) => addWeeks(prev, increment))
  }, [])

  const navigateByMonth = React.useCallback((direction: "previous" | "next") => {
    const increment = direction === "next" ? 1 : -1
    setDisplayedDate((prev) => addMonths(prev, increment))
  }, [])

  // Check if displayed week differs from the active week
  const activeWeekStart = React.useMemo(() => startOfISOWeek(date), [date])
  const activeMonthStart = React.useMemo(() => startOfMonth(date), [date])

  const canResetWeek = toWeekString(displayedWeekStart) !== toWeekString(activeWeekStart)
  const canResetMonth =
    displayedMonthStart.getMonth() !== activeMonthStart.getMonth() ||
    displayedMonthStart.getFullYear() !== activeMonthStart.getFullYear()
  const canReset = layout === "week" ? canResetWeek : canResetMonth

  const resetToActive = React.useCallback(() => {
    setDisplayedDate(date)
  }, [date])

  // Calculate weeks in displayed month for month view
  const weeksInMonth = React.useMemo(() => {
    const monthEnd = endOfMonth(displayedMonthStart)
    return eachWeekOfInterval(
      { start: displayedMonthStart, end: monthEnd },
      { weekStartsOn: 1 }, // Monday
    )
  }, [displayedMonthStart])

  // Display date for header
  const displayDate = layout === "week" ? displayedWeekStart : displayedMonthStart

  const navigate = layout === "week" ? navigateByWeek : navigateByMonth
  const periodLabel = layout === "week" ? "week" : "month"

  return (
    <div className={cx(surface({ tier: "card" }), "overflow-hidden rounded-xl!", className)}>
      <div className="flex flex-col gap-2 overflow-hidden">
        <div className="flex items-center justify-between pt-2 px-2">
          <span className="font-content px-2">
            <span className="font-bold">{MONTH_NAMES[displayDate.getMonth()]}</span>{" "}
            {displayDate.getFullYear()}
          </span>
          <div className="flex">
            {canReset ? (
              <IconButton aria-label={`Back to selected ${periodLabel}`} onClick={resetToActive}>
                <UndoIcon16 />
              </IconButton>
            ) : null}

            <IconButton aria-label={`Previous ${periodLabel}`} onClick={() => navigate("previous")}>
              <ChevronUpIcon16 />
            </IconButton>
            <IconButton aria-label={`Next ${periodLabel}`} onClick={() => navigate("next")}>
              <ChevronDownIcon16 />
            </IconButton>
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <IconButton aria-label="Calendar options" disableTooltip>
                    <MoreIcon16 />
                  </IconButton>
                }
              />
              <DropdownMenu.Content align="end" width={160}>
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>Layout</DropdownMenu.GroupLabel>
                  <DropdownMenu.Item onClick={() => setLayout("week")} selected={layout === "week"}>
                    Week
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={() => setLayout("month")}
                    selected={layout === "month"}
                  >
                    Month
                  </DropdownMenu.Item>
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </div>
        {layout === "week" ? (
          <div className="grid pb-2 px-2">
            <div className="flex gap-1.5 items-center">
              <CalendarWeek
                startOfWeek={displayedWeekStart}
                isActive={toWeekString(displayedWeekStart) === activeId}
                marked={marked}
              />
              <div role="separator" className="h-8 w-px shrink-0 bg-border-secondary" />
              {daysOfWeek.map((day) => (
                <CalendarDate
                  key={day.toISOString()}
                  date={day}
                  isActive={toDateString(day) === activeId}
                  marked={marked}
                />
              ))}
            </div>
          </div>
        ) : (
          <MonthGrid
            weeksInMonth={weeksInMonth}
            displayedMonth={displayedMonthStart.getMonth()}
            activeId={activeId}
            marked={marked}
          />
        )}
      </div>
    </div>
  )
}

function CalendarWeek({
  startOfWeek,
  isActive = false,
  marked,
}: {
  startOfWeek: Date
  isActive?: boolean
  marked: ReadonlySet<string>
}) {
  const weekString = toWeekString(startOfWeek)
  return (
    <CalendarItem
      id={weekString}
      aria-label={formatWeek(weekString)}
      name="Week"
      shortName="W"
      number={getISOWeek(startOfWeek)}
      isActive={isActive}
      hasChanges={marked.has(weekString)}
    />
  )
}

const dayLabel = (date: Date) =>
  `${DAY_NAMES[date.getDay()]}, ${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`

function CalendarDate({
  date,
  isActive = false,
  marked,
}: {
  date: Date
  isActive?: boolean
  marked: ReadonlySet<string>
}) {
  const dateString = toDateString(date)
  const dayName = DAY_NAMES[date.getDay()]
  return (
    <CalendarItem
      id={dateString}
      aria-label={dayLabel(date)}
      name={dayName.slice(0, 3)}
      shortName={dayName.slice(0, 2)}
      number={date.getDate()}
      isActive={isActive}
      isToday={dateString === toDateString(new Date())}
      hasChanges={marked.has(dateString)}
    />
  )
}

function CalendarItem({
  "aria-label": ariaLabel,
  name,
  shortName,
  number,
  id,
  isActive = false,
  isToday = false,
  hasChanges = false,
}: {
  "aria-label": string
  name: string
  shortName: string
  number: number
  id: string
  isActive?: boolean
  isToday?: boolean
  hasChanges?: boolean
}) {
  return (
    <Link
      to="/calendar/$"
      params={{ _splat: id }}
      search={{}}
      aria-label={ariaLabel}
      className={cx(
        "focus-ring relative flex w-full cursor-pointer justify-center rounded p-4 leading-4 text-text @container",
        !isActive && "hover:bg-bg-hover active:bg-bg-active",
        // The day you are looking at is a place, like the sidebar's current
        // note, so it takes the app-wide selected surface and ink.
        isActive &&
          "font-bold bg-bg-selected text-text-selected hover:bg-bg-selected-hover active:bg-bg-selected-active",
        // A dot under a day something was written on.
        hasChanges &&
          "after:pointer-events-none after:absolute after:bottom-1 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:content-['']",
        hasChanges && isActive && "after:bg-text-secondary",
        hasChanges && !isActive && "after:bg-border",
      )}
    >
      <div className="flex flex-col items-center gap-1 @[3rem]:flex-row @[3rem]:gap-2 coarse:gap-2">
        <span className="@[3rem]:hidden">{shortName}</span>
        {/* Show full name when there's enough space */}
        <span className="hidden @[3rem]:inline">{name}</span>
        <span
          className={cx(
            isToday && "-mx-1 -my-[0.125rem] rounded-sm px-1 py-[0.125rem] leading-[1.2]",
            isToday && !isActive && "shadow-[inset_0_0_0_1px_var(--color-text-secondary)]",
            isToday && isActive && "bg-text text-bg",
          )}
        >
          {number}
        </span>
      </div>
    </Link>
  )
}

// Short day labels for month view header (Monday first)
const SHORT_DAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

function MonthGrid({
  weeksInMonth,
  displayedMonth,
  activeId,
  marked,
}: {
  weeksInMonth: Date[]
  displayedMonth: number
  activeId: string
  marked: ReadonlySet<string>
}) {
  return (
    <div className="@container">
      <div className="grid grid-cols-8 @[448px]:grid-cols-[48px_repeat(7,1fr)]">
        {/* Day labels header */}
        <div className="col-span-8 grid grid-cols-subgrid border-b border-[var(--neutral-a3)]">
          <div className="flex h-8 items-center justify-center text-text-secondary">W</div>
          {SHORT_DAY_LABELS.map((day) => (
            <div key={day} className="flex h-8 items-center justify-center text-text-secondary">
              {day}
            </div>
          ))}
        </div>
        {/* Week rows */}
        {weeksInMonth.map((weekStart, index) => (
          <MonthWeekRow
            key={weekStart.toISOString()}
            weekStart={weekStart}
            displayedMonth={displayedMonth}
            activeId={activeId}
            marked={marked}
            isLastRow={index === weeksInMonth.length - 1}
          />
        ))}
      </div>
    </div>
  )
}

function MonthWeekRow({
  weekStart,
  displayedMonth,
  activeId,
  marked,
  isLastRow,
}: {
  weekStart: Date
  displayedMonth: number
  activeId: string
  marked: ReadonlySet<string>
  isLastRow: boolean
}) {
  // Get the Monday of this week (weekStart should already be Monday from eachWeekOfInterval)
  const mondayOfWeek = startOfISOWeek(weekStart)
  const weekString = toWeekString(mondayOfWeek)
  const weekNumber = getISOWeek(mondayOfWeek)
  const hasWeekChanges = marked.has(weekString)

  const daysOfWeek = React.useMemo(() => {
    const endOfWeek = addDays(mondayOfWeek, 6)
    return eachDayOfInterval({ start: mondayOfWeek, end: endOfWeek })
  }, [mondayOfWeek])

  const isWeekActive = weekString === activeId

  return (
    <div
      className={cx(
        "col-span-8 grid grid-cols-subgrid divide-x divide-[var(--neutral-a3)]",
        !isLastRow && "border-b border-[var(--neutral-a3)]",
      )}
    >
      {/* Week number link */}
      <div>
        <Link
          to="/calendar/$"
          params={{ _splat: weekString }}
          search={{}}
          aria-label={formatWeek(weekString)}
          className={cx(
            "focus-ring relative flex h-12 items-center justify-center text-text-secondary -m-px",
            !isWeekActive && "hover:bg-bg-hover active:bg-bg-active",
            isWeekActive &&
              "font-bold bg-bg-selected text-text-selected hover:bg-bg-selected-hover active:bg-bg-selected-active",
            hasWeekChanges &&
              "after:pointer-events-none after:absolute after:bottom-2 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:content-['']",
            hasWeekChanges && isWeekActive && "after:bg-text-secondary",
            hasWeekChanges && !isWeekActive && "after:bg-border",
          )}
        >
          {weekNumber}
        </Link>
      </div>
      {/* Date cells */}
      {daysOfWeek.map((day) => (
        <MonthDateCell
          key={day.toISOString()}
          date={day}
          isOutsideMonth={day.getMonth() !== displayedMonth}
          isActive={toDateString(day) === activeId}
          hasChanges={marked.has(toDateString(day))}
        />
      ))}
    </div>
  )
}

function MonthDateCell({
  date,
  isOutsideMonth = false,
  isActive = false,
  hasChanges = false,
}: {
  date: Date
  isOutsideMonth?: boolean
  isActive?: boolean
  hasChanges?: boolean
}) {
  const dateString = toDateString(date)
  const day = date.getDate()
  const isToday = dateString === toDateString(new Date())

  return (
    <div>
      <Link
        to="/calendar/$"
        params={{ _splat: dateString }}
        search={{}}
        aria-label={dayLabel(date)}
        className={cx(
          "focus-ring relative flex h-12 items-center justify-center -m-px",
          isOutsideMonth && !isActive ? "text-text-tertiary" : "text-text",
          !isActive && "hover:bg-bg-hover active:bg-bg-active",
          isActive &&
            "font-bold bg-bg-selected text-text-selected hover:bg-bg-selected-hover active:bg-bg-selected-active",
          hasChanges &&
            "after:pointer-events-none after:absolute after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:content-['']",
          hasChanges && isToday && "after:bottom-[6px]",
          hasChanges && !isToday && "after:bottom-2",
          hasChanges && isActive && "after:bg-text-secondary",
          hasChanges && !isActive && "after:bg-border",
        )}
      >
        <span
          className={cx(
            isToday && "-mx-1 -my-[0.125rem] rounded-sm px-1 py-[0.125rem] leading-[1.2]",
            isToday && !isActive && "shadow-[inset_0_0_0_1px_var(--color-text-secondary)]",
            isToday && isActive && "bg-text text-bg",
          )}
        >
          {day}
        </span>
      </Link>
    </div>
  )
}
