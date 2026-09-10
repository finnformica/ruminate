import { useAtomValue } from "jotai"
import React from "react"
import { sortedNotesAtom, sortedTagEntriesAtom } from "../global-state"
import type { Note } from "../schema"
import { cx } from "../utils/cx"
import {
  SUGGESTED_QUALIFIER_KEYS,
  STATIC_QUALIFIER_OPTIONS,
  applyQualifierOption,
  filterQualifierOptions,
  findQualifierTrigger,
  type QualifierOption,
  type QualifierTrigger,
} from "../utils/qualifier-suggestions"
import { TagIcon16 } from "./icons"
import { NoteFavicon } from "./note-favicon"

/**
 * **The qualifier picker.** Type `type:`, `in:`, `tag:`, `has:` or `no:` into
 * a search box and a list of what can go there opens over it — the block and
 * note types, your notes, your tags — filtered as you keep typing, ↑/↓ to
 * move, ↵ or Tab to pick, Esc to leave what you typed. The pure grammar
 * (which token is under the caret, how a pick is spliced back) lives in
 * `src/utils/qualifier-suggestions.ts`; this file adds the corpus-backed
 * sets and the rendering, shared by the notes/tags pages' search input and
 * the ⌘K palette.
 */

/** A row of the picker: a query value, plus (for `in:`) the note it names. */
export interface SuggestionItem extends QualifierOption {
  note?: Note
}

/** How many corpus-backed rows (notes, tags) to list at once. */
const MAX_ITEMS = 8

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
  const tags = useAtomValue(sortedTagEntriesAtom)

  const trigger = React.useMemo(
    () => (caret === null ? null : findQualifierTrigger(value, caret)),
    [value, caret],
  )
  const known = trigger !== null && SUGGESTED_QUALIFIER_KEYS.includes(trigger.key)

  const items = React.useMemo<SuggestionItem[]>(() => {
    if (!trigger || !known) return []
    switch (trigger.key) {
      case "in": {
        // Notes by name, most recent first (the sorted order) — the open note
        // leading when nothing narrows the list yet.
        const options: SuggestionItem[] = notes.map((note) => ({
          value: note.id,
          label: note.displayName,
          description: note.id === currentNoteId ? "this note" : undefined,
          note,
        }))
        const current = options.find((option) => option.note?.id === currentNoteId)
        const rest = options.filter((option) => option !== current)
        const ordered = current && trigger.partial === "" ? [current, ...rest] : options
        return filterQualifierOptions(ordered, trigger.partial).slice(0, MAX_ITEMS)
      }
      case "tag":
        return filterQualifierOptions(
          tags.map(([tag, noteIds]) => ({ value: tag, description: String(noteIds.length) })),
          trigger.partial,
        ).slice(0, MAX_ITEMS)
      default:
        return filterQualifierOptions(STATIC_QUALIFIER_OPTIONS[trigger.key] ?? [], trigger.partial)
    }
  }, [trigger, known, notes, tags, currentNoteId])

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
  // row it would show is the word already there.
  const complete =
    trigger !== null &&
    items.length === 1 &&
    items[0].value.toLowerCase() === trigger.partial.trim().toLowerCase()
  const visible = trigger !== null && items.length > 0 && !complete && dismissed !== tokenKey

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

  return { visible, trigger, items, activeIndex, setActiveIndex, handleKeyDown, pick }
}

/** The group label for a key: the qualifier as typed, so the row reads as
 * "what completes `type:`". */
function headingFor(trigger: QualifierTrigger): string {
  return `${trigger.exclude ? "-" : ""}${trigger.key}:`
}

/**
 * The picker's rows. Pure presentation, in the slash menu's idiom (a card
 * of rows, one highlighted, a faint group label) — `floating` hangs under a
 * page's search input, `inline` sits inside the palette's card above its
 * list. Mousedown is cancelled so a click never blurs the input.
 */
export function QualifierSuggestions({
  trigger,
  items,
  activeIndex,
  variant,
  onHover,
  onPick,
}: {
  trigger: QualifierTrigger
  items: SuggestionItem[]
  activeIndex: number
  variant: "floating" | "inline"
  onHover: (index: number) => void
  onPick: (item: SuggestionItem) => void
}) {
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex, items])

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Suggestions"
      data-testid="qualifier-suggestions"
      tabIndex={-1}
      className={cx(
        "max-h-[45svh] overflow-auto font-sans text-base font-normal leading-normal text-text",
        variant === "floating" &&
          "card-2 absolute left-0 right-0 top-full z-20 mt-1 rounded-lg p-1",
        variant === "inline" && "border-t border-border-secondary p-2",
      )}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex h-7 items-center px-2 font-mono text-sm text-text-tertiary">
        {headingFor(trigger)}
      </div>
      {items.map((item, index) => {
        const active = index === activeIndex
        return (
          // Keyboard handling lives on the input (arrows / Enter / Esc); a row
          // only needs the pointer.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            key={item.value}
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
            <span className="grid h-4 w-4 shrink-0 place-items-center text-sm text-text-secondary">
              {item.note ? (
                <NoteFavicon note={item.note} />
              ) : trigger.key === "tag" ? (
                <TagIcon16 />
              ) : (
                <span aria-hidden className="font-mono text-text-tertiary">
                  :
                </span>
              )}
            </span>
            <span className="grow truncate">{item.label ?? item.value}</span>
            {item.description ? (
              <span className="shrink-0 text-sm text-text-secondary">{item.description}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
