import { useAtomValue } from "jotai"
import React from "react"
import { sortedNotesAtom } from "../global-state"
import type { Note } from "../schema"
import { cx } from "../utils/cx"
import {
  SUGGESTED_QUALIFIER_KEYS,
  STATIC_QUALIFIER_OPTIONS,
  applyQualifierOption,
  dateQualifierOptions,
  filterQualifierOptions,
  findQualifierTrigger,
  sortQualifierOptions,
  type QualifierOption,
  type QualifierTrigger,
} from "../utils/qualifier-suggestions"
import { CalendarIcon16, ImageIcon16, LinkIcon16, NoteIcon16 } from "./icons"
import { NoteFavicon } from "./note-favicon"

/**
 * **The qualifier picker.** Type `type:`, `in:`, `has:`, `no:`, `sort:` or
 * `date:` into a query box and a popover opens beside the token listing
 * what can go there — the block and note types, your notes, the sort keys,
 * a few relative dates — filtered as you keep typing, ↑/↓ to move, ↵ or
 * Tab to pick, Esc to leave what you typed. Focus never leaves the box: the
 * box's own text is what narrows the list. The pure grammar (which token is
 * under the caret, how a pick is spliced back) lives in
 * `src/utils/qualifier-suggestions.ts`; this file adds the corpus-backed set
 * and the rendering. The one box that shows it is `QueryBox`
 * (query-box.tsx), on the notes page and in the ⌘K palette alike.
 */

/** A row of the picker: a query value, plus (for `in:`) the note it names. */
export interface SuggestionItem extends QualifierOption {
  note?: Note
}

/** How many corpus-backed rows (notes) to list at once. */
const MAX_ITEMS = 8

/** Beside the token the popover is as wide as its rows, between these two;
 * on a narrow or touch screen it takes the box's width instead. */
export const QUALIFIER_POPOVER_MIN_WIDTH = 160
export const QUALIFIER_POPOVER_MAX_WIDTH = 288

/** What the key handler reads — a native or a React keyboard event. */
type SuggestionKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "preventDefault"
>

/**
 * The picker's state for one input. `value` and `caret` are the input's;
 * `currentNoteId` (the open note, if any) leads the `in:` list so scoping to
 * "this note" is one keystroke away.
 */
