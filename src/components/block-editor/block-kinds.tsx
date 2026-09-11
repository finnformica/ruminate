import type React from "react"
import type { ReactNode } from "react"
import { imageAlignOf, type ImageAlign } from "../../blocks/image"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import type { Block, BlockType } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { cx } from "../../utils/cx"
import type { BlockEditorApi } from "./block-item"
import { ImageFigure } from "./image-figure"

/**
 * **How each block type looks in a row** — the presentation half of the
 * registry (`src/blocks/registry.ts` holds the behaviour). `BlockItem`
 * draws every row from one of these: which key stands in the marker slot,
 * the typography the view and the textarea share, any panel the text sits
 * in, and the chrome around the content line (a quote's bar, a code block's
 * language, an image's picture). Adding a type is adding its entry here and
 * in the registry; the row itself never names a type.
 */

/** What the row hands a kind's chrome. */
export interface RowContext {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  depth: number
  /** The row's text is a textarea right now, not rendered text. Chrome that
   * hides an empty line (an image's caption) must keep it while it is being
   * typed into. */
  editing: boolean
}

export interface BlockKind {
  /** The key in the marker slot: a to-do's checkbox, a bullet's dot, a
   * heading's `#`, a numbered item's number, or a static glyph (none for a
   * paragraph — the slot keeps its width so text stays in one column).
   * `none` drops the slot altogether (an image, which has no text column to
   * keep); a parent still gets the slot back to host its chevron. */
  readonly slot: "checkbox" | "dot" | "hash" | "number" | "glyph" | "none"
  /** The glyph for a `glyph` slot, or null for an empty slot. */
  readonly glyph?: string | null
  /** The empty/glyph slot's test id. */
  readonly slotTestId?: string
  /** A parent's collapse chevron sits beside the marker rather than
   * replacing it (the checkbox keeps its own click). */
  readonly toggleBeside?: boolean
  /** Text size and weight, by outline depth — the same on the rendered view
   * and the textarea, so switching never shifts a character. Given the block
   * too, for a type whose text follows its props (an image's caption sits
   * to the side its picture keeps to). */
  readonly typography: (depth: number, block: Block) => string
  /** Extra space above the row, in px (headings breathe). */
  readonly topMargin?: (depth: number) => number
  /** A panel the text sits in — the same classes on view and textarea. */
  readonly panel?: string
  /** The textarea's ghost text while empty. */
  readonly placeholder?: string
  /** The body is shown verbatim, not as inline markdown. */
  readonly verbatim?: boolean
  /** Extra classes on the rendered body (a checked to-do's strike-through). */
  readonly bodyClass?: string
  /** Chrome before the content line (a quote's bar). */
  readonly before?: (context: RowContext) => ReactNode
  /** Chrome after the content line (a code block's language). */
  readonly after?: (context: RowContext) => ReactNode
  /** Wrap the content line (an image's picture above its caption). */
  readonly wrap?: (content: ReactNode, context: RowContext) => ReactNode
}

/** A heading's font size + line-height by outline depth. Shared by the full
 * typography and the heading's `#` marker slot, whose `h-[1lh]` must resolve
 * against the same first-line height to centre on it. */
export function headingScale(depth: number): string {
  switch (depth) {
    case 0:
      return "text-2xl leading-tight"
    case 1:
      return "text-xl leading-tight"
    case 2:
      return "text-lg leading-snug"
    default:
      return "text-base leading-relaxed"
  }
}

const BODY = "text-base leading-relaxed"

const text: BlockKind = {
  slot: "glyph",
  glyph: null,
  slotTestId: "paragraph-slot",
  typography: () => BODY,
}

const todo: BlockKind = {
  slot: "checkbox",
  toggleBeside: true,
  typography: () => BODY,
  // Checking a todo mutes its text; the fade marks the state change without
  // delaying it.
  bodyClass: "transition-colors duration-200",
}

/**
 * Headings are sized by how deeply they're nested in the outline — not by
 * how many `#`s were typed (the marker is normalised to a single `#` on
 * save). They tighten as they grow: large display sizes get a snugger
 * line-height and slightly negative tracking (see the type scale in
 * docs/design-principles.md). The deepest level floors at body size, kept
 * bold and underlined so it still reads as a heading rather than a
 * paragraph. Their breathing room is a margin above, proportional to size.
 */
const heading: BlockKind = {
  slot: "hash",
  typography: (depth) => {
    switch (depth) {
      case 0:
        return cx(headingScale(0), "font-bold tracking-[-0.015em]")
      case 1:
        return cx(headingScale(1), "font-bold tracking-[-0.01em]")
      case 2:
        return cx(headingScale(2), "font-bold")
      default:
        return cx(
          headingScale(depth),
          "font-bold underline decoration-[color:var(--neutral-a6)] decoration-2 underline-offset-4",
        )
    }
  },
  topMargin: (depth) => (depth === 0 ? 20 : depth === 1 ? 16 : depth === 2 ? 10 : 6),
}

