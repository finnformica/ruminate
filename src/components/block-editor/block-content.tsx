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
          // The inline code chip: a bordered, tinted pill in the mono face,
          // a touch smaller than the text around it (the Linear / Notion
          // idiom). py is a hairline so the chip never inflates the line box
          // (which would break the pixel-identical view/edit swap).
          <code className="rounded-md border border-border-secondary bg-[var(--color-bg-code-block)] box-decoration-clone px-1.5 py-px font-mono text-[0.85em]">
            {children}
          </code>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