export function useQualifierSuggestions({
  value,
  caret,
  currentNoteId,
}: {
  value: string
  caret: number | null
  currentNoteId?: string
}) {
  const notes = useAtomValue(sortedNotesAtom)

  const trigger = React.useMemo(
    () => (caret === null ? null : findQualifierTrigger(value, caret)),
    [value, caret],
  )
  const known = trigger !== null && SUGGESTED_QUALIFIER_KEYS.includes(trigger.key)

  const items = React.useMemo<SuggestionItem[]>(() => {
    if (!trigger || !known) return []
    switch (trigger.key) {
      case "in": {
        // Notes by name, most recent first (the sorted order), the open note
        // leading — with nothing typed and among whatever the typing keeps.
        // A note open before it exists (today's daily note, say) is not in
        // the corpus yet, so it gets a row of its own, named by its id.
        const options: SuggestionItem[] = notes.map((note) => ({
          value: note.id,
          label: note.displayName,
          note,
        }))
        const current =
          options.find((option) => option.note?.id === currentNoteId) ??
          (currentNoteId ? { value: currentNoteId } : undefined)
        const rest = options.filter((option) => option !== current)
        const ordered = current ? [current, ...rest] : options
        return filterQualifierOptions(ordered, trigger.partial).slice(0, MAX_ITEMS)
      }
      case "sort":
        // Two steps: the key, then (after its colon) the direction.
        return filterQualifierOptions(sortQualifierOptions(trigger.partial), trigger.partial)
      case "date":
        // Built when asked for: the rows say which day each word means today.
        return filterQualifierOptions(dateQualifierOptions(), trigger.partial)
      default:
        return filterQualifierOptions(STATIC_QUALIFIER_OPTIONS[trigger.key] ?? [], trigger.partial)
    }
  }, [trigger, known, notes, currentNoteId])

  // The highlighted row, back to the top whenever the list changes shape.
  const [activeIndex, setActiveIndex] = React.useState(0)
  const listKey = trigger ? `${trigger.key}:${trigger.partial}:${trigger.start}` : ""
  const prevListKey = React.useRef(listKey)
  if (prevListKey.current !== listKey) {
    prevListKey.current = listKey
    if (activeIndex !== 0) setActiveIndex(0)
  }

  // Esc remembers the token it dismissed, so the picker stays shut until the
  // caret leaves it; once no qualifier is under the caret, the slate is clean
  // (render-phase reset, so the next token opens in the same pass).
  const [dismissed, setDismissed] = React.useState<string | null>(null)
  const tokenKey = trigger ? `${trigger.start}:${trigger.key}` : null
  if (tokenKey === null && dismissed !== null) setDismissed(null)
  // A value typed out in full (`type:heading`) needs no suggesting: the one
  // row it would show is the word already there — unless the row is only
  // half a value (a sort key, before its direction), which still has a
  // step to offer.
  const complete =
    trigger !== null &&
    items.length === 1 &&
    !items[0].partial &&
    items[0].value.toLowerCase() === trigger.partial.trim().toLowerCase()
  const visible = trigger !== null && items.length > 0 && !complete && dismissed !== tokenKey

  // The listbox and its rows carry ids so the input can point at the
  // highlighted row (`aria-activedescendant`, see `useComboboxAria`): a
  // screen reader then reads the row as the arrows move, though focus never
  // leaves the box.
  const listboxId = React.useId()
  const activeOptionId = visible
    ? optionId(listboxId, Math.min(activeIndex, items.length - 1))
    : null

  const pick = React.useCallback(
    (item: SuggestionItem, at: QualifierTrigger | null = trigger) => {
      if (!at) return null
      return applyQualifierOption(value, at, item)
    },
    [value, trigger],
  )

  /**
   * The keys the picker owns while open. Returns the pick to apply (the
   * caller writes it to its input), `true` when the key was consumed with
   * nothing to write, or `false` to let the key through.
   */
  const handleKeyDown = React.useCallback(
    (event: SuggestionKeyEvent): { value: string; caret: number } | boolean => {
      if (!visible || event.metaKey || event.ctrlKey || event.altKey) return false
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          setActiveIndex((index) => (index + 1) % items.length)
          return true
        case "ArrowUp":
          event.preventDefault()
          setActiveIndex((index) => (index - 1 + items.length) % items.length)
          return true
        case "Enter":
        case "Tab": {
          const item = items[Math.min(activeIndex, items.length - 1)]
          if (!item) return false
          event.preventDefault()
          return pick(item) ?? true
        }
        case "Escape":
          event.preventDefault()
          setDismissed(tokenKey)
          return true
        default:
          return false
      }
    },
    [visible, items, activeIndex, pick, tokenKey],
  )

  return {
    visible,
    trigger,
    items,
    activeIndex,
    setActiveIndex,
    handleKeyDown,
    pick,
    listboxId,
    activeOptionId,
  }
}

/**
 * The `type:` values that show an ICON rather than a markdown glyph: the
 * note types, which have no markdown at all, and the two block types whose
 * markdown is punctuation rather than a marker — an image and a link block,
 * drawn with the icons the mobile edit bar uses for them, since `![]` and
 * `[]()` read as noise in a list of markers.
 */
const TYPE_VALUE_ICONS: Record<string, React.ReactNode> = {
  note: <NoteIcon16 />,
  template: <NoteIcon16 />,
  daily: <CalendarIcon16 />,
  weekly: <CalendarIcon16 />,
  image: <ImageIcon16 />,
  link: <LinkIcon16 />,
}

/**
 * What a row shows in its leading slot: a note's favicon, a `type:` value's
 * icon where it has one, else its markdown glyph (a block type's marker, a
 * sort direction's arrow). Null when the row has no picture.
 *
 * The one place this is decided, for the query box's picker and the note
 * header's Filter menu alike (`src/components/view-controls.tsx`).
 */
function qualifierPicture(item: SuggestionItem, qualifierKey: string): React.ReactNode {
  if (item.note) return <NoteFavicon note={item.note} />
  if (qualifierKey === "type" && TYPE_VALUE_ICONS[item.value]) return TYPE_VALUE_ICONS[item.value]
  if (item.glyph)
    return (
      <span aria-hidden data-glyph={item.glyph} className="font-mono text-text-tertiary">
        {item.glyph}
      </span>
    )
  return null
}

/** Whether any row of `items` has a picture — the slot is drawn on every row
 * or on none, so the labels line up. (The note header's Filter menu draws it
 * on every row: its values are all `type:`, which always has one.) */
function anyQualifierPicture(items: readonly SuggestionItem[], qualifierKey: string): boolean {
  return items.some((item) => qualifierPicture(item, qualifierKey) !== null)
}

/**
 * The leading slot itself: one fixed box with its content CENTRED, so a
 * three-character glyph (`[x]`), a one-character one (`#`) and a 16px icon
 * all sit on the same axis down the list.
 */
export function QualifierPicture({
  item,
  qualifierKey,
}: {
  item: SuggestionItem
  qualifierKey: string
}) {
  return (
    <span className="grid h-4 w-6 shrink-0 place-items-center text-sm text-text-secondary">
      {qualifierPicture(item, qualifierKey)}
    </span>
  )
}

