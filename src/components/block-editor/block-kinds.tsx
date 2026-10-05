import type React from "react"
import type { ReactNode } from "react"
import { figureAlignOf, type FigureAlign } from "../../blocks/figure"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import type { Block, BlockType } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { cx } from "../../utils/cx"
import { noteTypeOf } from "../../utils/note-type"
import { NoteFavicon } from "../note-favicon"
import type { BlockEditorApi } from "./block-item"
import { LinkCard } from "./link-card"
import { CodeHighlight } from "./code-highlight"
import { CodeLanguage } from "./code-language"
import { ImageFigure } from "./image-figure"

/**
 * **How each block type looks in a row** — the presentation half of the
 * registry (`src/blocks/registry.ts` holds the behaviour). `BlockItem`
 * draws every row from one of these: which key stands in the marker slot,
 * the typography the view and the textarea share, any panel the text sits
 * in, and the chrome around the content line (a quote's bar, a code block's
 * panel, an image's picture, a link block's card). Adding a type is adding
 * its entry here and in the registry; the row itself never names a type.
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
  /** The row draws a marker slot before the content line: every type with a
   * slot, and a parent of any type (its chevron needs one). A slotless
   * type's chrome that reaches the row's edge (a code block's panel) must
   * stop short of the slot when it is there. */
  slotted: boolean
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
  /** A RENDERED key for a `glyph` slot, where the key depends on the block
   * rather than being one fixed character — a note's favicon, which says
   * whether it is a day, a week or an ordinary note. Takes precedence over
   * `glyph`; like it, a parent's chevron swaps in for it on hover. */
  readonly glyphNode?: (block: Block) => ReactNode
  /** The empty/glyph slot's test id. */
  readonly slotTestId?: string
  /** A parent's collapse chevron sits beside the marker rather than
   * replacing it (the checkbox keeps its own click). */
  readonly toggleBeside?: boolean
  /** Text size and weight, by outline depth — the same on the rendered view
   * and the textarea, so switching never shifts a character. Given the block
   * too, for a type whose text follows its props (an image's caption sits
   * to the side its picture keeps to), and whether the row is LISTED — a
   * results view's (`BlockEditorApi.fixedRoots`), where a row is one among
   * many and a heading keeps the body's scale. */
  readonly typography: (depth: number, block: Block, listed: boolean) => string
  /** Extra space above the row, in px (headings breathe — not when listed). */
  readonly topMargin?: (depth: number, listed: boolean) => number
  /** The textarea's ghost text while empty. */
  readonly placeholder?: string
  /** How the view draws the body. The default is inline markdown
   * (`BlockContent`); a code block draws its text verbatim, tokenised for
   * its language. The textarea is untouched either way. */
  readonly body?: (block: Block) => ReactNode
  /** Extra classes on the rendered body (a checked to-do's strike-through). */
  readonly bodyClass?: string
  /** Chrome before the content line (a quote's bar). */
  readonly before?: (context: RowContext) => ReactNode
  /** Wrap the content line (an image's picture above its caption, a code
   * block's panel). The line itself stays chrome-free: the row sizes its
   * textarea by its text alone, so a panel's padding and border belong
   * here, around the line, never on it. */
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

/** The depth whose heading scale is the body's: what a listed heading (and
 * its `#` slot) is drawn at. */
export const LISTED_HEADING_DEPTH = 3

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
  // Listed as a result (the palette's rows, a `type:heading` search), a
  // heading is a row among many: bold, at the body's scale, level with the
  // note rows beside it — its `#` slot follows (`headingScale(LISTED)`).
  typography: (depth, _block, listed) => {
    if (listed) return cx(headingScale(LISTED_HEADING_DEPTH), "font-bold")
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
  topMargin: (depth, listed) =>
    listed ? 0 : depth === 0 ? 20 : depth === 1 ? 16 : depth === 2 ? 10 : 6,
}

