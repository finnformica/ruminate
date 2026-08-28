import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { BlockDoc } from "../../blocks/types"

/** Matches a block reference: `((blk_abc123))`. */
const REF_RE = /\(\(([a-z0-9_]+)\)\)/g

/** Renders a single block's markdown *inline* (bold/italic/links/code spans). */
function InlineMarkdown({ content }: { content: string }) {
  if (!content.trim()) {
    return <span className="text-text-tertiary italic">Empty</span>
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <>{children}</>,
        ul: ({ children }) => <span>{children}</span>,
        li: ({ children }) => <span>{children}</span>,
        a: ({ children, href }) => (
          <a
            href={href}
            className="link"
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {children}
          </a>
        ),
        code: ({ children }) => (
          // py is a hairline so the chip never inflates the line box (which
          // would break the pixel-identical view/edit swap).
          <code className="rounded-sm bg-bg-secondary box-decoration-clone px-1 py-px font-mono text-[0.9em]">
            {children}
          </code>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

/**
 * Renders a block's content, resolving `((block-ref))` transclusions live from
 * the doc — so editing the source block updates every reference. A cycle guard
 * (`visited`) prevents infinite recursion.
 */
export function BlockContent({
  content,
  doc,
  visited,
}: {
  content: string
  doc: BlockDoc
  visited?: Set<string>
}) {
  const seen = visited ?? new Set<string>()
  const segments: ReactNode[] = []
  let cursor = 0
  let key = 0
  REF_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = REF_RE.exec(content)) !== null) {
    if (match.index > cursor) {
      segments.push(<InlineMarkdown key={key++} content={content.slice(cursor, match.index)} />)
    }
    const refId = match[1]
    const target = doc.blocks[refId]
    if (target && !seen.has(refId)) {
      const nextSeen = new Set(seen)
      nextSeen.add(refId)
      segments.push(
        // Transcluded content is still content — full ink on a faint accent
        // tint (the "live" color role), not muted like chrome.
        <span key={key++} className="block-transclusion" title={`Transcluded from ${refId}`}>
          <BlockContent content={target.content} doc={doc} visited={nextSeen} />
        </span>,
      )
    } else {
      // Broken or cyclic reference — show it literally, flagged.
      segments.push(
        <span key={key++} className="text-text-danger">
          (({refId}))
        </span>,
      )
    }
    cursor = match.index + match[0].length
  }

  if (cursor < content.length) {
    segments.push(<InlineMarkdown key={key++} content={content.slice(cursor)} />)
  }

  return <>{segments}</>
}
