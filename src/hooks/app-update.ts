import { atom, useAtomValue, useSetAtom } from "jotai"
import { useEffect, useRef } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useRegisterSW } from "virtual:pwa-register/react"
import { markUpdateRequested } from "../utils/whats-new"
import { requestDatabaseFlush } from "../data/database-mode"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"

/**
 * Whether a newer build of the app is waiting, and how to switch to it.
 *
 * The service worker is registered exactly once, by the always-mounted app
 * layout (`useRegisterAppUpdate`), and the answer lives in an atom so any
 * surface can show it — the sidebar's "Update Ruminate" item on wide screens
 * and the badge on the phone nav bar's menu button, which is on screen when
 * the drawer holding the sidebar items is not.
 */
export const appUpdateAtom = atom<{ needRefresh: boolean; apply: () => Promise<void> }>({
  needRefresh: false,
  apply: () => {
    window.location.reload()
    return NEVER
  },
})

/**
 * Applying an update ends in a reload, so on this page it never settles: the
 * control that applied it stays busy until the page is torn down.
 */
const NEVER = new Promise<void>(() => {})

/** Register the service worker and publish its "update waiting" state. Call
 * once, from a component that stays mounted for the app's whole life. */
export function useRegisterAppUpdate() {
  const setAppUpdate = useSetAtom(appUpdateAtom)
  // Reference: https://vite-pwa-org.netlify.app/frameworks/react.html#prompt-for-update
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration) {
      console.log("SW registered: " + registration)

      if (registration) {
        // Check for updates every hour
        setInterval(
          () => {
            registration.update()
          },
          60 * 60 * 1000,
        )
      }
    },
    onRegisterError(error) {
      console.error("SW registration error", error)
    },
  })
  const update = useRef(updateServiceWorker)
  update.current = updateServiceWorker

  useEffect(() => {
    setAppUpdate({
      needRefresh,
      apply: () => {
        // Remember that this was asked for, so the boot on the other side of
        // the reload knows to say what changed
        // (src/components/whats-new-popover.tsx).
        markUpdateRequested()
        // Apply the waiting service worker and reload to the new version.
        // Fall back to a hard reload if the worker never takes over (so the
        // button always refreshes the app).
        void update.current(true)
        window.setTimeout(() => window.location.reload(), 3000)
        return NEVER
      },
    })
  }, [needRefresh, setAppUpdate])
}

/**
 * ⌘⇧U takes a waiting update — the keyboard's version of the sidebar's
 * "Update Ruminate" item, mounted once beside {@link useRegisterAppUpdate}.
 *
 * With nothing waiting it does nothing, exactly as that item is only on screen
 * when there is something to take. Applying reloads the page and ops are
 * written behind, so the pending ones are landed first (as ⌘S does) rather
 * than letting a mistyped chord carry unsynced edits away with the old copy.
 */
export function useApplyUpdateShortcut() {
  const { needRefresh, apply } = useAtomValue(appUpdateAtom)

  useHotkeys(
    APP_SHORTCUTS.applyUpdate,
    () => {
      if (!needRefresh) return
      void requestDatabaseFlush().then(apply)
    },
    GLOBAL_HOTKEY_OPTIONS,
    [needRefresh, apply],
  )
}
