import type { ReactNode } from "react"
import type { BlockType } from "../../blocks/block-type"
import { cx } from "../../utils/cx"
import { IconButton } from "../icon-button"
import { Hash } from "./hash"

/**
 * **How a block looks**, in one place. The editor's rows (`block-item.tsx`)
 * and the block search results (`search-results.tsx`) both draw their blocks
 * from these pieces — the 15px marker slot with its dot / `#` / number /
 * checkbox / `>`, the type scale (headings sized by outline depth), the
 * quote's bar, and the collapse chevron that swaps into the marker slot — so
 * a block in a filtered view is the same block, pixel for pixel, as in the
 * note it came from. By construction: there is no second drawing to drift.
 *
 * Everything here is presentation. State (is the block collapsed, selected,
 * being edited; what a click does) belongs to the caller.
 */

/** A heading's font size + line-height by outline depth. Shared by the full
 * typography (`typographyFor`) and the heading's `#` marker slot, whose
 * `h-[1lh]` must resolve against the same first-line height to centre on it. */
function headingScale(depth: number): string {
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

/**
 * Typography shared by a block's rendered view and its edit textarea, so
 * switching between them never changes the text's size or weight.
 *
 * Headings are sized by how deeply they're nested in the outline — not by how
 * many `#`s were typed (the marker is normalised to a single `#` on save). The
 * deepest level floors at body size, kept bold and underlined so it still reads
 * as a heading rather than a paragraph.
 */
export function typographyFor(type: BlockType, depth: number): string {
  switch (type.kind) {
    case "heading":
      // Headings tighten as they grow: large display sizes get a snugger
      // line-height and slightly negative tracking (see the type scale in
      // docs/design-principles.md).
      switch (depth) {
        case 0:
          return cx(headingScale(0), "font-bold tracking-[-0.015em]")
        case 1:
          return cx(headingScale(1), "font-bold tracking-[-0.01em]")
        case 2:
          return cx(headingScale(2), "font-bold")
        default:
          // Floors at body size; a soft offset underline keeps it reading as a
          // heading without the weight of a full text-color rule.
          return cx(
            headingScale(depth),
            "font-bold underline decoration-[color:var(--neutral-a6)] decoration-2 underline-offset-4",
          )
      }
    case "quote":
      return "text-base leading-relaxed text-text-secondary"
    default:
      return "text-base leading-relaxed"
  }
}

/** Extra space above a heading, proportional to its size (i.e. its outline
 * depth), so sections breathe. Applied to the block's outer wrapper (shared by
 * view and edit) so switching modes never shifts the text. */
export function headingTopMargin(type: BlockType, depth: number): string {
  if (type.kind !== "heading") return ""
  switch (depth) {
    case 0:
      return "mt-5"
    case 1:
      return "mt-4"
    case 2:
      return "mt-2.5"
    default:
      return "mt-1.5"
  }
}

/**
 * The collapse chevron. `.block-toggle` (block-editor.css) keeps it invisible
 * until its own square — the key slot, or the gutter square beside a todo;
 * never the whole row — is hovered (or, on a device with nothing to hover
 * with, always) — except on a COLLAPSED block, which pins it visible so
 * hidden content is never a secret. It floats out of the flow, centred on
 * whatever slot holds it, so the reveal never shifts the text. Centred by its
 * own midpoint (left/top 50% + a half-size translate), NOT by `inset-0
 * m-auto`: the 20px square is wider than the 15px slot, and an
 * over-constrained absolute box drops its left margin to zero instead of
 * going negative — which left-aligned the square and put the chevron 4.5px
 * right of the guide. Press feedback lives on the control (IconButton
 * supplies the hover surface); the content itself never animates on collapse.
 *
 * The square is 20px everywhere so it sits an even ~3.5px inside the
 * highlight surface on every side it touches: the surface is 27px tall (a
 * 23px line + 2px each side) and the key slot's centre is 13.5px in from its
 * left edge (2px reach + 6px padding + half of 15px) — the same distance as
 * the surface's vertical centre, so the square inset matches horizontally and
 * vertically. Beside a todo the same square straddles the surface's left
 * edge, its glyph tucked just outside it.
 */
export function BlockToggle({
  collapsed,
  beside = false,
  onToggle,
}: {
  collapsed: boolean
  /** The chevron sits beside a todo's checkbox (a hit area only — no hover
   * surface, so it never clashes with the checkbox or the highlight). */
  beside?: boolean
  onToggle: () => void
}) {
  return (
    <IconButton
      aria-label={collapsed ? "Expand" : "Collapse"}
      size="small"
      disableTooltip
      tabIndex={-1}
      onClick={(event) => {
        // In a results list the chevron may sit inside a clickable row (or a
        // cmdk item), which would otherwise take the click as "open this".
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
      className={cx(
        "block-toggle absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 shrink-0 p-0 text-text-tertiary transition-[opacity,transform] duration-150 active:scale-[0.92] motion-reduce:active:scale-100",
        // IconButton's default radius is the 8px base — on a 20px square that
        // reads as a pill. The small radius (4px) keeps it a square.
        "rounded-sm",
        // Coarse pointers get a 28px square to tap instead of IconButton's
        // 40px-tall padded bar (which would overlap neighbouring rows and
        // squeeze the glyph); it still sits inside the surface.
        "h-5 w-5 coarse:h-7 coarse:w-7 coarse:px-0",
        // Beside a todo the square is a hit area only — no hover surface, so
        // it never clashes with the checkbox or the highlight it straddles;
        // the chevron's own fade-in is the whole reveal. It stays 20px wide
        // on coarse pointers too: 28px would reach the checkbox.
        beside && "enabled:hover:bg-transparent enabled:active:bg-transparent coarse:w-5",
        collapsed && "block-toggle-pinned",
      )}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 8 8"
        aria-hidden
        className={cx(
          "transition-transform duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
          collapsed ? "rotate-0" : "rotate-90",
        )}
      >
        {/* A filled triangle with softened corners: the fill plus a round-
            joined stroke of the same ink, which rounds the three points. */}
        <path
          d="M2.6 1.6l3.2 2.4-3.2 2.4z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </IconButton>
  )
}

/**
 * The beside slot of a parent todo's chevron: a 20px slot (the chevron's
 * square) centred 5px OUTSIDE the surface's left edge, on the block's first
 * line, so the glyph hugs the block: its ink sits ~3px off the edge and stops
 * short of the checkbox (the slot ends 1px before it). Nested, that keeps it
 * clear of the parent's guide line, which runs 11px outside the edge — the
 * glyph's ink ends ≥2.5px right of it, so the two never touch. The caller
 * supplies the block's typography (so `h-[1lh]` sizes the slot to that line
 * whatever the scale) and the top offset mirroring the line's own vertical
 * padding. It FOLLOWS the marker in the DOM (position is absolute, so order
 * is invisible) so the checkbox slot's hover can reach it with a sibling
 * selector.
 */
export function BlockToggleBeside({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <span className={cx("block-toggle-beside absolute -left-[15px] h-[1lh] w-5", className)}>
      {children}
    </span>
  )
}

/**
 * The quote's bar: stands at the text column — where every other block's
 * text begins — and pushes the quote's text 10px in (bar 2px + the 8px gap):
 * a quote is set in from the rest, the way it is on the page. Rounded ends
 * and the glyph ink (tertiary), so it reads as chrome of the same family as
 * the `>` beside it. It stretches the line's full height so a wrapped quote
 * reads as one block.
 */
export function QuoteBar() {
  return <span aria-hidden className="w-0.5 shrink-0 self-stretch rounded-full bg-text-tertiary" />
}

/**
 * A block's marker: the 15px slot every block type owns, and the key it
 * carries there — a bullet dot, heading `#`, number, quote `>`, a todo's
 * checkbox; a paragraph's slot is empty (its text still starts in the shared
 * column). Every marker occupies the same slot, so body text starts at one
 * column across every block type and the markers read as one chrome family:
 * dots centre in it; text glyphs (`#`, number, `>`) right-align to its edge.
 *
 * On a parent the key is pure chrome, so it SWAPS for the collapse chevron
 * (`toggle`): hover the slot and the key fades out while the chevron fades
 * in, in the same slot — nothing moves. A todo's slot holds its checkbox — a
 * control, which never swaps out (that would leave a parent todo
 * un-tickable) — so a parent todo's chevron sits BESIDE the slot instead
 * (`toggleBeside`; see `BlockToggleBeside`), and hovering the box reveals it
 * (`.block-toggle-hint`, block-editor.css).
 *
 * List markers double as zoom targets when `onZoom` is given (Logseq-style:
 * click the bullet to make this block the page). The negative-margin padding
 * enlarges the hit area without shifting the marker's layout size.
 */
export function BlockMarker({
  type,
  depth,
  collapsed = false,
  toggle = null,
  toggleBeside = false,
  onZoom,
  readOnly = false,
  onToggleTodo,
}: {
  type: BlockType
  /** Outline depth — sizes a heading's `#` to match its text. */
  depth: number
  /** Whether the block is folded (pins the chevron, hides the key). */
  collapsed?: boolean
  /** The collapse chevron (`BlockToggle`) for a parent; null for a leaf. */
  toggle?: ReactNode
  /** The chevron sits beside the checkbox rather than in the slot (todos). */
  toggleBeside?: boolean
  /** Makes the dot / number a zoom button. */
  onZoom?: () => void
  /** The checkbox is display-only. */
  readOnly?: boolean
  /** Tick / untick a todo (ignored while read-only). */
  onToggleTodo?: () => void
}) {
  const hasToggle = toggle !== null && toggle !== undefined
  // The key of a swapping parent: fades out as the chevron fades in, and is
  // hidden outright while collapsed (the pinned chevron stands in for it).
  const keyClass = hasToggle ? cx("block-key", collapsed && "block-key-hidden") : undefined
  // The slot of a swapping parent is the chevron's hover area (see
  // `.block-toggle-slot` in block-editor.css). Not a todo's: its chevron is
  // beside, and hovering the checkbox must mean the checkbox.
  const slotClass = hasToggle && !toggleBeside ? "block-toggle-slot" : undefined
  const inSlot = toggleBeside ? null : toggle
  const zoomable = onZoom !== undefined

  // Each slot is `relative` so a swapped-in chevron centres on it, and
  // carries `slotClass` so hovering it reveals the chevron.
  //
  // The bullet's dot: on a leaf it zooms; on a parent it is the key that
  // swaps for the chevron.
  const dotSlot = (
    <span
      className={cx(
        "relative flex h-[1lh] w-[15px] shrink-0 items-center justify-center",
        slotClass,
      )}
    >
      {zoomable ? (
        <button
          type="button"
          aria-label="Zoom into block"
          tabIndex={-1}
          onClick={onZoom}
          className="-m-1.5 flex cursor-pointer items-center justify-center rounded-full p-1.5 transition-[background-color,transform] duration-150 hover:bg-bg-secondary active:scale-90 motion-reduce:active:scale-100"
        >
          {/* Faint, like the chevron — pure chrome; content leads. */}
          <span aria-hidden className="size-1.5 rounded-full bg-text-tertiary" />
        </button>
      ) : (
        <span aria-hidden className={cx("size-1.5 rounded-full bg-text-tertiary", keyClass)} />
      )}
      {inSlot}
    </span>
  )
  // A static text glyph key (the quote's `>`) or none at all (a paragraph):
  // faint, like the dot and the `#` — chrome, not content. CENTRED in the
  // slot, like the dot and the checkbox, not right-aligned like `#` and the
  // numbers: `>` is a narrow glyph, and right-aligned its ink sat 3px right
  // of the dot's centre (and of the guide line that hangs from it). Never a
  // zoom button (zoom stays on F / Cmd+. and bullet/number clicks); on a
  // parent it swaps for the collapse chevron. The empty paragraph slot keeps
  // its width so the text stays in the shared column, and still hosts a
  // parent's chevron.
  const glyphSlot = (glyph: string | null, testId: string) => (
    <span
      data-testid={testId}
      className={cx(
        "relative flex h-[1lh] w-[15px] shrink-0 items-center justify-center",
        slotClass,
      )}
    >
      {glyph ? (
        <span aria-hidden className={cx("select-none text-text-tertiary", keyClass)}>
          {glyph}
        </span>
      ) : null}
      {inSlot}
    </span>
  )

  switch (type.kind) {
    case "todo":
      // The checkbox IS the todo's marker — a control in the key slot, which
      // is why a parent todo's chevron sits beside it (see `toggleBeside`).
      // Hovering the box also reveals that chevron (`.block-toggle-hint`,
      // block-editor.css) — the marker is where people look for the fold
      // control — without the box ever giving up its own click. On coarse
      // pointers the box grows its own tap area (`.block-checkbox::before`).
      return (
        <span
          className={cx(
            "flex h-[1lh] w-[15px] shrink-0 items-center justify-center",
            toggleBeside && "block-toggle-hint",
          )}
        >
          <input
            type="checkbox"
            checked={type.checked}
            disabled={readOnly}
            readOnly={readOnly}
            tabIndex={readOnly ? -1 : undefined}
            onClick={(event) => event.stopPropagation()}
            onChange={readOnly ? undefined : onToggleTodo}
            className={cx("block-checkbox", readOnly ? "cursor-default" : "cursor-pointer")}
          />
        </span>
      )
    case "bullet":
      return dotSlot
    case "heading":
      // Headings hang the same grey `#` as the note / zoom titles — the shared
      // `Hash`, at the heading's own scale: the slot carries the heading's
      // size + weight (headingScale + bold, no underline — that lives in the
      // typography) and the glyph inherits it, so the hash always matches the
      // text beside it, at every depth. The slot stays the shared 15px column
      // (heading text aligns with every other marked block); the hash
      // right-aligns in it and, when a large scale outgrows the slot,
      // overflows LEFT, past the surface's edge — the text column never
      // moves. The slot's `h-[1lh]` (resolved at the heading's scale) centres
      // the glyph on the heading's first line. A static glyph, like the note
      // title's — never a zoom button (zoom stays on F / Cmd+. and
      // bullet/number clicks); on a parent it swaps for the collapse chevron.
      return (
        <span
          data-testid="heading-hash"
          className={cx(
            "relative flex h-[1lh] w-[15px] shrink-0 items-center justify-end font-bold",
            headingScale(depth),
            slotClass,
          )}
        >
          <Hash className={keyClass} />
          {inSlot}
        </span>
      )
    case "ordered":
      // Numbers are read (they carry order), so they sit one step up the ramp
      // from the dot — muted, not faint — and right-align to the slot edge.
      return (
        <span
          className={cx(
            "relative flex h-[1lh] min-w-[15px] shrink-0 items-center justify-end tabular-nums text-text-secondary",
            slotClass,
          )}
        >
          {zoomable ? (
            <button
              type="button"
              aria-label="Zoom into block"
              tabIndex={-1}
              onClick={onZoom}
              className="-mx-0.5 cursor-pointer rounded-sm px-0.5 transition-[background-color,transform] duration-150 hover:bg-bg-secondary active:scale-95 motion-reduce:active:scale-100"
            >
              {type.number}.
            </button>
          ) : (
            <span aria-hidden className={keyClass}>
              {type.number}.
            </span>
          )}
          {inSlot}
        </span>
      )
    case "quote":
      return glyphSlot(">", "quote-glyph")
    default:
      return glyphSlot(null, "paragraph-slot")
  }
}
