// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { heatmapWeeks, type Series, type SeriesState } from "../../data/tracker"
import { ActivityCard, TrackerStats, axisWeekdays, heatmapColumns } from "./activity"
import { MonthGrid } from "./month-grid"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const READ: SeriesState = {
  series: {
    id: "s1",
    name: "Read",
    kind: "check",
    colour: "green",
    unit: "",
    min: null,
    max: null,
    step: 1,
    target: null,
    period: "day",
    rollup: "sum",
    goal: "do",
  } satisfies Series,
  entries: new Map([
    ["2026-09-30", { id: "e1", date: "2026-09-30", value: true }],
    ["2026-10-28", { id: "e2", date: "2026-10-28", value: true }],
  ]),
}

const heatmap = (today: string) => render(<ActivityCard series={[READ]} today={today} />)

const labels = () =>
  [...document.querySelectorAll("[data-month-label]")].map((label) => label.textContent)

const cell = (day: string) => document.querySelector<HTMLElement>(`[data-day="${day}"]`)!

describe("heatmapColumns", () => {
  it("splits a week that runs into a new month, with placeholders for the other month", () => {
    // Twelve weeks from Monday 10 August; three of them hold two months.
    const columns = heatmapColumns(heatmapWeeks("2026-10-29"))
    expect(columns).toHaveLength(15)
    expect(columns.map((column) => column.month)).toEqual([
      ...Array(4).fill("2026-08"),
      ...Array(5).fill("2026-09"),
      ...Array(5).fill("2026-10"),
      "2026-11",
    ])
    // The week of Monday 28 September: Monday to Wednesday, then Thursday 1
    // October to Sunday.
    expect(columns[8].days).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      null,
      null,
      null,
      null,
    ])
    expect(columns[9].days).toEqual([
      null,
      null,
      null,
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ])
    // A week inside one month is one column.
    expect(columns[10].days.every((day) => day !== null)).toBe(true)
  })
})

