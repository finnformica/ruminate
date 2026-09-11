import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Processor } from "unified"

/**
 * Switch off markdown's indented-code rule for block bodies. A block is one
 * line of an outline: indentation is structure (the row's depth), never
 * syntax, so text that happens to begin with a tab or four spaces (pasted
 * from elsewhere, say) must read as text. Left on, such a line rendered as a
 * `<pre>` code chip that never wrapped, running off a narrow screen.
 */
function remarkNoIndentedCode(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  const extensions = (data.micromarkExtensions ??= [])
  extensions.push({ disable: { null: ["codeIndented"] } })
}

/** Renders a single block's content *inline* (bold/italic/links/code spans).
 * An empty block renders nothing: the row keeps its line height on its own,
 * and the editor's placeholder lives in the textarea. */
export function BlockContent({ content }: { content: string }) {
  if (!content.trim()) return null
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkNoIndentedCode]}
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
        // A fence inside a text block (notes written before fences became
        // code blocks): the same panel as a code block, wrapping like it —
        // never a <pre> that runs off a narrow screen. The chip styling the
        // `code` component adds is undone for the code inside the panel.
        pre: ({ children }) => (
          <pre className="block-code my-0.5 whitespace-pre-wrap rounded-lg border border-border-secondary bg-[var(--color-bg-code-block)] px-3 py-2 font-mono text-[0.85em] [overflow-wrap:anywhere] [tab-size:2] [&>code]:rounded-none [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em]">
            {children}
          </pre>
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
