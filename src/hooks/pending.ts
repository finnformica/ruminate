import { useCallback, useEffect, useRef, useState } from "react"

/**
 * An action and whether it is in flight — for the control that starts it,
 * which shows the flight and refuses a second press until it has settled
 * (`loading` on Button and IconButton; docs/design-principles.md, "Busy
 * controls").
 *
 * `run` calls the action and holds `pending` until the promise it returns
 * settles, however it settles: the action's own error handling is its own.
 * A call while pending is dropped. An action that returns nothing is over
 * as soon as it returns. Settling after the component has gone sets nothing.
 */
export function usePending<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown> | void,
): [run: (...args: Args) => void, pending: boolean] {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const actionRef = useRef(action)
  actionRef.current = action
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback((...args: Args) => {
    if (pendingRef.current) return
    const result = actionRef.current(...args)
    if (!result) return
    pendingRef.current = true
    setPending(true)
    const settle = () => {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
    result.then(settle, settle)
  }, [])

  return [run, pending]
}
