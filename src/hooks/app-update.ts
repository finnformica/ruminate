import { atom, useSetAtom } from "jotai"
import { useEffect, useRef } from "react"
import { useRegisterSW } from "virtual:pwa-register/react"

/**
 * Whether a newer build of the app is waiting, and how to switch to it.
 *
 * The service worker is registered exactly once, by the always-mounted app
 * layout (`useRegisterAppUpdate`), and the answer lives in an atom so any
 * surface can show it — the sidebar's "Update Ruminate" item on wide screens
 * and the badge on the phone nav bar's menu button, which is on screen when
 * the drawer holding the sidebar items is not.
 */
export const appUpdateAtom = atom<{ needRefresh: boolean; apply: () => void }>({
  needRefresh: false,
  apply: () => window.location.reload(),
})

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
        // Apply the waiting service worker and reload to the new version.
        // Fall back to a hard reload if the worker never takes over (so the
        // button always refreshes the app).
        void update.current(true)
        window.setTimeout(() => window.location.reload(), 3000)
      },
    })
  }, [needRefresh, setAppUpdate])
}
