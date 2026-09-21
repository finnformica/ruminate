import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  countEntries,
  formatReleaseDates,
  takeEntries,
  type ChangelogRelease,
} from "../utils/changelog"
import { cx } from "../utils/cx"
import { IconButton } from "./icon-button"
import { XIcon16 } from "./icons"
import { EntryText } from "./release-notes"
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
 * Where the card is in its arrival or its departure.
 *
 * Every other raised surface in the app is a Base UI popup, and Base UI marks
 * a popup `data-starting-style` on the frame it appears and `data-ending-style`
 * while it is going, which is what the scale-and-fade classes hang off. This
 * card is anchored to a corner rather than to a trigger, so there is no
 * popup to do that for it — it says the same two things about itself, and
 * wears the same classes, so it moves like the menus and tooltips do.
 */
type Phase = "starting" | "open" | "ending"

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
  const [phase, setPhase] = useState<Phase>("starting")

  useEffect(() => {
    const { asked, seen } = bootFacts()

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
  }, [])

  const dismissed = unseen === null || unseen.length === 0

  // Two frames, then the starting style comes off. The first paints the card
  // small and clear, the second lets the browser see it change — set in one
  // frame the two styles are coalesced and nothing animates at all.
  useEffect(() => {
    if (dismissed) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPhase("open"))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [dismissed])

  // Dismissing plays the exit and the card leaves when it has finished. A
  // browser that runs no transitions fires no event, so a timer takes it away
  // regardless rather than leaving an invisible card holding the corner.
  useEffect(() => {
    if (phase !== "ending") return
    const timer = setTimeout(() => setUnseen(null), 1000)
    return () => clearTimeout(timer)
  }, [phase])

  // <kbd>Esc</kbd> puts it away, as it does every other transient surface in
  // the app — but only while it is there, so it never swallows the key.
  useEffect(() => {
    if (dismissed) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPhase("ending")
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [dismissed])

  if (dismissed) return null

  const close = () => setPhase("ending")

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
      className={cx(
        "whats-new-card card-2 absolute inset-x-3 bottom-3 z-20 flex flex-col gap-3 rounded-xl! p-4 sm:right-auto sm:w-[21rem] print:hidden",
        // The popups' own motion, copied as it stands (dropdown-menu.tsx and
        // its neighbours) — including its silence about duration and easing,
        // since Tailwind's defaults are the pace every other surface here
        // moves at. The card grows out of the corner it occupies, which is
        // what `--transform-origin` comes to for something with no trigger to
        // point at. One addition: a card on its way out takes no clicks, or
        // the link under a fading card would still navigate.
        "origin-bottom transition-[transform,scale,opacity] data-ending-style:pointer-events-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 sm:origin-bottom-left",
      )}
      data-starting-style={phase === "starting" ? "" : undefined}
      data-ending-style={phase === "ending" ? "" : undefined}
      onTransitionEnd={(event) => {
        // Opacity is the one property that always moves, reduced motion
        // included, and only this element's own transition counts — the
        // entries inside it have their own.
        if (phase !== "ending" || event.target !== event.currentTarget) return
        if (event.propertyName === "opacity") setUnseen(null)
      }}
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
    </div>
  )
}
