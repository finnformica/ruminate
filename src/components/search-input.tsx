import React from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useValueRef } from "../hooks/value-ref"
import { APP_SHORTCUTS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { IconButton } from "./icon-button"
import { ClearIcon16, SearchIcon16 } from "./icons"
import { Keys } from "./keys"

// Loaded only for boxes that take a query: the picker reads the corpus, which
// a plain filter box (the help panel's) has no business pulling in.
const QualifierPicker = React.lazy(() => import("./qualifier-picker"))

type SearchInputProps = Omit<React.ComponentPropsWithoutRef<"input">, "onChange"> & {
  shortcut?: string[]
  onChange?: (value: string) => void
  /**
   * Offer values for the query language's qualifiers as they are typed
   * (`type:`, `in:`, `tag:`, …) — for inputs that take a search query, not
   * a plain filter string.
   */
  suggest?: boolean
}

export function SearchInput({
  shortcut,
  placeholder = "Search…",
  value,
  onChange,
  suggest = false,
  ...props
}: SearchInputProps) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = React.useState(value || "")
  const inputValueRef = useValueRef(inputValue)

  // A pick from the qualifier picker moves the caret past the token; the DOM
  // is told after the render that writes the new value.
  const pendingCaret = React.useRef<number | null>(null)
  React.useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    const at = pendingCaret.current
    pendingCaret.current = null
    ref.current?.setSelectionRange(at, at)
  })
  const applyPick = React.useCallback(
    (next: { value: string; caret: number }) => {
      setInputValue(next.value)
      onChange?.(next.value)
      pendingCaret.current = next.caret
    },
    [onChange],
  )

  // When the caller shows the "/" hint, "/" also focuses the input — but never
  // while typing somewhere else (form tags stay disabled for this hotkey).
  useHotkeys(
    APP_SHORTCUTS.focusSearch,
    () => ref.current?.focus(),
    { preventDefault: true, enabled: Boolean(shortcut) },
    [shortcut],
  )

  React.useEffect(() => {
    if (value !== inputValueRef.current) {
      setInputValue(value || "")
    }
  }, [value, inputValueRef])

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const newValue = event.target.value
    setInputValue(newValue)
    onChange?.(newValue)
  }

  function clearInput() {
    setInputValue("")
    onChange?.("")
    ref.current?.focus()
  }

  return (
    <div className="relative w-full">
      <div className="absolute inset-y-0 left-0 grid aspect-square place-items-center text-text-secondary">
        <SearchIcon16 />
      </div>
      <input
        ref={ref}
        className={cx(
          "focus-ring h-10 w-full rounded-lg bg-bg-secondary pl-10 [-webkit-appearance:none] [font-variant-numeric:inherit] placeholder:text-text-secondary coarse:h-12 coarse:pl-11 [&:not(:focus-visible)]:hover:ring-1 [&:not(:focus-visible)]:hover:ring-inset [&:not(:focus-visible)]:hover:ring-border-secondary",
          value ? "pr-10 coarse:pr-12" : "pr-3 coarse:pr-4",
        )}
        type="search"
        value={inputValue}
        placeholder={placeholder}
        onChange={handleChange}
        {...props}
      />
      {suggest ? (
        <React.Suspense fallback={null}>
          <QualifierPicker inputRef={ref} value={String(inputValue)} onPick={applyPick} />
        </React.Suspense>
      ) : null}
      {shortcut && !inputValue ? (
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 flex items-center pr-3 coarse:hidden"
        >
          <Keys keys={shortcut} />
        </div>
      ) : null}
      {inputValue ? (
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 grid aspect-square place-items-center"
        >
          <IconButton aria-label="Clear" tabIndex={-1} onClick={clearInput}>
            <ClearIcon16 />
          </IconButton>
        </div>
      ) : null}
    </div>
  )
}
