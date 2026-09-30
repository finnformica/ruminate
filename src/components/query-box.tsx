import React from "react"
import { createPortal } from "react-dom"
import { useHotkeys } from "react-hotkeys-hook"
import { APP_SHORTCUTS } from "../shortcuts/registry"
import { composeQuery, extractQualifiers, splitQuery } from "../utils/search"
import { caretCoordinates } from "./block-editor/caret"
import { IconButton } from "./ui/icon-button"
import { ClearIcon16, SearchIcon16 } from "./icons"
import { Keys } from "./ui/keys"
import { searchField } from "./ui/search-field"
import {
  QUALIFIER_POPOVER_MAX_WIDTH,
  QUALIFIER_POPOVER_MIN_WIDTH,
  QualifierPopover,
  useComboboxAria,
  useQualifierSuggestions,
  type QualifierPopoverPlacement,
} from "./qualifier-suggestions"
import { QueryPill } from "./query-pill"

/**
 * **The query box** — the one search input, on the Views page and in the
 * ⌘K palette. The query is the caller's, one string (`in:n1 type:todo
 * milk`); the box shows it as the **filters**, each a pill beneath the line
 * (`QueryPill`), and the **text** in the line. A qualifier is lifted out of
 * the line the moment it is finished — a space typed after it, or a pick
 * from the qualifier popover (`type:`, `in:`, … — qualifier-suggestions.tsx)
 * — so the line only ever holds the words being searched for; ⌫ on an
 * empty line takes the last pill back into it to edit, and a pill's click
 * takes it out of the query.
 *
 * The box also owns the caret (read off the input on every change and
 * move), the popover hung beside the token being typed, and the hand-off
 * of the keyboard to the result rows on ↓ (`onHandOff`) and of the query
 * on ↵ (`onSubmit`). What differs between the two places is the dress
 * (`variant`) and what the surface does with a hand-off or a submit —
 * never the typing.
 *
 * While the popover is open its keys are the popover's — ↑/↓, ↵, Tab, Esc —
 * and the event stops here, so nothing beneath (the palette's list, the
 * page's shortcuts) ever moves under it. Every other key is the input's.
 */
