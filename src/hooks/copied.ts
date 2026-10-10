import copy from "copy-to-clipboard"
import { useCallback, useEffect, useRef, useState } from "react"

/** How long a copy button shows its tick before it goes back to the copy
 * icon. */
const COPIED_MS = 1500

/**
 * Copy text to the clipboard, and whether it was just copied — for a copy
 * button, which swaps its icon for a tick while `copied` holds rather than
 * raising a toast: the button itself is where the eye already is.
 */
export function useCopied(): [copyText: (text: string) => void, copied: boolean] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copyText = useCallback((text: string) => {
    copy(text)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }, [])
  return [copyText, copied]
}
