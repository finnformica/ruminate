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
 *   typing guard, via {@link GChordMachine}. An *armed* chord's second key is
 *   additionally intercepted at capture phase so it wins over the block
 *   editor's own single-key select-mode bindings (w/a/s/d — a bare `d` there
 *   is "first child", but `g` then `d` must still reach the daily note).
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

    const chordKeyOf = (event: KeyboardEvent) => ({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isTyping: isTypingTarget(event.target),
      defaultPrevented: event.defaultPrevented,
    })

    // While the chord is armed, its second key must beat deeper handlers —
    // notably the block editor's select-mode w/a/s/d bindings, which would
    // otherwise consume a bare `d` (preventDefault) and dead-end `g d`. A
    // capture-phase listener fires before any bubble handler, so an armed
    // chord intercepts its key ahead of the editor; stopPropagation keeps the
    // editor from also acting on it. Disarmed, this does nothing and the
    // bubble listener below arms / ignores exactly as before.
    const handleCapture = (event: KeyboardEvent) => {
      if (!machine.isArmed) return
      if (machine.handleKey(chordKeyOf(event))) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

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

      if (machine.handleKey(chordKeyOf(event))) {
        event.preventDefault()
      }
    }

    document.addEventListener("keydown", handleCapture, true)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleCapture, true)
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
