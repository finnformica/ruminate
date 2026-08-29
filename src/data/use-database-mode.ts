import { useAtomValue } from "jotai"
import React from "react"
import { useEvent, useNetworkState } from "react-use"
import { githubUserAtom } from "../global-state"
import { requestDatabasePull, startDatabaseMode, stopDatabaseMode } from "./database-mode"

/**
 * Mounts the database storage runtime (see `database-mode.ts`). Rendered once
 * from the app root. Active exactly when the user is signed in — GitHub auth
 * is the identity for the Worker API. Signed out, the machine's sample notes
 * render instead.
 *
 * Cross-device pulls re-run when the app becomes visible again and when the
 * browser comes back online. (Failed pulls also self-retry on a timer inside
 * `database-mode.ts`.)
 */
export function useDatabaseMode() {
  const githubUser = useAtomValue(githubUserAtom)
  const active = githubUser !== null
  const { online } = useNetworkState()

  React.useEffect(() => {
    if (!active) return
    startDatabaseMode()
    return () => stopDatabaseMode()
  }, [active])

  useEvent("visibilitychange", () => {
    if (active && document.visibilityState === "visible" && online) {
      requestDatabasePull()
    }
  })

  useEvent("online", () => {
    if (active) requestDatabasePull()
  })
}
