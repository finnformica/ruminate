import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** Renders a single block's content *inline* (bold/italic/links/code spans).
 * An empty block renders nothing: the row keeps its line height on its own,
 * and the editor's placeholder lives in the textarea. */
export function BlockContent({ content }: { content: string }) {
  if (!content.trim()) return null
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
