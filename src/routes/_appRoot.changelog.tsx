import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { HistoryIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { ReleaseNotes } from "../components/release-notes"
import { formatReleaseDates } from "../utils/changelog"
import { loadChangelog } from "../utils/changelog-source"
import { cx } from "../utils/cx"

type RouteSearch = {
  /** The release being read, as its ISO week — `?release=2026-W38`. Left off,
   * the page shows the newest. */
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

/**
 * The changelog: **one release at a time**, chosen in the rail.
 *
 * It used to be every release run together into one endless page, mounted a
 * couple at a time as you came down it, with the rail following your scroll
 * position and the address rewriting itself as you went. All of that was in
 * service of a document nobody reads end to end: you come for what changed
 * this week, or for one particular week. So the rail picks a week and that
 * week is what the page holds — a screenful or two, drawn whole, with nothing
 * mounting underneath you and nothing to scroll past to reach the next week.
 * The opening cost the lazy mounting was built to avoid is gone with it,
 * because one release is all that is ever drawn.
 *
 * A tab is an ordinary link, so it pushes: Back walks you out through the
 * weeks you read, and `?release=…` still links to one.
 */
function RouteComponent() {
  const releases = Route.useLoaderData()
  const { release } = Route.useSearch()
  // An address naming a week that is not here — an old link, a typo — shows
  // the newest rather than nothing at all.
  const known = releases.some((entry) => entry.week === release)
  const current = known ? release : releases[0]?.week
  const showing = releases.find((entry) => entry.week === current)

  // A new release starts at its own top: the reader asked for this week, not
  // for wherever they happened to be in the last one.
  const column = useRef<HTMLDivElement>(null)
  useEffect(() => {
    column.current?.closest("main")?.scrollTo({ top: 0 })
  }, [current])

  return (
    <PageLayout title="Changelog" icon={<HistoryIcon16 />} disableGuard>
      {/* Measured on the PAGE COLUMN, not the window: the sidebar takes a
          couple of hundred pixels out of a window that is still "desktop
          wide", and a viewport breakpoint cannot see that. Asking the column
          how wide IT is means the rail steps aside exactly when it stops
          paying for itself, sidebar open or shut.

          The extra top padding where the rail is a column is the scroll
          fade's (`.scroll-fade`, index.css): it paints the page background
          over the top 32px of the scroller as you scroll, and the rail sticks
          at exactly that line. Matching the two means the rail sits where it
          will stick — so it neither jumps when the page first moves nor has
          its top tab painted over, which is what used to hide the newest week
          the moment you scrolled. */}
      <div className="@container px-4 pb-6 pt-4 @[640px]:pt-8">
        {/* The release reads down the middle of the page, as every other page
            in the app is set, with the rail out at the edge. The third column
            is empty and exists only to balance the rail, so the reading
            column is centred rather than pushed across — but it is the first
            thing given up: until there is width to spare the reading column
            takes it instead of leaving it blank beside a column that has
            started to squeeze. Below 640px the rail lies down as a strip of
            tabs above the release and the column has the width to itself.

            640px is where a 11rem rail plus its gap still leaves a readable
            measure; it is also the step the note page changes at, so the two
            pages reflow together. */}
        <div className="mx-auto grid w-full max-w-[64rem] grid-cols-1 gap-6 @[640px]:grid-cols-[11rem_minmax(0,1fr)] @[640px]:gap-8 @[1152px]:grid-cols-[11rem_minmax(0,1fr)_11rem]">
          <nav
            aria-label="Releases"
            className="-mx-4 flex gap-1 overflow-x-auto px-4 @[640px]:sticky @[640px]:top-8 @[640px]:mx-0 @[640px]:h-fit @[640px]:flex-col @[640px]:overflow-x-visible @[640px]:px-0"
          >
            {releases.map((entry) => {
              const reading = entry.week === current
              return (
                <Link
                  key={entry.week}
                  to="/changelog"
                  search={{ release: entry.week }}
                  aria-current={reading ? "page" : undefined}
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
          <div ref={column} className="min-w-0">
            {showing ? (
              <ReleaseNotes release={showing} />
            ) : (
              <p className="text-text-secondary">Nothing has been released yet.</p>
            )}
          </div>
          <div aria-hidden className="hidden @[1152px]:block" />
        </div>
      </div>
    </PageLayout>
  )
}
