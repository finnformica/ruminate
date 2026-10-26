/**
 * Arrows, as Notion types them: `->` becomes `→`, `<-` becomes `←`, `<->`
 * becomes `↔`, `=>` becomes `⇒`, `<=` becomes `⇐` and `<=>` becomes `⇔`.
 * The text holds the arrow itself, so a copy, a search and an export all
 * keep it.
 *
 * `<-` turns into `←` as its `-` is typed, so `<->` is reached as `←` and
 * then `>`; that, and a `<-` left as typed (an undo), both make `↔`. `<=>`
 * is reached the same way, through `⇐`. `undo` is what the reader typed,
 * when the rule's own text is not.
 *
 * `drawn: false`: not drawn in text stored as typed (`drawArrows`), where
 * `<=` was most likely written as "at most". `<=>` is drawn, so it does not
 * show as `<⇒`.
 */
const ARROWS: { typed: string; arrow: string; undo?: string; drawn?: false }[] = [
  { typed: "<->", arrow: "↔" },
  { typed: "←>", arrow: "↔", undo: "<->" },
  { typed: "<=>", arrow: "⇔" },
  { typed: "⇐>", arrow: "⇔", undo: "<=>" },
  { typed: "<-", arrow: "←" },
  { typed: "<=", arrow: "⇐", drawn: false },
  { typed: "->", arrow: "→" },
  { typed: "=>", arrow: "⇒" },
]

/** Whether `lead` ends inside a code span or `$$…$$` maths, where an arrow is
 * code and stays as typed: an odd number of backticks, or of `$$`. */
function inCode(lead: string): boolean {
  const ticks = lead.match(/`/g)?.length ?? 0
  const maths = lead.match(/\$\$/g)?.length ?? 0
  return ticks % 2 === 1 || maths % 2 === 1
}

/**
 * The arrow a typed character makes: `text` is the block's text with the
 * character just typed before `caret`. Returns the text with the arrow in
 * place, where the caret goes, and the text as the reader typed it (the
 * step an undo gives back: `<->`, not `←>`), or `null` when nothing turns.
 * The caller judges that one character was typed, and that the block is not
 * a code block.
 */
export function arrowOfTyped(
  text: string,
  caret: number,
): { text: string; caret: number; typed: string } | null {
  const before = text.slice(0, caret)
  const rule = ARROWS.find(({ typed }) => before.endsWith(typed))
  if (!rule) return null
  const lead = before.slice(0, -rule.typed.length)
  if (inCode(lead)) return null
  const after = text.slice(caret)
  return {
    text: lead + rule.arrow + after,
    caret: lead.length + rule.arrow.length,
    typed: rule.undo !== undefined ? lead + rule.undo + after : text,
  }
}

/**
 * The arrows of text stored as typed, before the text held them (a note
 * written before arrows were typed in): drawn, not stored, by the rendered
 * row. Code is the caller's to leave out.
 */
export function drawArrows(text: string): string {
  return ARROWS.filter((rule) => rule.drawn !== false).reduce(
    (drawn, { typed, arrow }) => drawn.replaceAll(typed, arrow),
    text,
  )
}