/** The DOM id of one row of the listbox. */
function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`
}

/**
 * Make the input read as the combobox the picker belongs to — for the whole
 * time the picker is open, and only then: `aria-expanded`, `aria-controls`
 * pointing at the listbox, and `aria-activedescendant` following the
 * highlighted row, so assistive technology announces each row as the arrows
 * move while keyboard focus stays in the box. Set on the element directly
 * (the palette's input carries the palette's own ARIA props) and put back
 * exactly as found when the picker closes.
 */
export function useComboboxAria(
  inputRef: React.RefObject<HTMLInputElement>,
  {
    visible,
    listboxId,
    activeOptionId,
  }: { visible: boolean; listboxId: string; activeOptionId: string | null },
) {
  React.useEffect(() => {
    const input = inputRef.current
    if (!input || !visible) return
    const names = ["role", "aria-expanded", "aria-controls", "aria-autocomplete"] as const
    const previous = names.map((name) => [name, input.getAttribute(name)] as const)
    input.setAttribute("role", "combobox")
    input.setAttribute("aria-expanded", "true")
    input.setAttribute("aria-controls", listboxId)
    input.setAttribute("aria-autocomplete", "list")
    return () => {
      for (const [name, value] of previous) {
        if (value === null) input.removeAttribute(name)
        else input.setAttribute(name, value)
      }
    }
  }, [inputRef, visible, listboxId])

  React.useEffect(() => {
    const input = inputRef.current
    if (!input) return
    if (visible && activeOptionId) input.setAttribute("aria-activedescendant", activeOptionId)
    else input.removeAttribute("aria-activedescendant")
  }, [inputRef, visible, activeOptionId])
}

/** Where the popover hangs, in px within its positioned host: under the
 * box, at the token, as wide as its rows up to `maxWidth` (the room to the
 * box's right edge, at most `QUALIFIER_POPOVER_MAX_WIDTH`) — or, on a
 * narrow or touch screen, the box's full `width` (`full`), where a card
 * beside the token would have nowhere to go. */
export interface QualifierPopoverPlacement {
  top: number
  left: number
  /** The box's width, in full mode. */
  width?: number
  maxWidth: number
  full: boolean
}

/**
 * The picker's rows: a card in the slash menu's idiom (rows, one
 * highlighted — no label and no key hints, which only crowded it), hung
 * where `placement` says. Pure presentation — the
 * box owns the state and the keys. Mousedown is cancelled so a click never
 * blurs the input.
 */
export function QualifierPopover({
  id,
  trigger,
  items,
  activeIndex,
  placement,
  onHover,
  onPick,
}: {
  /** The listbox's id (the input's `aria-controls`). */
  id: string
  trigger: QualifierTrigger
  items: SuggestionItem[]
  activeIndex: number
  placement: QualifierPopoverPlacement
  onHover: (index: number) => void
  onPick: (item: SuggestionItem) => void
}) {
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex, items])

  // Whether any row has something for the leading slot: the slot is drawn
  // on every row or on none, so the labels line up.
  const pictured = anyQualifierPicture(items, trigger.key)

  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label="Suggestions"
      data-testid="qualifier-suggestions"
      data-placement={placement.full ? "full" : "token"}
      tabIndex={-1}
      style={{
        top: placement.top,
        left: placement.left,
        width: placement.full ? placement.width : "max-content",
        minWidth: placement.full ? undefined : QUALIFIER_POPOVER_MIN_WIDTH,
        maxWidth: placement.maxWidth,
      }}
      className="card-2 absolute z-30 max-h-[45svh] overflow-auto rounded-lg p-1 font-sans text-base font-normal leading-normal text-text"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        const active = index === activeIndex
        return (
          // Keyboard handling lives on the input (arrows / Enter / Esc); a row
          // only needs the pointer.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            key={item.value}
            id={optionId(id, index)}
            role="option"
            aria-selected={active}
            tabIndex={-1}
            data-suggestion={item.value}
            className={cx(
              "flex h-8 cursor-pointer select-none items-center gap-3 rounded px-2",
              active && "bg-bg-hover",
            )}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(item)}
          >
            {/* The leading slot: a note's favicon, a block type's markdown
                glyph, a note type's icon, a sort direction's arrow. A list
                with no pictures at all (`has:`, the sort keys) has no slot,
                so its labels start at the edge. */}
            {pictured ? <QualifierPicture item={item} qualifierKey={trigger.key} /> : null}
            <span className="min-w-0 grow truncate">{item.label ?? item.value}</span>
          </div>
        )
      })}
    </div>
  )
}
