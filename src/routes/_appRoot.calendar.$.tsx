import { createFileRoute, redirect } from "@tanstack/react-router"
import { Calendar } from "../components/calendar"
import { CalendarHeader } from "../components/calendar-header"
import { DateMentions, useCalendarMarks } from "../components/date-mentions"
import { CalendarDateIcon16, CalendarIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"

/**
 * A day, or a week, of the calendar: a page of its own, not a note. The
 * address names the day (`/calendar/2026-10-08`) or the ISO week
 * (`/calendar/2026-W41`); anything else is today.
 */
export const Route = createFileRoute("/_appRoot/calendar/$")({
  validateSearch: () => ({}),
  loader: ({ params }) => {
    const id = params._splat ?? ""
    if (isValidDateString(id) || isValidWeekString(id)) return
    throw redirect({
      to: "/calendar/$",
      params: { _splat: toDateString(new Date()) },
      search: {},
      replace: true,
    })
  },
  component: CalendarPage,
})

function CalendarPage() {
  const { _splat } = Route.useParams()
  const id = _splat ?? ""
  const marked = useCalendarMarks()
  const isDay = isValidDateString(id)
  return (
    <PageLayout
      title="Calendar"
      icon={isDay ? <CalendarDateIcon16 date={Number(id.slice(-2))} /> : <CalendarIcon16 />}
    >
      <div className="@container">
        <div className="p-4 @[480px]:p-5 @[640px]:p-10">
          <div className="mx-auto flex max-w-[700px] flex-col gap-8">
            <div className="print-hidden flex flex-col gap-8">
              <Calendar className="-m-2" activeId={id} marked={marked} />
              <CalendarHeader activeId={id} />
            </div>
            <DateMentions periodId={id} />
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
