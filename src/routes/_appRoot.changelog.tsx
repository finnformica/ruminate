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

/**
 * How many releases are drawn to begin with, and how many more each time the
 * reader nears the end.
 *
 * The page reads as one continuous document, but it does not have to be built
 * as one. Every entry mounts its own markdown renderer, so drawing the whole
 * changelog at once costs a noticeable pause on opening — and the changelog
 * only grows, so that pause grows with it. Releases are therefore mounted as
 * the reader comes down the page, which they cannot see happening: the work is
 * done well before the rows are reached.
 *
 * One release to begin with, because one is already far more than a screenful
 * — a busy week runs to several times the height of the view — and because
 * the newest is the one almost everybody came to read. Measured on this
 * changelog, drawing all six at once took 642ms against 264ms for the first
 * alone; more to the point, the second figure stays put as the changelog
 * grows and the first would not.
 */
const FIRST_RELEASES = 1
const MORE_RELEASES = 2

/** How far ahead of the end to mount the next releases. A page's worth and
 * then some, so the rows exist long before they are scrolled to. */
const MOUNT_AHEAD = "1200px"

/**
 * Scroll a release into view, then again on the next frame.
 *
 * The second go is not belt and braces. Drawing a release lays out everything
 * above it, so the first scroll aims at a page that is still settling and can
 * land short.
 *
 * The last release is scrolled to differently, because its place is the end of
 * the page rather than a position within it. A short one — the oldest here is
 * a single entry — can never be brought to the top of the view, so
 * `scrollIntoView` stops wherever it can and calls that done, which may be
 * short of the foot. The rail then marks the release above it. Going to the
 * end instead is both what the reader asked for and what the rail reads.
 */
function scrollToRelease(week: string, { smooth = false, last = false } = {}) {
  const element = document.getElementById(releaseId(week))
  if (!element) return
  const moving =
    smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto"
  const scroller = element.closest("main")

  const go = () => {
    if (last && scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: moving })
    else element.scrollIntoView({ block: "start", behavior: moving })
  }

  go()
  if (moving === "smooth") return
  // Twice more, a frame apart. Arriving straight onto a deep link means the
  // releases above the target are laid out over the frames that follow, so the
  // page is still growing under the first attempt; by the third it has
  // stopped. A settled page makes the later goes no-ops.
  requestAnimationFrame(() => {
    go()
    requestAnimationFrame(go)
  })
}

function RouteComponent() {
  const releases = Route.useLoaderData()
  const { release } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [current, setCurrent] = useState(release ?? releases[0]?.week)

  // Arriving on a release deep in the page means everything above it has to
  // exist for the scroll to land, so the count starts high enough to hold it.
  const [drawn, setDrawn] = useState(() => {
    const wanted = releases.findIndex((entry) => entry.week === release)
    return Math.max(FIRST_RELEASES, wanted + 1)
  })
  const shown = releases.slice(0, drawn)
  const end = useRef<HTMLDivElement>(null)

  // Mount the next releases as the end of what is drawn comes near.
  useEffect(() => {
    if (drawn >= releases.length) return
    const marker = end.current
    if (!marker) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setDrawn((count) => Math.min(releases.length, count + MORE_RELEASES))
        }
      },
      { rootMargin: `${MOUNT_AHEAD} 0px` },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [drawn, releases.length])

  // A rail click on a release that is not drawn yet has nothing to scroll to,
  // so it is drawn first and the scroll waits for it.
  const awaiting = useRef<string | null>(null)
  const goTo = (week: string) => {
    const element = document.getElementById(releaseId(week))
    if (!element) {
      awaiting.current = week
      setDrawn(releases.findIndex((entry) => entry.week === week) + 1)
      return
    }
    scrollToRelease(week, { smooth: true, last: week === releases.at(-1)?.week })
  }
  useEffect(() => {
    const week = awaiting.current
    if (!week) return
    if (!document.getElementById(releaseId(week))) return
    awaiting.current = null
    scrollToRelease(week, { last: week === releases.at(-1)?.week })
  }, [drawn, releases])

  // Arriving on `?release=…` starts at that release. Only on the way in: the
  // address is rewritten as you scroll, and reacting to that would fight you
  // for the scroll position.
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current) return
    landed.current = true
    if (!release) return
    scrollToRelease(release, { last: release === releases.at(-1)?.week })
  }, [release, releases])

  // The rail follows the page. The answer is worked out from where the
  // releases actually are, so it is the same however the view was reached —
  // scrolled, jumped to, or resized into.
  useEffect(() => {
    const weeks = shown.map((entry) => entry.week)
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
  }, [shown])

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
                    goTo(entry.week)
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
              shown.map((entry) => <ReleaseNotes key={entry.week} release={entry} />)
            ) : (
              <p className="text-text-secondary">Nothing has been released yet.</p>
            )}
            {/* The end of what is drawn. Coming near it draws more, so the
                page runs on without the reader meeting a seam. */}
            <div ref={end} aria-hidden className="h-px" />
          </div>
          <div aria-hidden className="hidden md:block" />
        </div>
      </div>
    </PageLayout>
  )
}
