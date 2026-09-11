import { Fragment } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Processor } from "unified"

/**
 * Markdown's block-level rules, switched off for block bodies. A block is one
 * line of an outline whose type is data, so its text is shown exactly as
 * stored: a leading `- `, `# `, `> `, `1. `, a code fence, a tab — anything a
 * document parser would swallow as structure — stays visible, which is how a
 * line that migrated badly gets noticed and fixed. Only inline formatting
 * (bold, italic, links, code spans, strikethrough) is interpreted.
 */
const BLOCK_CONSTRUCTS = [
  "codeIndented",
  "codeFenced",
  "blockQuote",
  "list",
  "headingAtx",
  "setextUnderline",
  "thematicBreak",
  "htmlFlow",
  "definition",
  "table",
  "gfmFootnoteDefinition",
]

function remarkInlineOnly(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  const extensions = (data.micromarkExtensions ??= [])
  extensions.push({ disable: { null: BLOCK_CONSTRUCTS } })
}

const components = {
  p: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
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
  code: ({ children }: { children?: React.ReactNode }) => (
    // The inline code chip: a bordered, tinted pill in the mono face, a touch
    // smaller than the text around it (the Linear / Notion idiom). py is a
    // hairline so the chip never inflates the line box (which would break
    // the pixel-identical view/edit swap).
    <code className="rounded-md border border-border-secondary bg-[var(--color-bg-code-block)] box-decoration-clone px-1.5 py-px font-mono text-[0.85em]">
      {children}
    </code>
  ),
}

const EDGE_WHITESPACE = /^([ \t]*)(.*?)([ \t]*)$/s

/**
 * Renders a single block's content with inline formatting only. An empty
 * block renders nothing: the row keeps its line height on its own, and the
 * editor's placeholder lives in the textarea.
 *
 * Each line of a multi-line text is rendered on its own (the body is
 * `whitespace-pre-wrap`, so the newlines and any run of spaces show as
 * typed), and a line's leading and trailing whitespace — which the markdown
 * parser trims — is put back verbatim around it.
 */
export function BlockContent({ content }: { content: string }) {
  if (!content.trim()) return null
  return (
    <>
      {content.split("\n").map((line, index) => {
        const [, lead, middle, trail] = EDGE_WHITESPACE.exec(line) ?? ["", "", line, ""]
        return (
          <Fragment key={index}>
            {index > 0 ? "\n" : null}
            {lead}
            {middle ? (
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkInlineOnly]} components={components}>
                {middle}
              </ReactMarkdown>
            ) : null}
            {trail}
          </Fragment>
        )
      })}
    </>
  )
}
