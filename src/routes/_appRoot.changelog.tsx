import { createFileRoute, Link } from "@tanstack/react-router"
import { HistoryIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { ReleaseNotes } from "../components/release-notes"
import { formatReleaseDates, parseChangelog } from "../utils/changelog"
import { cx } from "../utils/cx"

type RouteSearch = {
  /** The release being read, as its ISO week — `?release=2026-W38`. Left off,
   * the newest is shown, so `/changelog` is always "what changed lately". */
  release: string | undefined
}

export const Route = createFileRoute("/_appRoot/changelog")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => ({
    release: typeof search.release === "string" ? search.release : undefined,
  }),
  // `CHANGELOG.md` is read at build time and loaded with the page rather than
  // with the app: it is a document nobody opens on most visits, and it only
  // grows. The import is dynamic so it lands in this route's own chunk.
  loader: async () => {
    const { default: source } = await import("../../CHANGELOG.md?raw")
    return parseChangelog(source).releases
  },
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Changelog · Ruminate" }] }),
})

function RouteComponent() {
  const releases = Route.useLoaderData()
  const { release } = Route.useSearch()
  // An address naming a release that is not there (an old link, a typo) reads
  // as the newest rather than as an empty page.
  const selected = releases.find((entry) => entry.week === release) ?? releases[0]

  return (
    <PageLayout title="Changelog" icon={<HistoryIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 md:flex-row md:gap-10">
          <nav
            aria-label="Releases"
            className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 md:sticky md:top-4 md:mx-0 md:w-48 md:flex-col md:self-start md:overflow-x-visible md:px-0"
          >
            {releases.map((entry) => {
              const current = entry.week === selected?.week
              return (
                <Link
                  key={entry.week}
                  to="/changelog"
                  search={{ release: entry.week }}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "focus-ring shrink-0 whitespace-nowrap rounded px-2 py-1 text-left text-sm",
                    current
                      ? "bg-bg-secondary font-bold text-text"
                      : "text-text-secondary hover:bg-bg-hover",
                  )}
                >
                  {formatReleaseDates(entry.week)}
                </Link>
              )
            })}
          </nav>
          <div className="min-w-0 grow">
            {selected ? (
              <ReleaseNotes release={selected} />
            ) : (
              <p className="text-text-secondary">Nothing has been released yet.</p>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
