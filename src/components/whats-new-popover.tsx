import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  countEntries,
  formatReleaseDates,
  takeEntries,
  type ChangelogRelease,
} from "../utils/changelog"
import { cx } from "../utils/cx"
import { IconButton } from "./ui/icon-button"
import { Surface } from "./ui/surface"
import { XIcon16 } from "./icons"
import { EntryText } from "./release-notes"
import { useAccountPreference } from "../data/account-preferences"
import { lastSeenVersion, rememberVersion, takeUpdateRequest } from "../utils/whats-new"

/**
 * What this boot knows, read once.
 *
 * Both notes are one-shot — taking the update request clears it, and storing
 * the build this device has now seen overwrites what it saw before — so they
 * cannot be read from an effect that may run more than once. React's strict
 * mode runs every effect twice on purpose, and a remount would do the same:
 * the first pass consumed the request and the second found nothing, so the
 * card never appeared. Reading them here ties the answer to the page load,
 * which is what it is actually about.
 */
let boot: { asked: boolean; seen: string | null } | null = null

function bootFacts() {
  if (!boot) {
    boot = { asked: takeUpdateRequest(), seen: lastSeenVersion() }
    rememberVersion(__CHANGELOG_VERSION__)
  }
  return boot
}

/** How many entries the card shows before handing over to the page. It is a
 * card in the corner, not the changelog: a handful, then a way in. */
const MAX_ENTRIES = 6

/**
 * What changed in the version just taken, as a card in the
 * corner.
 *
 * Deliberately not a dialog. Arriving at an app you have just updated to find
 * your way barred by something you must dismiss before you can type is a poor
 * greeting, and what changed is never urgent. The card sits out of the way,
 * takes no focus, and is read when the reader chooses — or ignored, which
 * counts as read, since it does not come back.
 *
 * The **Update Ruminate** button applies the waiting service worker and
 * reloads (`src/hooks/app-update.ts`); between the click and the new build
 * the page is on its way down, and all it shows is the button's own busy
 * state. This is therefore not tied to the button at all. It asks, on
 * every boot, whether the build it is running is newer than the one this
 * device last saw, which also catches the reader whose waiting worker
 * activated on its own after they closed every tab.
 *
 * Nothing is fetched to answer that question. The stamp is a string in the app
 * bundle; only a device that is actually behind pays for the changelog.
 *
 * The card is off until asked for: Settings → Updates turns it on, as a
 * preference of the account rather than the device
 * (src/data/account-preferences.ts), so it is answered once for every
 * device the reader signs in on. The boot's notes are taken and the build
 * recorded either way, so turning it on later does not greet the reader with
 * a release they have been running for weeks: not being told counts as read,
 * exactly as dismissing does. The preference arrives with the sign-in, which
 * may be after this has mounted — hence the effect follows it.
 */
export function WhatsNewPopover() {
  const show = useAccountPreference("whatsNewCard")
  const [unseen, setUnseen] = useState<ChangelogRelease[] | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Taken before the setting is consulted, so that the one-shot notes are
    // consumed on this boot whether or not anything is shown for them.
    const { asked, seen } = bootFacts()
    if (!show) return

    // Either the reader took an update a moment ago, or this device is running
    // a build it has not seen — which is how the reader whose waiting worker
    // activated on its own, after they closed every tab, is caught. A device
    // that has never stored a build has nothing to compare and is shown
    // nothing unless it asked.
    if (!asked && (seen === null || seen === __CHANGELOG_VERSION__)) return

    let live = true
    void (async () => {
      const { loadChangelog } = await import("../utils/changelog-source")
      const releases = loadChangelog()
      if (!live) return
      // The newest release, and only that. What changed in the version you
      // have just taken is the question being answered; the rest of the
      // history is a click away on the page.
      if (releases.length > 0) setUnseen(releases.slice(0, 1))
    })()
    return () => {
      live = false
    }
  }, [show])

  // Off reads as nothing to say, so the card is put away the moment the box
  // is unticked in Settings — and, the facts being cached for the page load,
  // comes back if it is ticked again before the next one.
  const nothingToSay = !show || unseen === null || unseen.length === 0

  // <kbd>Esc</kbd> puts it away, as it does every other transient surface in
  // the app — but only while it is there, so it never swallows the key.
  useEffect(() => {
    if (nothingToSay || dismissed) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [nothingToSay, dismissed])

  if (nothingToSay) return null

  const close = () => setDismissed(true)

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
    <Surface
      role="complementary"
      aria-label="What's new"
      // A popup that no Base UI component holds, so `open` is what puts it
      // away: the surface plays its exit and the browser hides it after.
      open={!dismissed}
      className={cx(
        "absolute inset-x-3 bottom-3 z-popup flex flex-col gap-3 p-4 sm:right-auto sm:w-[21rem] print:hidden",
        // It grows out of the corner it sits in — what an anchor's
        // `--transform-origin` comes to for something with no anchor.
        "origin-bottom sm:origin-bottom-left",
      )}
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
            {/* Keyed by category and position, never by `entry.line`: a week
                is collated from every file written that week, so a line
                number is only unique within its own file — and this list
                flattens the categories together, where two files' line 3
                would meet. React answers a repeated key by duplicating or
                dropping rows (see the same note in release-notes.tsx). */}
            {release.sections.flatMap((section) =>
              section.entries.map((entry, index) => (
                <li key={`${section.category}-${index}`} className="text-sm leading-snug">
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
    </Surface>
  )
}
