import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { HistoryIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { ReleaseNotes, releaseId } from "../components/release-notes"
import { formatReleaseDates } from "../utils/changelog"
import { loadChangelog } from "../utils/changelog-source"
import { cx } from "../utils/cx"

type RouteSearch = {
  /** The release being read, as its ISO week — `?release=2026-W38`. Left off,
   * the page opens at the top, which is the newest. */
  release: string | undefined
}

export const Route = createFileRoute("/_appRoot/changelog")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => ({
    release: typeof search.release === "string" ? search.release : undefined,
  }),
  loader: () => loadChangelog(),
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Changelog · Ruminate" }] }),
})

/** How far down the view a release must reach before the rail calls it the one
 * being read. A little below the top, so the heading you are reading under is
 * the one marked rather than the one just leaving. */
const CURRENT_LINE = 120

function RouteComponent() {
  const releases = Route.useLoaderData()
  const { release } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [current, setCurrent] = useState(release ?? releases[0]?.week)

  // Arriving on `?release=…` starts at that release. Only on the way in: the
  // address is rewritten as you scroll, and reacting to that would fight you
  // for the scroll position.
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current) return
    landed.current = true
    if (!release) return
    document.getElementById(releaseId(release))?.scrollIntoView({ block: "start" })
  }, [release])

  // The rail follows the page. The answer is worked out from where the
  // releases actually are, so it is the same however the view was reached —
  // scrolled, jumped to, or resized into.
  useEffect(() => {
    const weeks = releases.map((entry) => entry.week)
    if (weeks.length === 0) return
    const first = document.getElementById(releaseId(weeks[0]))
    const scroller = first?.closest("main")
    if (!scroller) return

    let queued = 0
    const look = () => {
      queued = 0
      let reached = weeks[0]
      for (const week of weeks) {
        const top = document.getElementById(releaseId(week))?.getBoundingClientRect().top
        if (top !== undefined && top <= CURRENT_LINE) reached = week
      }
      // The last release can be too short to reach the line — there is nothing
      // beneath it to scroll past — so at the foot of the page it is the one
      // being read, whatever the measurements say.
      const atFoot = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4
      setCurrent(atFoot ? weeks[weeks.length - 1] : reached)
    }
    const onScroll = () => {
      if (queued) return
      queued = requestAnimationFrame(look)
    }

    look()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      if (queued) cancelAnimationFrame(queued)
      scroller.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [releases])

  // The address follows the rail, replacing rather than pushing: copying the
  // URL links to the week being read, and the back button still leads out of
  // the page rather than back through it.
  useEffect(() => {
    if (!current || current === release) return
    void navigate({ search: { release: current }, replace: true })
  }, [current, release, navigate])

  return (
    <PageLayout title="Changelog" icon={<HistoryIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        {/* The releases read down the middle of the page, as every other page
            in the app is set, with the rail out at the edge beside the
            sidebar. The third column is empty and exists only to balance the
            rail, so the reading column is centred rather than pushed across. */}
        <div className="mx-auto grid w-full max-w-[64rem] grid-cols-1 gap-6 md:grid-cols-[11rem_minmax(0,1fr)_11rem] md:gap-8">
          <nav
            aria-label="Releases"
            className="-mx-4 flex gap-1 overflow-x-auto px-4 md:sticky md:top-0 md:mx-0 md:h-fit md:flex-col md:overflow-x-visible md:px-0"
          >
            {releases.map((entry) => {
              const reading = entry.week === current
              return (
                <Link
                  key={entry.week}
                  to="/changelog"
                  search={{ release: entry.week }}
                  replace
                  // `aria-current` is the router's to set: the address follows
                  // the rail, so the link it marks is the release being read.
                  onClick={(event) => {
                    // Scroll rather than navigate: it is one page, and the
                    // rail is where you are in it, not what it shows.
                    event.preventDefault()
                    document.getElementById(releaseId(entry.week))?.scrollIntoView({
                      block: "start",
                      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "auto"
                        : "smooth",
                    })
                  }}
                  className={cx(
                    "focus-ring shrink-0 whitespace-nowrap rounded px-2 py-1 text-left text-sm",
                    reading
                      ? "bg-bg-secondary font-bold text-text"
                      : "text-text-secondary hover:bg-bg-hover",
                  )}
                >
                  {/* Short in the rail, which is narrow; the release's own
                      heading says it in full. */}
                  {formatReleaseDates(entry.week, { short: true })}
                </Link>
              )
            })}
          </nav>
          <div className="flex min-w-0 flex-col gap-10">
            {releases.length > 0 ? (
              releases.map((entry) => <ReleaseNotes key={entry.week} release={entry} />)
            ) : (
              <p className="text-text-secondary">Nothing has been released yet.</p>
            )}
          </div>
          <div aria-hidden className="hidden md:block" />
        </div>
      </div>
    </PageLayout>
  )
}
