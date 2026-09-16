import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  countEntries,
  formatReleaseDates,
  releasesSince,
  takeEntries,
  type ChangelogRelease,
} from "../utils/changelog"
import { Button } from "./button"
import { Dialog } from "./dialog"
import { EntryText } from "./release-notes"

/**
 * The changelog build this device last saw (`<week>.<hash>`, vite.config.ts).
 * `null` means it has never seen one, which is a first visit rather than a
 * device that is behind.
 *
 * Read straight from storage rather than held in a storage atom: this is one
 * question asked once at boot, and a storage atom of this vintage reports its
 * default before the stored value reaches it — which here would tell every
 * device that it was up to date, and show the dialog to nobody.
 *
 * Storage can be absent or throw (a private window, blocked site data), and
 * the honest answer there is that this device has seen nothing and should be
 * shown nothing.
 */
const STORAGE_KEY = "changelog-last-seen"

function lastSeenVersion(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function rememberVersion(version: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, version)
  } catch {
    // Nothing to be done, and nothing that needs saying: the reader sees the
    // dialog once more than they should, at worst.
  }
}

/**
 * What changed since the last time this device ran Ruminate.
 *
 * The **Update Ruminate** button applies the waiting service worker and
 * reloads (`src/hooks/app-update.ts`), so there is no moment between the click
 * and the new build in which a dialog could be shown: the page is about to be
 * torn down. The dialog is therefore not tied to the button at all. It asks,
 * on every boot, whether the build it is running is newer than the one this
 * device last saw, which also catches the reader whose waiting worker
 * activated on its own after they closed every tab.
 *
 * Nothing is fetched to answer that question. The stamp is a string in the app
 * bundle; only a device that is actually behind pays for the changelog.
 */
/** How many entries the dialog shows before handing over to the page. */
const MAX_ENTRIES = 12

export function WhatsNewDialog() {
  const [unseen, setUnseen] = useState<ChangelogRelease[] | null>(null)

  useEffect(() => {
    const seen = lastSeenVersion()
    if (seen === __CHANGELOG_VERSION__) return
    if (seen === null) {
      // A first visit has nothing to catch up on. Remember where it came in,
      // so the next build is the first thing it is ever shown.
      rememberVersion(__CHANGELOG_VERSION__)
      return
    }
    let live = true
    void (async () => {
      const { parseChangelog } = await import("../utils/changelog")
      const { default: source } = await import("../../CHANGELOG.md?raw")
      if (!live) return
      const releases = releasesSince(parseChangelog(source).releases, seen)
      // A build that adds no release of its own — a fix folded into a week
      // this device has already read — moves the stamp on without a word.
      if (releases.length === 0) rememberVersion(__CHANGELOG_VERSION__)
      else setUnseen(releases)
    })()
    return () => {
      live = false
    }
  }, [])

  const close = () => {
    setUnseen(null)
    rememberVersion(__CHANGELOG_VERSION__)
  }

  if (!unseen || unseen.length === 0) return null

  const total = countEntries(unseen)
  const shown = takeEntries(unseen, MAX_ENTRIES)
  const rest = total - countEntries(shown)

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <Dialog.Content title="What's new" className="max-w-lg">
        <div className="flex flex-col gap-5">
          {shown.map((release) => (
            <section key={release.week} className="flex flex-col gap-2">
              <h3 className="text-sm font-bold text-text-secondary">
                {formatReleaseDates(release.week)}
              </h3>
              <ul className="flex flex-col gap-2">
                {release.sections.flatMap((section) =>
                  section.entries.map((entry) => (
                    <li key={entry.line} className="flex gap-2 leading-snug">
                      {/* The category leads the row, so a fix is not read as a
                          feature at a glance. */}
                      <span className="w-16 shrink-0 text-sm text-text-secondary">
                        {section.category}
                      </span>
                      <span className="min-w-0">
                        {/* Leads alone: the detail behind each one is on the
                            changelog page, a click away below. */}
                        <EntryText text={entry.lead} />
                      </span>
                    </li>
                  )),
                )}
              </ul>
            </section>
          ))}
          {rest > 0 ? (
            <p className="text-sm text-text-secondary">
              and {rest} more {rest === 1 ? "change" : "changes"}.
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-border-secondary pt-4">
            <Link
              to="/changelog"
              search={{ release: undefined }}
              className="link text-sm"
              onClick={close}
            >
              {rest > 0 ? `See all ${total} changes` : "See all changes"}
            </Link>
            <Button variant="primary" onClick={close}>
              Got it
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
