import { useNavigate, useRouter } from "@tanstack/react-router"
import { useSetAtom } from "jotai"
import { useEffect } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { isHelpPanelOpenAtom } from "../global-state"
import { toDateString } from "../utils/date"
import { GChordMachine } from "./chords"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "./registry"

/** True when the key event came from somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

/**
 * The app-level navigation vocabulary, mounted once (in `_appRoot`):
 *
 * - `?` toggles the shortcut reference (the help panel). Handled by a plain
 *   document listener rather than react-hotkeys-hook so the check is "not
 *   typing" instead of an enableOnFormTags carve-out — it must stay silent in
 *   any input or the block editor's edit-mode textarea, but fire from the
 *   editor's select mode (whose container leaves unbound keys un-prevented, so
 *   they bubble here).
 * - `g` chords (`g d` / `g n` / `g t` / `g s`) navigate — same listener, same
 *   typing guard, via {@link GChordMachine}.
 * - `⌘[` / `⌘]` walk the router history (needed in the PWA, where the browser
 *   chrome's back button doesn't exist).
 *
 * Every binding here is declared in the shortcut registry
 * (`src/shortcuts/registry.ts`).
 */
export function GlobalShortcuts() {
  const navigate = useNavigate()
  const router = useRouter()
  const setHelpPanel = useSetAtom(isHelpPanelOpenAtom)

  useEffect(() => {
    const machine = new GChordMachine({
      // "Today" is computed at press time, exactly as the sidebar's Calendar
      // nav item does (src/components/nav-items.tsx).
      d: () =>
        navigate({
          to: "/notes/$",
          params: { _splat: toDateString(new Date()) },
          search: { query: undefined },
        }),
      n: () => navigate({ to: "/", search: { query: undefined } }),
      t: () => navigate({ to: "/tags", search: { query: undefined, sort: "name" } }),
      s: () => navigate({ to: "/settings", search: { query: undefined } }),
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      const isTyping = isTypingTarget(event.target)

      // "?" — the key itself on any layout, or Shift+/ where Shift+/ reports
      // as "/" — opens the complete shortcut reference.
      const isQuestionMark = event.key === "?" || (event.key === "/" && event.shiftKey)
      if (
        isQuestionMark &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping &&
        !event.defaultPrevented
      ) {
        event.preventDefault()
        setHelpPanel((prev) => !prev)
        return
      }

      if (
        machine.handleKey({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isTyping,
          defaultPrevented: event.defaultPrevented,
        })
      ) {
        event.preventDefault()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      machine.disarm()
    }
  }, [navigate, setHelpPanel])

  useHotkeys(APP_SHORTCUTS.historyBack, () => router.history.back(), GLOBAL_HOTKEY_OPTIONS, [
    router,
  ])
  useHotkeys(APP_SHORTCUTS.historyForward, () => router.history.forward(), GLOBAL_HOTKEY_OPTIONS, [
    router,
  ])

  return null
}