describe("axisWeekdays", () => {
  it("names every weekday when a row is tall enough, else Mon, Wed and Fri, and today", () => {
    expect([...axisWeekdays(null, 3)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...axisWeekdays(12, 5)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    // The desktop card's cells (about 11.7 px) have room for all seven.
    expect([...axisWeekdays(11.7, 5)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...axisWeekdays(6, 3)].sort()).toEqual([0, 2, 3, 4])
    expect([...axisWeekdays(6, 4)].sort()).toEqual([0, 2, 4])
  })
})

describe("ActivityHeatmap", () => {
  it("draws one straight divider per month boundary, in its own track, Monday to Sunday", () => {
    heatmap("2026-10-29")
    const dividers = [...document.querySelectorAll<HTMLElement>("[data-month-divider]")]
    expect(dividers.map((divider) => divider.dataset.monthDivider)).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
    ])
    // The tracks: the day axis, fifteen columns, and a narrow track before
    // each month's first column, which the divider stands in, with a gap
    // each side of it.
    const template = screen.getByTestId("activity-heatmap").style.gridTemplateColumns
    expect(template.split(" minmax(0, 1fr)").length - 1).toBe(15)
    expect(template.match(/6px/g)).toHaveLength(3)
    expect(dividers.map((divider) => divider.style.gridColumn)).toEqual(["6", "12", "18"])
    // From the Monday row (2) down past Sunday (8), not up into the names.
    for (const divider of dividers) expect(divider.style.gridRow).toBe("2 / 9")
    // No cell draws a piece of a line, and no cell sits in a divider's track.
    expect(document.querySelectorAll("[data-divider]")).toHaveLength(0)
    const cells = document.querySelectorAll<HTMLElement>('[role="gridcell"]')
    for (const cell of cells) expect(["6", "12", "18"]).not.toContain(cell.style.gridColumn)
  })

  it("draws days as rounded squares, not circles", () => {
    heatmap("2026-10-29")
    // A weekday's name takes no height, so a row is exactly a cell high.
    for (const header of screen.getAllByRole("rowheader")) {
      expect(header.className).toContain("h-0")
    }
    // A quarter of the side, the cards' shape at any size.
    for (const cell of document.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      expect(cell.style.borderRadius).toBe("25%")
      expect(cell.className).not.toMatch(/rounded/)
    }
    for (const day of document.querySelectorAll<HTMLElement>("button[data-day]")) {
      expect(day.style.borderRadius).toBe("25%")
    }
  })

  it("draws the other month's days in a split week as placeholders with no data", () => {
    heatmap("2026-10-29")
    const placeholders = [...document.querySelectorAll<HTMLElement>("[data-placeholder]")]
    // Three split weeks, seven placeholders each.
    expect(placeholders).toHaveLength(21)
    for (const placeholder of placeholders) {
      expect(placeholder.getAttribute("aria-hidden")).toBe("true")
      expect(placeholder.hasAttribute("data-day")).toBe(false)
      expect(placeholder.hasAttribute("aria-label")).toBe(false)
      expect(placeholder.tabIndex).toBe(-1)
      // A hollow square: a 0.5 px solid outline and 0.5 px stripes in one
      // solid colour (not an alpha border colour), and no fill.
      expect(placeholder.className).toContain("border-[0.5px]")
      expect(placeholder.className).not.toContain("border-dashed")
      expect(placeholder.className).not.toContain("bg-")
      expect(placeholder.className).not.toContain("opacity")
      expect(placeholder.style.backgroundImage).toContain("repeating-linear-gradient")
      expect(placeholder.style.backgroundImage).toContain("var(--neutral-6) 0 0.5px")
      expect(placeholder.style.backgroundImage).not.toContain("--color-border")
      expect(placeholder.getAttribute("style")).toContain("border-color: var(--neutral-6)")
    }
    // Every day is drawn once; only the two logged days count as entries.
    expect(document.querySelectorAll("[data-day]")).toHaveLength(84)
    const logged = [...document.querySelectorAll<HTMLElement>("[data-day]")].filter(
      (day) => day.dataset.series !== "0",
    )
    expect(logged.map((day) => day.dataset.day)).toEqual(["2026-09-30", "2026-10-28"])
    // A placeholder takes a faint wash of its day's colours: Read was on
    // Wednesday 30 September, held in October's half of its week, and on
    // Wednesday 28 October, held in November's.
    const tinted = placeholders.filter((placeholder) => placeholder.dataset.tint !== "0")
    expect(tinted.map((placeholder) => placeholder.style.gridColumn)).toEqual(["13", "19"])
    for (const placeholder of tinted) expect(placeholder.style.gridRow).toBe("4")
    // With nowhere to open a day, no day can be tapped.
    for (const day of document.querySelectorAll<HTMLButtonElement>("button[data-day]")) {
      expect(day.disabled).toBe(true)
    }
  })

  it("opens a day up to today on a tap, never a day to come", () => {
    const onOpenDay = vi.fn()
    render(<ActivityCard series={[READ]} today="2026-10-29" onOpenDay={onOpenDay} />)
    fireEvent.click(cell("2026-10-28"))
    expect(onOpenDay).toHaveBeenLastCalledWith("2026-10-28")
    fireEvent.click(cell("2026-08-10"))
    expect(onOpenDay).toHaveBeenLastCalledWith("2026-08-10")
    expect((cell("2026-10-30") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(cell("2026-10-30"))
    expect(onOpenDay).toHaveBeenCalledTimes(2)
  })

  it("has one tab stop, today, and moves by day and week with the arrows", () => {
    render(<ActivityCard series={[READ]} today="2026-10-29" onOpenDay={() => {}} />)
    const stops = document.querySelectorAll<HTMLElement>('button[data-day][tabindex="0"]')
    expect([...stops].map((stop) => stop.dataset.day)).toEqual(["2026-10-29"])
    cell("2026-10-29").focus()
    fireEvent.keyDown(cell("2026-10-29"), { key: "ArrowUp" })
    expect(document.activeElement).toBe(cell("2026-10-28"))
    fireEvent.keyDown(cell("2026-10-28"), { key: "ArrowLeft" })
    expect(document.activeElement).toBe(cell("2026-10-21"))
    expect(cell("2026-10-21").tabIndex).toBe(0)
    // Not past today.
    fireEvent.keyDown(cell("2026-10-21"), { key: "ArrowRight" })
    fireEvent.keyDown(cell("2026-10-28"), { key: "ArrowRight" })
    expect(document.activeElement).toBe(cell("2026-10-28"))
  })

  // The tracks the names stand in: a divider's for a month that starts in
  // the heatmap, the first column's for the month it opens on.
  const namedTracks = () =>
    [...document.querySelectorAll<HTMLElement>("[data-month-label]")].map(
      (label) => label.style.gridColumn,
    )

  it("names a month only beside its divider, never the month it opens in mid-month", () => {
    // From Monday 10 August: 1 August is before the heatmap, so August has
    // no divider and no name.
    heatmap("2026-10-29")
    expect(labels()).toEqual(["Sept", "Oct", "Nov"])
    // Each name sits on top of its divider: the same track, the row above.
    const dividers = [...document.querySelectorAll<HTMLElement>("[data-month-divider]")]
    expect(namedTracks()).toEqual(dividers.map((divider) => divider.style.gridColumn))
    for (const label of document.querySelectorAll<HTMLElement>("[data-month-label]")) {
      expect(label.style.gridRow).toBe("1")
      // From the track's left edge, so the first letter is over the line.
      expect(label.className).not.toContain("justify-center")
      // A little smaller than the text around it.
      expect(label.className).toContain("text-[11px]")
    }
    cleanup()
    // From Monday 31 August: August's one day has no name either.
    heatmap("2026-11-19")
    expect(labels()).toEqual(["Sept", "Oct", "Nov"])
    // September's divider stands before the second column.
    expect(namedTracks()[0]).toBe("3")
  })

  it("names the month it opens in when it opens on the 1st", () => {
    // From Monday 1 June: June starts in the first column.
    heatmap("2026-08-20")
    expect(labels()).toEqual(["Jun", "Jul", "Aug"])
    // June over the first column; July and August on their dividers.
    expect(namedTracks()).toEqual(["2", "7", "13"])
  })

  it("does not pin a name", () => {
    heatmap("2026-10-29")
    for (const label of document.querySelectorAll("[data-month-label]")) {
      expect(label.className).not.toContain("sticky")
    }
  })

  it("names every weekday on the day axis, and marks today", () => {
    heatmap("2026-10-29")
    const axis = screen.getAllByRole("rowheader")
    expect(axis.map((header) => header.textContent)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ])
    // Today is a Thursday: its name is in bold, and only its.
    expect(axis.map((header) => header.className.includes("font-bold"))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ])
    const current = document.querySelectorAll('[aria-current="date"]')
    expect([...current].map((day) => day.getAttribute("data-day"))).toEqual(["2026-10-29"])
    expect(cell("2026-10-29").className).toContain("ring-2")
    // One dot, under October's half of the last week: the column today is
    // in (the 14th of 15), past the day axis and three divider tracks.
    const marks = screen.getAllByTestId("heatmap-today-mark")
    expect(marks).toHaveLength(1)
    expect(marks[0].dataset.column).toBe("13")
    expect(marks[0].style.gridColumn).toBe("17")
    expect(marks[0].style.gridRow).toBe("9")
  })
})

