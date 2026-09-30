import React from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useValueRef } from "../hooks/value-ref"
import { APP_SHORTCUTS } from "../shortcuts/registry"
import { ClearIcon16, SearchIcon16 } from "./icons"
import { IconButton } from "./ui/icon-button"
import { Keys } from "./ui/keys"
import { SearchField } from "./ui/search-field"

type SearchInputProps = Omit<React.ComponentPropsWithoutRef<"input">, "onChange"> & {
  shortcut?: string[]
  onChange?: (value: string) => void
}

/**
 * A plain filter box (the help panel's): the search field's dress with
 * nothing of the query language in it. A box that takes a QUERY — with the
 * qualifier popover, the scopes and the hand-off to result rows — is
 * `QueryBox` (query-box.tsx).
 */
export function SearchInput({
  shortcut,
  placeholder = "Search…",
  value,
  onChange,
  ...props
}: SearchInputProps) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = React.useState(value || "")
  const inputValueRef = useValueRef(inputValue)

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
      <SearchField
        ref={ref}
        trailing={Boolean(value)}
        value={inputValue}
        placeholder={placeholder}
        onChange={handleChange}
        {...props}
      />
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
