import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  toSegments,
  formatReleaseDates,
  type ChangelogEntry,
  type ChangelogRelease,
} from "../utils/changelog"
import { Keys } from "./keys"

/**
 * One release, drawn from the changelog (docs/changelog.md).
 *
 * An entry is a lead sentence and the detail behind it, and the two are drawn
 * as a **heading and its paragraph**: the lead a step up the type scale on a
 * line of its own, the detail quieter beneath it. Run together on one line
 * the lead read as a bold opening clause rather than as the thing it is —
 * the name of the change — and a release of fifteen entries read as fifteen
 * paragraphs with no way in. Split, the page can be read at either depth:
 * skim the leads for what changed, or read on for what it means. The
 * what's-new card after an update shows the leads alone, for the same reason.
 *
 * The scale is the app's own (docs/design-principles.md, "Type scale"). The
 * date is the page's heading at 2xl; a lead is lg; the detail and everything
 * else is body. The category — **Added**, **Fixed** — steps *down* rather
 * than up, to a small label over a rule: it names a run of entries rather
 * than saying anything itself, and at any size above the leads it would
 * out-shout every change under it.
 */
export function ReleaseNotes({ release }: { release: ChangelogRelease }) {
  const count = release.sections.reduce((total, section) => total + section.entries.length, 0)
  return (
    // A release is named by `?release=…`, not by an anchor: the page shows one
    // at a time, so there is nothing on it to jump to. `data-week` is how the
    // tests ask which one is on screen.
    <article data-week={release.week} className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold leading-tight tracking-[-0.015em]">
          {formatReleaseDates(release.week)}
        </h2>
        <p className="text-sm text-text-secondary">
          {release.week} · {count} {count === 1 ? "change" : "changes"}
        </p>
      </header>
      {release.sections.map((section) => (
        <section key={section.category} className="flex flex-col gap-5">
          {/* The label and the rule that carries it across the column: the
              divider IS the heading, so a category costs a line rather than a
              heading's worth of weight. */}
          <h3 className="flex items-center gap-3 text-sm font-bold uppercase tracking-[0.08em] text-text-secondary">
            {section.category}
            <span aria-hidden className="h-px flex-1 bg-border-secondary" />
          </h3>
          <ul className="flex flex-col gap-6">
            {/* Keyed by position, NOT by `entry.line`. A week is collated from
                every file written that week (docs/changelog.md), and a line
                number only means anything within the file it came from — so
                each file's first bullet is line 3, and a week of seven files
                handed React the same key seven times. It answered by
                duplicating entries: switching weeks left the outgoing week's
                entries behind, and a few switches showed the same change
                three times over. A section's entries are a fixed list built
                once from disk, never reordered or filtered, so where an entry
                sits in it IS its identity. */}
            {section.entries.map((entry, index) => (
              <li key={index}>
                <Entry entry={entry} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  )
}

function Entry({ entry }: { entry: ChangelogEntry }) {
  return (
    <>
      <h4 className="text-lg font-bold leading-snug">
        <EntryText text={entry.lead} />
      </h4>
      {entry.detail ? (
        <p className="mt-1.5 leading-relaxed text-text-secondary">
          <EntryText text={entry.detail} />
        </p>
      ) : null}
    </>
  )
}

/** An entry's text, markdown and keycaps alike. The what's-new card draws its
 * leads with this too, so an entry reads the same in both places.
 *
 * Markdown between the keycaps: the `<kbd>` tags an entry names shortcuts
 * with are drawn as keys, and everything else is rendered as it is written. */
export function EntryText({ text }: { text: string }) {
  return (
    <>
      {toSegments(text).map((segment, index) =>
        segment.type === "keys" ? (
          <Keys key={index} keys={segment.keys} className="mx-px align-[0.05em]" />
        ) : (
          <Inline key={index} text={segment.text} />
        ),
      )}
    </>
  )
}

const components = {
  // An entry is one flowing sentence, so a paragraph is not a block here.
  p: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} className="link" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    // The same chip the editor draws inline code with, so a `type:todo` reads
    // the same on this page as it does in a note.
    <code className="box-decoration-clone rounded-sm border border-border-secondary bg-[var(--color-bg-code-block)] px-1.5 py-px font-mono text-[0.85em]">
      {children}
    </code>
  ),
}

/** Markdown trims the space at either end of what it is given, which would
 * close up the gap around a keycap, so it is put back around the render. */
const EDGE_WHITESPACE = /^(\s*)(.*?)(\s*)$/s

function Inline({ text }: { text: string }) {
  const [, lead, middle, trail] = EDGE_WHITESPACE.exec(text) ?? ["", "", text, ""]
  return (
    <>
      {lead}
      {middle ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {middle}
        </ReactMarkdown>
      ) : null}
      {trail}
    </>
  )
}
