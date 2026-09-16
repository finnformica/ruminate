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
 * One release, drawn from `CHANGELOG.md`.
 *
 * An entry is a lead sentence and the detail behind it (docs/changelog.md).
 * Here they are shown together, the lead carrying the weight and the detail
 * quieter beneath it, so a release can be read at either depth: skim the leads
 * for what changed, or read on for what it means. The dialog after an update
 * shows the leads alone.
 */
export function ReleaseNotes({ release }: { release: ChangelogRelease }) {
  const count = release.sections.reduce((total, section) => total + section.entries.length, 0)
  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-lg font-bold leading-tight">{formatReleaseDates(release.week)}</h2>
        <p className="text-sm text-text-secondary">
          {release.week} · {count} {count === 1 ? "change" : "changes"}
        </p>
      </header>
      {release.sections.map((section) => (
        <section key={section.category} className="flex flex-col gap-2">
          <h3 className="font-bold">{section.category}</h3>
          <ul className="flex flex-col gap-3">
            {section.entries.map((entry) => (
              <li key={entry.line} className="leading-relaxed">
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
      <span className="font-medium">
        <EntryText text={entry.lead} />
      </span>
      {entry.detail ? (
        <span className="text-text-secondary">
          {" "}
          <EntryText text={entry.detail} />
        </span>
      ) : null}
    </>
  )
}

/** An entry's text, markdown and keycaps alike. The dialog after an update
 * draws its leads with this too, so an entry reads the same in both places.
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