/**
 * A note is a node like any other (docs/graph-schema-v2.md): its `text` is
 * the title, its `props` the metadata, and its children are its top-level
 * blocks. It draws as a row like any other too — which is what lets a note
 * search result, a note in the Views page and a note linked under a block all
 * be the same row. Its key is its **favicon** (the day for a daily note, a
 * calendar for a weekly one, the note icon otherwise): the one thing about a
 * note that its title does not already say, in the shared 15px marker slot
 * every other type's key sits in. Its text is ordinary body type — the 3xl
 * note-title scale belongs on the note's own page, not on a row among many.
 */
const note: BlockKind = {
  slot: "glyph",
  slotTestId: "note-favicon-slot",
  // The favicon is a MARKER, so on a note with blocks in it the collapse
  // chevron takes its place exactly as it does a bullet's dot or a heading's
  // `#`: revealed on hover, and pinned over it while the note is closed.
  // (The beside-placement is for a to-do, whose slot holds a checkbox — a
  // control, which a swap would leave un-tickable. A favicon is nothing of
  // the kind.)
  glyphNode: (block) => (
    <NoteFavicon note={{ id: block.id, type: noteTypeOf(block.id) }} className="size-[15px]" />
  ),
  // A note's title is a NAME, not content: it is set in the interface font
  // the sidebar and the note header use for it, not the content font the
  // blocks inside it are set in. Listed as a result it is drawn the way a
  // listed heading is — bold, at the body's scale, on the editor's rhythm —
  // so a note row and a heading row read as the same row with a different
  // key.
  typography: (_depth, _block, listed) => cx(BODY, "font-sans", listed && "font-bold"),
}

export const BLOCK_KINDS: Readonly<Record<BlockType, BlockKind>> = {
  text,
  note,
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
    // No marker slot: the panel is the ROW SURFACE, as below, so it starts
    // where the row does, as a picture does. A parent code block still gets
    // the slot back to host its chevron, and its panel starts after it.
    slot: "none",
    // Body type in the mono face — the same size and leading as a
    // paragraph, so a line of code is exactly as tall as a line of text and
    // the panel that fits one is exactly the surface every other row has.
    // The tab width rides the shared typography (a textarea inherits it),
    // so the view and the textarea agree on every column.
    typography: () => cx(BODY, "font-mono [tab-size:2]"),
    // The view is tokenised for the language (`code-highlight.tsx`); the
    // textarea shows the text plain in the same face, so the swap changes
    // colour and nothing else. Never markdown.
    body: (block) => (
      <CodeHighlight text={block.text} language={String(block.props?.language ?? "")} />
    ),
    // The panel — a tinted, bordered surface at the row's own radius —
    // WRAPS the line rather than being classes on it. The row sizes its
    // textarea by its text alone (`1lh` empty, else its scroll height) and
    // draws the view with the same `min-h-[1lh]`; padding and a border on
    // the line itself broke both: an empty block's one-line box was eaten
    // by its own padding (the caret clipped, then a jump to size on the
    // first keystroke), and the border went uncounted, so every edit was
    // 2px shorter than its view. Around the line, the chrome adds the same
    // to both states and the text never moves.
    //
    // Its box IS the row's highlight surface: it pulls over the line's
    // padding (2px above and below, 6px at the sides) with negative margins
    // that its border and 1px of padding pay back, so a one-line block is
    // the 27px every other row is, and turning a paragraph into code moves
    // nothing — the text keeps its column (the 28px of left padding is the
    // marker slot and gap it no longer has, less the border) and its right
    // edge, and the panel simply appears around it. After a parent's slot,
    // the panel starts where the slot ends and the text sits 4px in.
    // Selected, its border takes the selection ring's colour (`.block-code-
    // panel`, block-editor.css), since it sits exactly where the ring
    // would. The language sits in its top-right corner — chrome, not
    // content, and a control: click it to change it (`code-language.tsx`).
    wrap: (content, { block, api, slotted }) => {
      return (
        <div
          data-testid="code-panel"
          className={cx(
            "group block-code-panel prism relative -my-0.5 flex min-w-0 flex-1 rounded border border-border-secondary bg-[var(--color-bg-code-block)] py-px pr-[5px]",
            slotted ? "-mr-1.5 pl-1" : "-mx-1.5 pl-[28px]",
          )}
        >
          {content}
          <CodeLanguage block={block} api={api} />
        </div>
      )
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
      cx("text-sm leading-relaxed text-text-secondary", CAPTION_ALIGN[figureAlignOf(block)]),
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
    wrap: figureWrap("image-block", (content, { block, occurrence, api, editing }) => (
      <ImageFigure
        block={block}
        occurrence={occurrence}
        api={api}
        caption={editing || block.text.trim() !== "" ? lineOf(content) : null}
      />
    )),
  },
  link: {
    // No marker slot, as a picture has none: the card starts at the row's
    // edge.
    slot: "none",
    // The text is the title, set inside the card: body type, a touch heavier
    // than the description beneath it.
    typography: () => cx(BODY, "font-medium"),
    placeholder: "Add a title…",
    // The card (`LinkCard`) holds the title line — the block's text, the
    // ordinary body (view or textarea) — with the page's description and
    // byline beneath. An untitled link block drops the line rather than
    // leaving a blank one in the card (the card decides what stands in);
    // it comes back the moment the row is being edited, so a title can
    // still be typed.
    wrap: figureWrap("link-block", (content, context) => (
      <LinkCard
        block={context.block}
        occurrence={context.occurrence}
        api={context.api}
        title={context.editing || context.block.text.trim() !== "" ? lineOf(content) : null}
        editing={context.editing}
        pointer={rowPointer(context)}
      />
    )),
  },
}

