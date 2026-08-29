import { useAtomValue } from "jotai"
import React from "react"
import { useEvent, useNetworkState } from "react-use"
import { githubUserAtom } from "../global-state"
import { requestDatabasePull, startDatabaseMode, stopDatabaseMode } from "./database-mode"
import { storageEngineAtom } from "./storage-mirror"

/**
 * Mounts database-authoritative mode (see `database-mode.ts`). Rendered once
 * from the app root. Active exactly when the storage flag is "database" (the
 * default) AND the user is signed in — GitHub auth is still the identity for
 * the Worker API. Signed out, the machine's sample notes render as before.
 *
 * Cross-device pulls re-run on the same triggers the git machine synced on:
 * the app becoming visible again, and the browser coming back online. (Failed
 * pulls also self-retry on a timer inside `database-mode.ts`.)
 */
export function useDatabaseMode() {
  const engine = useAtomValue(storageEngineAtom)
  const githubUser = useAtomValue(githubUserAtom)
  const active = engine === "database" && githubUser !== null
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
