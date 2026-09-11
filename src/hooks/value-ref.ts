import React from "react"

/**
 * Returns a ref that always has the latest value of the given value.
 * Use this when you want to access the latest value of a value that changes,
 * without having to include the value directly in the dependency array of a hook.
 * Note: The ref still needs to be included in the dependency array, but since the ref object is stable,
 * it won't cause the hook to rerun when the underlying value changes.
 */
export function useValueRef<T>(value: T) {
  const valueRef = React.useRef(value)
  // A layout effect, not a passive one: the ref is read by native listeners
  // (a keydown on the search box, say) that can fire before React flushes
  // passive effects, and a stale handler there drops the keystroke.
  React.useLayoutEffect(() => {
    valueRef.current = value
  }, [value])
  return valueRef
}
