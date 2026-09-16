import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  countEntries,
  formatReleaseDates,
  releasesSince,
  takeEntries,
  type ChangelogRelease,
} from "../utils/changelog"
import { IconButton } from "./icon-button"
import { XIcon16 } from "./icons"
import { EntryText } from "./release-notes"

/**
 * The changelog build this device last saw (`<week>.<hash>`, vite.config.ts).
 * `null` means it has never seen one, which is a first visit rather than a
 * device that is behind.
 *
 * Read straight from storage rather than held in a storage atom: this is one
 * question asked once at boot, and a storage atom of this vintage reports its
 * default before the stored value reaches it — which here would tell every
 * device that it was up to date, and show this to nobody.
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
    // Nothing to be done, and nothing that needs saying: the reader sees this
    // once more than they should, at worst.
  }
}

/** How many entries the card shows before handing over to the page. It is a
 * card in the corner, not the changelog: a handful, then a way in. */
const MAX_ENTRIES = 6

/**
 * What changed since the last time this device ran Ruminate, as a card in the
 * corner.
 *
 * Deliberately not a dialog. Arriving at an app you have just updated to find
 * your way barred by something you must dismiss before you can type is a poor
 * greeting, and what changed is never urgent. The card sits out of the way,
 * takes no focus, and is read when the reader chooses — or ignored, which
 * counts as read, since it does not come back.
 *
 * The **Update Ruminate** button applies the waiting service worker and
 * reloads (`src/hooks/app-update.ts`), so there is no moment between the click
 * and the new build in which anything could be shown: the page is about to be
 * torn down. This is therefore not tied to the button at all. It asks, on
 * every boot, whether the build it is running is newer than the one this
 * device last saw, which also catches the reader whose waiting worker
 * activated on its own after they closed every tab.
 *
 * Nothing is fetched to answer that question. The stamp is a string in the app
 * bundle; only a device that is actually behind pays for the changelog.
 */
export function WhatsNewPopover() {
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
      // The same source the changelog page reads, so entries still waiting in
      // `changelog.d/` are shown here too. Without that, an update made before
      // collation ran would greet the reader with nothing at all.
      const { loadChangelog } = await import("../utils/changelog-source")
      const loaded = await loadChangelog()
      if (!live) return
      const releases = releasesSince(loaded, seen)
      // A build that adds no release of its own — a fix folded into a week
      // this device has already read — moves the stamp on without a word.
      if (releases.length === 0) rememberVersion(__CHANGELOG_VERSION__)
      else setUnseen(releases)
    })()
    return () => {
      live = false
    }
  }, [])

  const dismissed = unseen === null || unseen.length === 0

  // <kbd>Esc</kbd> puts it away, as it does every other transient surface in
  // the app — but only while it is there, so it never swallows the key.
  useEffect(() => {
    if (dismissed) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setUnseen(null)
      rememberVersion(__CHANGELOG_VERSION__)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [dismissed])

  if (dismissed) return null

  const close = () => {
    setUnseen(null)
    rememberVersion(__CHANGELOG_VERSION__)
  }

  const total = countEntries(unseen)
  const shown = takeEntries(unseen, MAX_ENTRIES)
  const rest = total - countEntries(shown)

  return (
    // Bottom left, where it sits beside the sidebar's own **What's new** and
    // **Update Ruminate** items — the card and the things it is about read as
    // one corner of the app rather than as two unrelated bits of furniture. On
    // a phone there is no sidebar to sit beside, so it takes the width of the
    // page instead of hugging an edge that means nothing there.
    //
    // Hung off the page's own row (src/components/app-layout.tsx), which is
    // what keeps it clear of the bottom chrome on every screen. `aria-live` is
    // off: this is not news worth interrupting a screen reader mid-sentence
    // for, and it is reachable in the reading order like anything else.
    <div
      role="complementary"
      aria-label="What's new"
      className="whats-new-card card-2 absolute inset-x-3 bottom-3 z-20 flex flex-col gap-3 rounded-xl! p-4 sm:right-auto sm:w-[21rem] print:hidden"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">What's new</h2>
        <IconButton aria-label="Dismiss" className="-m-2" onClick={close} disableTooltip>
          <XIcon16 />
        </IconButton>
      </div>
      {shown.map((release) => (
        <section key={release.week} className="flex flex-col gap-1.5">
          <h3 className="text-sm text-text-secondary">{formatReleaseDates(release.week)}</h3>
          <ul className="flex flex-col gap-2">
            {release.sections.flatMap((section) =>
              section.entries.map((entry) => (
                <li key={entry.line} className="text-sm leading-snug">
                  {/* The category leads the line, quietly, so a fix is not
                      read as a feature at a glance. */}
                  <span className="text-text-secondary">{section.category}</span>{" "}
                  <EntryText text={entry.lead} />
                </li>
              )),
            )}
          </ul>
        </section>
      ))}
      <div className="flex items-center justify-between gap-3 border-t border-border-secondary pt-3">
        <Link
          to="/changelog"
          search={{ release: undefined }}
          className="link text-sm"
          onClick={close}
        >
          {rest > 0 ? `See all ${total} changes` : "See all changes"}
        </Link>
        {rest > 0 ? <span className="text-sm text-text-secondary">+{rest} more</span> : null}
      </div>
    </div>
  )
}
