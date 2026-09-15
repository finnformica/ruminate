/**
 * A block's text as one plain line, for a place that cannot render inline
 * markdown — a sidebar row, a tooltip: emphasis and code spans lose their
 * marks, a link is its text, and the line breaks are spaces. Only the marks
 * `block-content.tsx` renders are stripped; anything else is text.
 */
export function inlineText(text: string): string {
  return (
    text
      // A link is its text; an image (which is never inline) its alt.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // A code span is its code.
      .replace(/`+([^`]+?)`+/g, "$1")
      // Bold and italic, `**`/`__` before `*`/`_`; a lone mark in a word
      // (snake_case, 2*3) is text and is left alone.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim()
  )
}