/** The content line as a row, like the content line itself: the body's
 * `flex-1` then fills the width, and the textarea keeps the height it
 * measured for its lines (in a column it would collapse to one). */
const lineOf = (content: ReactNode) => <div className="flex min-w-0">{content}</div>

type Pointer = Pick<React.HTMLAttributes<HTMLElement>, "onClick" | "onDoubleClick">

/** What a click on the row does, off its text: select it and, double, edit
 * it — or, read-only, open it (a search result) or select it (a navigable
 * view), as the body's own click does. */
function rowPointer({ occurrence, api }: RowContext): Pointer {
  if (api.readOnly) {
    if (api.activate) return { onClick: () => api.activate?.(occurrence.key) }
    if (api.navigable) return { onClick: () => api.select(occurrence.key) }
    return {}
  }
  return {
    onClick: () => api.select(occurrence.key),
    onDoubleClick: () => api.edit(occurrence.key),
  }
}

/**
 * A figure's wrap (a picture, a link block's card): the figure in place of the
 * content line, with the line handed to it to place as its caption or
 * title. The wrap is the block's own padding: the row's surface gives text
 * 6px at the sides and 2px above and below, and the wrap tops that up so
 * the figure sits 10px in from the surface's edge all round. Its empty
 * space (beside a narrow figure, around a caption) is the block, so a click
 * there selects the row and a double click edits the text, as clicking
 * text does — the figure itself keeps its own clicks (a picture's lightbox,
 * a card's links) and stops them there.
 */
function figureWrap(
  testId: string,
  figure: (content: ReactNode, context: RowContext) => ReactNode,
): BlockKind["wrap"] {
  return (content, context) => {
    const pointer = rowPointer(context)
    const own =
      (handler?: React.MouseEventHandler<HTMLElement>) => (event: React.MouseEvent<HTMLElement>) =>
        event.target === event.currentTarget && handler?.(event)
    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div
        data-testid={testId}
        className="flex min-w-0 flex-1 flex-col px-1 py-2"
        onClick={own(pointer.onClick)}
        onDoubleClick={own(pointer.onDoubleClick)}
      >
        {figure(content, context)}
      </div>
    )
  }
}

/** The caption's text alignment, by the picture's. */
const CAPTION_ALIGN: Record<FigureAlign, string> = {
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
