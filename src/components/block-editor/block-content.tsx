import type { Root } from "mdast"
import { Fragment } from "react"
import ReactMarkdown from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import type { Processor } from "unified"

/**
 * Markdown's block-level rules, switched off for block bodies. A block is one
 * line of an outline whose type is data, so its text is shown exactly as
 * stored: a leading `- `, `# `, `> `, `1. `, a code fence, a tab — anything a
 * document parser would swallow as structure — stays visible, which is how a
 * line that migrated badly gets noticed and fixed. Only inline formatting
 * (bold, italic, links, code spans, strikethrough, `$$…$$` maths) is
 * interpreted.
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
  "mathFlow",
]

function remarkInlineOnly(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  const extensions = (data.micromarkExtensions ??= [])
  extensions.push({ disable: { null: BLOCK_CONSTRUCTS } })
}

/**
 * Maths: `$$…$$` within a line is set inline; a line that is nothing but
 * maths is set in display mode (centred, full-size operators). Single-dollar
 * maths is off, so a price in a sentence is never mistaken for a formula.
 * KaTeX emits MathML only — the browser typesets it, no stylesheet needed.
 */
const MATH_OPTIONS = { singleDollarTextMath: false }
const KATEX_OPTIONS = { output: "mathml" as const }

interface MathNode {
  type: string
  children?: MathNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function remarkDisplayMathLines() {
  return (tree: Root) => {
    const visit = (node: MathNode) => {
      const only = node.children?.length === 1 ? node.children[0] : null
      if (node.type === "paragraph" && only?.type === "inlineMath") {
        only.data = {
          ...only.data,
          hProperties: { ...only.data?.hProperties, className: ["language-math", "math-display"] },
        }
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree as unknown as MathNode)
  }
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
              <ReactMarkdown
                remarkPlugins={[
                  remarkGfm,
                  [remarkMath, MATH_OPTIONS],
                  remarkInlineOnly,
                  remarkDisplayMathLines,
                ]}
                rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
                components={components}
              >
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
