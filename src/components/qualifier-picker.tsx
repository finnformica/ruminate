import React from "react"
import { useValueRef } from "../hooks/value-ref"
import { QualifierSuggestions, useQualifierSuggestions } from "./qualifier-suggestions"

/**
 * The qualifier picker for a plain search box (`SearchInput`): hangs the
 * suggestions under the input and listens to it directly for the caret and
 * the keys it owns, so the input component stays a dumb text box — this file
 * is what it lazy-loads when asked to suggest, and the only place it reaches
 * the corpus (through `useQualifierSuggestions`).
 *
 * The listeners are native and sit on the input itself, so they run before
 * React's handlers and the page's document-level list keys: a key the picker
 * consumes never reaches either.
 */
export default function QualifierPicker({
  inputRef,
  value,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement>
  /** The input's current text. */
  value: string
  /** Write a pick back to the input (text + where the caret goes). */
  onPick: (next: { value: string; caret: number }) => void
}) {
  const [caret, setCaret] = React.useState<number | null>(null)
  const [focused, setFocused] = React.useState(false)
  const suggestions = useQualifierSuggestions({ value, caret: focused ? caret : null })
  const handleKeyDown = useValueRef(suggestions.handleKeyDown)
  const pick = useValueRef(onPick)

  React.useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const sync = () => setCaret(input.selectionStart)
    const onFocus = () => {
      setFocused(true)
      sync()
    }
    const onBlur = () => setFocused(false)
    const onKeyDown = (event: KeyboardEvent) => {
      const handled = handleKeyDown.current(event)
      if (!handled) return
      event.stopPropagation()
      if (typeof handled === "object") {
        pick.current(handled)
        // The input is rewritten by React; no caret event follows, so the
        // picker takes the new position from the pick itself.
        setCaret(handled.caret)
      }
    }
    input.addEventListener("keydown", onKeyDown)
    input.addEventListener("keyup", sync)
    input.addEventListener("click", sync)
    input.addEventListener("input", sync)
    input.addEventListener("change", sync)
    input.addEventListener("focus", onFocus)
    input.addEventListener("blur", onBlur)
    // Mounted (lazily) with the box already focused: catch up.
    if (document.activeElement === input) onFocus()
    return () => {
      input.removeEventListener("keydown", onKeyDown)
      input.removeEventListener("keyup", sync)
      input.removeEventListener("click", sync)
      input.removeEventListener("input", sync)
      input.removeEventListener("change", sync)
      input.removeEventListener("focus", onFocus)
      input.removeEventListener("blur", onBlur)
    }
  }, [inputRef, handleKeyDown, pick])

  if (!suggestions.visible || !suggestions.trigger) return null
  return (
    <QualifierSuggestions
      variant="floating"
      trigger={suggestions.trigger}
      items={suggestions.items}
      activeIndex={suggestions.activeIndex}
      onHover={suggestions.setActiveIndex}
      onPick={(item) => {
        const next = suggestions.pick(item)
        if (!next) return
        onPick(next)
        setCaret(next.caret)
      }}
    />
  )
}