/** jsdom draws nothing: give every cell a side of `size` px and the grid
 * sixteen cells' width, and run the observer's callback as soon as it
 * observes. */
function measureCells(size: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = this.dataset.testid === "activity-heatmap" ? size * 16 : size
    return { width, height: size } as DOMRect
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        this.callback()
      }
      disconnect() {}
    },
  )
}

describe("the heatmap's rows", () => {
  it("makes each weekday's row as tall as a cell is wide, with one gap both ways", () => {
    measureCells(20)
    heatmap("2026-10-29")
    const grid = screen.getByTestId("activity-heatmap")
    expect(grid.style.gridTemplateRows).toBe("auto repeat(7, 20px) auto")
    expect(grid.style.gap).toBe("4px")
  })
})

describe("one day square for the heatmap and the cards", () => {
  it("draws a day, today and an empty day in the same way in both", () => {
    render(
      <>
        <div data-testid="cards">
          <MonthGrid series={[READ]} start="2026-10-01" today="2026-10-29" onOpenDay={() => {}} />
        </div>
        <ActivityCard series={[READ]} today="2026-10-29" onOpenDay={() => {}} />
      </>,
    )
    const cards = screen.getByTestId("cards")
    const heat = screen.getByTestId("activity-heatmap")
    const pair = (day: string) =>
      [cards, heat].map((view) => view.querySelector<HTMLElement>(`[data-day="${day}"]`)!)
    // Today: the cards' ring, in both.
    const [cardToday, heatToday] = pair("2026-10-29")
    expect(heatToday.className).toBe(cardToday.className)
    expect(heatToday.className).toContain("ring-2 ring-border")
    // An empty day, with its hover tint, and a logged day.
    for (const day of ["2026-10-27", "2026-10-28"]) {
      const [card, heatDay] = pair(day)
      expect(heatDay.className).toBe(card.className)
      expect(heatDay.style.borderRadius).toBe(card.style.borderRadius)
    }
  })
})