export function QueryBox({
  value,
  onChange,
  placeholder = "Search…",
  variant = "page",
  shortcut,
  currentNoteId,
  onHandOff,
  onSubmit,
  popoverHost,
  inputRef: inputRefProp,
  onKeyDown,
  onKeyUp,
  onClick,
  onFocus,
  onBlur,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"input">, "onChange" | "value"> & {
  value: string
  onChange: (value: string) => void
  /** The page's search box (rounded, with its icon and clear button) or the
   * palette's bare line. */
  variant?: "page" | "palette"
  /** Shown at the right while empty; the key also focuses the box. */
  shortcut?: string[]
  /** The open note, if any: leads the `in:` suggestions. */
  currentNoteId?: string
  /** ↓ with the popover shut: take the keyboard to the rows. Return true
   * when it was taken (the key is then consumed here). */
  onHandOff?: () => boolean
  /** ↵ with the popover shut: commit the query. Return true when it was. */
  onSubmit?: () => boolean
  /** A positioned ancestor to hang the popover in, when the box's own
   * wrapper would clip it (the palette's card). */
  popoverHost?: React.RefObject<HTMLElement>
  inputRef?: React.RefObject<HTMLInputElement>
}) {
  const ownRef = React.useRef<HTMLInputElement>(null)
  const inputRef = inputRefProp ?? ownRef
  const wrapperRef = React.useRef<HTMLDivElement>(null)

  // The split of the caller's string into pills and line is kept here: the
  // string alone cannot say whether `type:to` is a finished filter or half
  // a word, so what this box lifted out stays lifted, and what is typed
  // stays in the line. A value the caller sets on its own — back/forward,
  // a link in, a preset — is read afresh, every qualifier in it a pill.
  // The caller holds the string in state of its own and writes it back the
  // same render (a caller that echoed it a render late would reset the
  // caret as it did).
  const [shown, setShown] = React.useState(() => splitQuery(value))
  const emittedRef = React.useRef(value)
  if (value !== emittedRef.current) {
    emittedRef.current = value
    const next = splitQuery(value)
    if (next.text !== shown.text || next.qualifiers.join(" ") !== shown.qualifiers.join(" ")) {
      setShown(next)
    }
  }
  const emit = (qualifiers: string[], text: string) => {
    const next = composeQuery(qualifiers, text)
    emittedRef.current = next
    setShown({ qualifiers, text })
    onChange(next)
  }

  // The caret, and whether the box has focus: the popover follows the
  // caret while the box is focused and is gone the moment it is not.
  const [caret, setCaret] = React.useState<number | null>(null)
  const [focused, setFocused] = React.useState(false)
  const syncCaret = React.useCallback(
    () => setCaret(inputRef.current?.selectionStart ?? null),
    [inputRef],
  )
  const suggestions = useQualifierSuggestions({
    value: shown.text,
    caret: focused ? caret : null,
    currentNoteId,
  })
  useComboboxAria(inputRef, suggestions)

  // A caret the box places itself (a pick moved it past the token; a lifted
  // filter took text out before it): the DOM is told after the render that
  // writes the new value (no caret event follows a value React set).
  const pendingCaret = React.useRef<number | null>(null)
  React.useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    const at = pendingCaret.current
    pendingCaret.current = null
    inputRef.current?.setSelectionRange(at, at)
  })
  /** The line as typed (or as a pick wrote it): finished qualifiers become
   * pills, the rest stays in the line with the caret where it was. */
  const changeLine = (text: string, at: number, placeCaret = false) => {
    const lifted = extractQualifiers(text, at)
    if (lifted.qualifiers.length > 0 || placeCaret) pendingCaret.current = lifted.caret
    setCaret(lifted.caret)
    emit([...shown.qualifiers, ...lifted.qualifiers], lifted.text)
  }
  const applyPick = (next: { value: string; caret: number }) =>
    changeLine(next.value, next.caret, true)

  // Where the popover hangs: under the box, at the token — measured in the
  // host's coordinates, since the host is what it is positioned in — as
  // wide as its rows, never past the box's right edge (the token's left
  // gives way when the room there is under the minimum). A narrow box or
  // a touch screen gets it the box's full width instead.
  const [placement, setPlacement] = React.useState<QualifierPopoverPlacement | null>(null)
  const tokenStart = suggestions.visible ? (suggestions.trigger?.start ?? null) : null
  React.useLayoutEffect(() => {
    if (tokenStart === null) return
    const place = () => {
      const input = inputRef.current
      const host = popoverHost?.current ?? wrapperRef.current
      if (!input || !host) return
      const box = input.getBoundingClientRect()
      const frame = host.getBoundingClientRect()
      const top = box.bottom - frame.top + POPOVER_GAP
      const coarse =
        typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches
      if (coarse || box.width < QUALIFIER_POPOVER_MAX_WIDTH * 1.5) {
        setPlacement({
          top,
          left: box.left - frame.left,
          width: box.width,
          maxWidth: box.width,
          full: true,
        })
        return
      }
      const { left } = caretCoordinates(input, tokenStart)
      const at = box.left - frame.left + left
      const first = box.left - frame.left
      const right = box.right - frame.left
      const placedLeft = Math.max(first, Math.min(at, right - QUALIFIER_POPOVER_MIN_WIDTH))
      setPlacement({
        top,
        left: placedLeft,
        maxWidth: Math.min(QUALIFIER_POPOVER_MAX_WIDTH, right - placedLeft),
        full: false,
      })
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [tokenStart, inputRef, popoverHost])

  // When the caller shows the hint, its key also focuses the box — but never
  // while typing somewhere else (form tags stay disabled for this hotkey).
  useHotkeys(
    APP_SHORTCUTS.focusSearch,
    () => inputRef.current?.focus(),
    { preventDefault: true, enabled: Boolean(shortcut) },
    [shortcut],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // The popover's keys, while it is open: the event stops here.
    const handled = suggestions.handleKeyDown(event)
    if (handled) {
      event.stopPropagation()
      if (typeof handled === "object") applyPick(handled)
      return
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    // ⌫ on an empty line takes the last pill back into it, to edit.
    if (plain && event.key === "Backspace" && shown.text === "" && shown.qualifiers.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      const token = shown.qualifiers[shown.qualifiers.length - 1]
      pendingCaret.current = token.length
      setCaret(token.length)
      emit(shown.qualifiers.slice(0, -1), token)
      return
    }
    if (plain && event.key === "ArrowDown" && onHandOff?.()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (plain && event.key === "Enter" && onSubmit?.()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    onKeyDown?.(event)
  }

  const clear = () => {
    emit([], "")
    inputRef.current?.focus()
  }
  const removePill = (index: number) => {
    emit(
      shown.qualifiers.filter((_, i) => i !== index),
      shown.text,
    )
    inputRef.current?.focus()
  }

  // The filters, as pills — the query's qualifiers, out of the line.
  const pills =
    shown.qualifiers.length > 0 ? (
      <div data-testid="query-filters" className="flex flex-wrap gap-2">
        {shown.qualifiers.map((token, index) => (
          <QueryPill key={`${index}:${token}`} token={token} onRemove={() => removePill(index)} />
        ))}
      </div>
    ) : null

  const popover =
    suggestions.visible && suggestions.trigger && placement ? (
      <QualifierPopover
        id={suggestions.listboxId}
        trigger={suggestions.trigger}
        items={suggestions.items}
        activeIndex={suggestions.activeIndex}
        placement={placement}
        onHover={suggestions.setActiveIndex}
        onPick={(item) => {
          const next = suggestions.pick(item)
          if (next) applyPick(next)
        }}
      />
    ) : null
  const host = popoverHost?.current

  const input = (
    <input
      ref={inputRef}
      data-testid="query-box"
      className={
        variant === "page"
          ? searchField({ trailing: Boolean(value) })
          : "w-full bg-transparent px-5 py-4 text-lg leading-none outline-hidden placeholder:text-text-tertiary"
      }
      // The page's box is a search field (the browser clears it on Esc); the
      // palette's is plain text, since Esc is the palette's own there.
      type={variant === "page" ? "search" : "text"}
      value={shown.text}
      placeholder={placeholder}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      onChange={(event) => {
        changeLine(event.target.value, event.target.selectionStart ?? event.target.value.length)
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={(event) => {
        syncCaret()
        onKeyUp?.(event)
      }}
      onClick={(event) => {
        syncCaret()
        onClick?.(event)
      }}
      onFocus={(event) => {
        setFocused(true)
        syncCaret()
        onFocus?.(event)
      }}
      onBlur={(event) => {
        setFocused(false)
        onBlur?.(event)
      }}
      {...props}
    />
  )

  if (variant === "palette") {
    return (
      <div data-testid="query-box-root" data-variant="palette">
        <div ref={wrapperRef} className="relative">
          {input}
          {host ? createPortal(popover, host) : popover}
        </div>
        {pills ? (
          <div className="border-t border-border-secondary px-[14px] py-2">{pills}</div>
        ) : null}
      </div>
    )
  }
  return (
    <div data-testid="query-box-root" data-variant="page" className="flex flex-col gap-3">
      <div ref={wrapperRef} className="relative w-full">
        <div className="absolute inset-y-0 left-0 grid aspect-square place-items-center text-text-secondary">
          <SearchIcon16 />
        </div>
        {input}
        {shortcut && !value ? (
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 flex items-center pr-3 coarse:hidden"
          >
            <Keys keys={shortcut} />
          </div>
        ) : null}
        {value ? (
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 grid aspect-square place-items-center"
          >
            <IconButton aria-label="Clear" tabIndex={-1} onClick={clear}>
              <ClearIcon16 />
            </IconButton>
          </div>
        ) : null}
        {host ? createPortal(popover, host) : popover}
      </div>
      {pills}
    </div>
  )
}

/** Between the box's bottom edge and the popover. */
const POPOVER_GAP = 4