export const BLOCK_KINDS: Readonly<Record<BlockType, BlockKind>> = {
  text,
  page: text,
  ul: { slot: "dot", typography: () => BODY },
  ol: { slot: "number", typography: () => BODY },
  todo,
  done: { ...todo, bodyClass: cx(todo.bodyClass, "text-text-secondary line-through") },
  h1: heading,
  h2: heading,
  h3: heading,
  quote: {
    slot: "glyph",
    glyph: ">",
    slotTestId: "quote-glyph",
    typography: () => cx(BODY, "text-text-secondary"),
    // The quote's bar stands at the text column — where every other block's
    // text begins — and pushes the quote's text 10px in (bar 2px + the 8px
    // gap): a quote is set in from the rest, the way it is on the page.
    // Rounded ends and the glyph ink (tertiary), so it reads as chrome of
    // the same family as the `>` beside it. It stretches the line's full
    // height so a wrapped quote reads as one block.
    before: () => (
      <span
        aria-hidden
        className="block-glyph-fill w-0.5 shrink-0 self-stretch rounded-full bg-text-tertiary"
      />
    ),
  },
  code: {
    // A code block keys on nothing, like a paragraph: the panel is its marker.
    slot: "glyph",
    glyph: null,
    slotTestId: "code-slot",
    // Set in the mono face, a touch smaller, inside its panel.
    typography: () => "font-mono text-[0.9em] leading-relaxed",
    // A tinted, bordered, padded surface the text sits in. Whitespace is
    // kept as typed.
    panel:
      "block-code rounded-lg border border-border-secondary bg-[var(--color-bg-code-block)] px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]",
    // Verbatim: a code block's text is not markdown.
    verbatim: true,
    // The language, top-right of the panel — chrome, not content.
    after: ({ block }) => {
      const language = String(block.props?.language ?? "")
      return language ? (
        <span
          aria-hidden
          data-testid="code-language"
          className="pointer-events-none absolute right-2 top-1.5 select-none font-mono text-[11px] leading-4 text-text-tertiary"
        >
          {language}
        </span>
      ) : null
    },
  },
  image: {
    // No marker slot: the picture starts where the row does, not 15px in
    // from it as text would.
    slot: "none",
    // The text is the caption: small, quiet, beneath the picture, and set to
    // the side the picture keeps to — centred under a centred picture, flush
    // left under a left-aligned one. The alignment rides the shared
    // typography so the view and the textarea agree — switching between
    // them never shifts a character.
    typography: (_depth, block) =>
      cx("text-sm leading-relaxed text-text-secondary", CAPTION_ALIGN[imageAlignOf(block)]),
    placeholder: "Add a caption…",
    // The picture above its caption, which is the block's text: the caption
    // line is the ordinary body (view or textarea), so every keyboard and
    // paste behaviour is the same as on any block. The figure (`ImageFigure`)
    // holds both, so the caption is exactly as wide as the picture and sits
    // wherever it does — under a picture dragged narrower and set to one
    // side, the caption goes with it. An uncaptioned picture drops the line
    // entirely rather than leaving a blank one under it — the row is then
    // just the picture. It comes back the moment the row is being edited, so
    // a caption can still be typed.
    //
    // The wrap is the block's own padding: the row's surface gives text 6px
    // at the sides and 2px above and below, and the wrap tops that up so the
    // picture sits 10px in from the surface's edge all round. Its empty
    // space (beside a narrow picture, around the caption) is the block, so a
    // click there selects the row and a double click edits the caption, as
    // clicking text does — the picture itself keeps its own click (the
    // lightbox) and stops it here.
    wrap: (content, { block, occurrence, api, editing }) => {
      const own = (event: React.MouseEvent) => event.target === event.currentTarget
      const pointer = api.readOnly
        ? api.activate
          ? { onClick: (e: React.MouseEvent) => own(e) && api.activate?.(occurrence.key) }
          : {}
        : {
            onClick: (e: React.MouseEvent) => own(e) && api.select(occurrence.key),
            onDoubleClick: (e: React.MouseEvent) => own(e) && api.edit(occurrence.key),
          }
      return (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
        <div
          data-testid="image-block"
          className="flex min-w-0 flex-1 flex-col px-1 py-2"
          {...pointer}
        >
          <ImageFigure
            block={block}
            occurrence={occurrence}
            api={api}
            caption={
              editing || block.text.trim() !== "" ? (
                // A row, like the content line itself: the body's `flex-1`
                // then fills the width, and the textarea keeps the height
                // it measured for its lines (in a column it would collapse
                // to one).
                <div className="flex min-w-0">{content}</div>
              ) : null
            }
          />
        </div>
      )
    },
  },
}

/** The caption's text alignment, by the picture's. */
const CAPTION_ALIGN: Record<ImageAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
}

/** The presentation of a type; an unknown stored type draws as text. */
export function kindOf(type: BlockType): BlockKind {
  return BLOCK_KINDS[type] ?? text
}

/** Every registry entry must have a presentation — checked by test. */
export const KINDS_COVER_REGISTRY = BLOCK_TYPE_DEFS.every((def) => def.id in BLOCK_KINDS)