describe("the heatmap on a large screen", () => {
  it("keeps a phone's small text and hairline divider on a phone-sized grid", () => {
    measureCells(16)
    heatmap("2026-10-29")
    expect(screen.getByTestId("activity-heatmap").dataset.size).toBe("small")
    expect(document.querySelector("[data-month-label]")!.className).toContain("text-[11px]")
    expect(screen.getAllByRole("rowheader")[0].className).toContain("text-[10px]")
    expect(document.querySelector("[data-month-divider]")!.className).toContain("w-px")
    expect(screen.getByRole("list", { name: "Series" }).className).toContain("text-sm")
  })

  it("draws the names, the legend and the dividers larger on a desktop-sized grid", () => {
    measureCells(40)
    heatmap("2026-10-29")
    expect(screen.getByTestId("activity-heatmap").dataset.size).toBe("large")
    // The cards' sizes: 14 px for the names, 16 px for the series.
    for (const label of document.querySelectorAll("[data-month-label]")) {
      expect(label.className).toContain("text-sm")
    }
    for (const header of screen.getAllByRole("rowheader")) {
      expect(header.className).toContain("text-sm")
    }
    expect(screen.getByRole("list", { name: "Series" }).className).toContain("text-base")
    for (const divider of document.querySelectorAll("[data-month-divider]")) {
      expect(divider.className).toContain("w-0.5")
    }
    // The month names still fit: Sept, Oct and Nov, each on its divider.
    expect(labels()).toEqual(["Sept", "Oct", "Nov"])
  })
})

describe("the heatmap's dashes and stripes", () => {
  const firstPlaceholder = () => document.querySelector<HTMLElement>("[data-placeholder]")!
  // Friday 30 October, a day to come: its outline's dashes.
  const futureDashes = () => {
    const rect = cell("2026-10-30").querySelector("[data-future-outline] rect")!
    return Number(rect.getAttribute("pathLength")) / 2
  }

  it("keeps a phone's look on a phone-sized cell", () => {
    measureCells(16)
    heatmap("2026-10-29")
    expect(firstPlaceholder().style.backgroundImage).toContain(
      "var(--neutral-6) 0 0.5px, transparent 0.5px 4px",
    )
    // A 15 px square, 60 px round, in 3 px dashes and 3 px gaps.
    expect(futureDashes()).toBe(10)
    // The outline is the SVG's, not a CSS dashed border.
    expect(cell("2026-10-30").className).not.toContain("border-dashed")
  })

  it("grows the stripes and the dashes with a larger desktop cell", () => {
    measureCells(40)
    heatmap("2026-10-29")
    // 2.5 times a phone's cell: a 1.25 px stripe every 10 px, so fewer.
    expect(firstPlaceholder().style.backgroundImage).toContain(
      "var(--neutral-6) 0 1.25px, transparent 1.25px 10px",
    )
    // The outline stays a hairline.
    expect(firstPlaceholder().className).toContain("border-[0.5px]")
    // A 39 px square, 156 px round, in 7.5 px dashes and gaps: about ten.
    expect(futureDashes()).toBe(10)
  })
})

