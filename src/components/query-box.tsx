import React from "react"
import { createPortal } from "react-dom"
import { useHotkeys } from "react-hotkeys-hook"
import { APP_SHORTCUTS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { parseQuery, removeQualifier } from "../utils/search"
import { caretCoordinates } from "./block-editor/caret"
import { IconButton } from "./icon-button"
import { ClearIcon16, SearchIcon16 } from "./icons"
import { Keys } from "./keys"
import {
  QUALIFIER_POPOVER_WIDTH,
  QualifierPopover,
  useComboboxAria,
  useQualifierSuggestions,
  type QualifierPopoverPlacement,
} from "./qualifier-suggestions"
import { ScopePill } from "./scope-pill"

/**
 * **The query box** — the one search input, on the notes page and in the
 * ⌘K palette. It owns everything a query needs around its text: the caret
 * (read off the input on every change and move), the qualifier popover
 * (`type:`, `in:`, … — qualifier-suggestions.tsx) hung beside the token
 * being typed, the `in:` scopes as pills beneath it, and the hand-off of
 * the keyboard to the result rows on ↓ (`onHandOff`) and of the query on
 * ↵ (`onSubmit`). What differs between the two places is the dress
 * (`variant`) and what the surface does with a hand-off or a submit — never
 * the typing.
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
  impliedScope = null,
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
  /** A scope in force that is not in the text (the palette's automatic
   * `in:` of the open note), shown as a pill like a typed one. */
  impliedScope?: { value: string; onRemove: () => void } | null
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

  // The text is the caller's, as typed: the caller holds it in state of its
  // own and writes it back the same render (a caller that echoed it a
  // render late — through the URL, say — would reset the caret as it did).

  // The caret, and whether the box has focus: the popover follows the
  // caret while the box is focused and is gone the moment it is not.
  const [caret, setCaret] = React.useState<number | null>(null)
  const [focused, setFocused] = React.useState(false)
  const syncCaret = React.useCallback(
    () => setCaret(inputRef.current?.selectionStart ?? null),
    [inputRef],
  )
  const suggestions = useQualifierSuggestions({
    value,
    caret: focused ? caret : null,
    currentNoteId,
  })
  useComboboxAria(inputRef, suggestions)

  // A pick moves the caret past the token; the DOM is told after the render
  // that writes the new value (no caret event follows a value React set).
  const pendingCaret = React.useRef<number | null>(null)
  React.useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    const at = pendingCaret.current
    pendingCaret.current = null
    inputRef.current?.setSelectionRange(at, at)
  })
  const applyPick = (next: { value: string; caret: number }) => {
    onChange(next.value)
    setCaret(next.caret)
    pendingCaret.current = next.caret
  }

  // Where the popover hangs: under the box, at the token — measured in the
  // host's coordinates, since the host is what it is positioned in. A
  // narrow box or a touch screen gets it the box's full width instead.
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
      if (coarse || box.width < QUALIFIER_POPOVER_WIDTH * 1.5) {
        setPlacement({ top, left: box.left - frame.left, width: box.width, full: true })
        return
      }
      const { left } = caretCoordinates(input, tokenStart)
      const at = box.left - frame.left + left
      const first = box.left - frame.left
      const last = box.right - frame.left - QUALIFIER_POPOVER_WIDTH
      setPlacement({
        top,
        left: Math.max(first, Math.min(at, last)),
        width: QUALIFIER_POPOVER_WIDTH,
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
    onChange("")
    inputRef.current?.focus()
  }

  // The `in:` scopes in the text, as pills — plus the implied one, which is
  // in force without being typed.
  const scopes = React.useMemo(
    () => parseQuery(value).filters.filter((filter) => filter.key === "in"),
    [value],
  )
  const pills =
    scopes.length > 0 || impliedScope ? (
      <div data-testid="query-scopes" className="flex flex-wrap gap-2">
        {impliedScope ? (
          <ScopePill value={impliedScope.value} onRemove={impliedScope.onRemove} />
        ) : null}
        {scopes.flatMap((filter) =>
          filter.values.map((scope) => (
            <ScopePill
              key={`${filter.exclude ? "-" : ""}in:${scope}`}
              value={scope}
              exclude={filter.exclude}
              // The whole qualifier goes (a comma list as one).
              onRemove={() => onChange(removeQualifier(value, filter))}
            />
          )),
        )}
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
          ? cx(
              "focus-ring h-10 w-full rounded-lg bg-bg-secondary pl-10 [-webkit-appearance:none] [font-variant-numeric:inherit] placeholder:text-text-secondary coarse:h-12 coarse:pl-11 [&:not(:focus-visible)]:hover:ring-1 [&:not(:focus-visible)]:hover:ring-inset [&:not(:focus-visible)]:hover:ring-border-secondary",
              value ? "pr-10 coarse:pr-12" : "pr-3 coarse:pr-4",
            )
          : "w-full bg-transparent px-5 py-4 text-lg leading-none outline-hidden placeholder:text-text-tertiary"
      }
      // The page's box is a search field (the browser clears it on Esc); the
      // palette's is plain text, since Esc is the palette's own there.
      type={variant === "page" ? "search" : "text"}
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      onChange={(event) => {
        onChange(event.target.value)
        syncCaret()
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