const SWIM: SeriesState = {
  series: { ...READ.series, id: "s2", name: "Swim", kind: "number", colour: "blue", unit: "min" },
  entries: new Map([
    ["2026-10-28", { id: "e3", date: "2026-10-28", value: 30, detail: "30 min" }],
    ["2026-10-27", { id: "e4", date: "2026-10-27", value: 20 }],
  ]),
}

describe("the Recent list", () => {
  it("groups the series logged on one day under one date, between one pair of dividers", () => {
    render(<ActivityCard series={[READ, SWIM]} today="2026-10-29" />)
    const days = [...document.querySelectorAll<HTMLElement>("[data-recent-day]")]
    expect(days.map((day) => day.dataset.recentDay)).toEqual([
      "2026-10-28",
      "2026-10-27",
      "2026-09-30",
    ])
    // The 28th: one date label, then Read and Swim, in the series's order.
    expect(within(days[0]).getAllByText("28 Oct")).toHaveLength(1)
    const lines = within(days[0]).getAllByRole("listitem")
    expect(lines.map((line) => line.textContent)).toEqual(["Read", "Swim · 30 min"])
    // The divider is the group's top border: none inside a day.
    for (const line of lines) expect(line.className).not.toContain("border-t")
  })
})

const SMOKE: SeriesState = {
  series: { ...READ.series, id: "s3", name: "Smoke", colour: "red", goal: "avoid" },
  entries: new Map([["2026-10-27", { id: "e5", date: "2026-10-27", value: true }]]),
}

describe("a series to avoid", () => {
  it("marks a slip in the heatmap with a cross, and names the series in the legend", () => {
    render(<ActivityCard series={[READ, SMOKE]} today="2026-10-29" />)
    expect(cell("2026-10-27").querySelector("[data-slip]")).toBeTruthy()
    expect(cell("2026-10-27").getAttribute("aria-label")).toBe("Tue 27 Oct: Smoke (avoid)")
    expect(cell("2026-10-28").querySelector("[data-slip]")).toBeNull()
    expect(document.querySelectorAll("[data-day] [data-slip]")).toHaveLength(1)
    const legend = screen.getByRole("list", { name: "Series" })
    expect(within(legend).getByText("Avoid")).toBeTruthy()
  })

  it("has a stats group of its own, in clean days, and stays out of the active days", () => {
    render(<TrackerStats series={[READ, SWIM, SMOKE]} today="2026-10-29" />)
    const groups = [...document.querySelectorAll<HTMLElement>("[data-stats-group]")]
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Active days",
      "Smoke, avoid",
    ])
    const pairs = (group: HTMLElement) =>
      [...group.querySelectorAll("dt")].map(
        (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`,
      )
    // The same as without Smoke.
    expect(pairs(groups[0])).toEqual([
      "Streak: 2 days",
      "Last 7 days: 2/7",
      "Last 28 days: 2/28",
      "All time: 3 days",
    ])
    // From the first entry, 30 September: 30 days, one of them a slip.
    expect(within(groups[1]).getByText("Avoid")).toBeTruthy()
    expect(pairs(groups[1])).toEqual([
      "Streak: 2 days clean",
      "Last 7 days: 6/7 clean",
      "Last 28 days: 27/28 clean",
      "All time: 29 days clean",
    ])
  })
})

describe("TrackerStats", () => {
  it("shows the streak, the last 7 and 28 days, and all time", () => {
    render(<TrackerStats series={[READ, SWIM]} today="2026-10-29" />)
    const stats = screen.getByTestId("tracker-stats")
    const pairs = [...stats.querySelectorAll("dt")].map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`,
    )
    expect(pairs).toEqual([
      "Streak: 2 days",
      "Last 7 days: 2/7",
      "Last 28 days: 2/28",
      "All time: 3 days",
    ])
  })
})
