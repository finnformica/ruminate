import { useAtomValue, useSetAtom } from "jotai"
import React from "react"
import { useEvent, useNetworkState } from "react-use"
import { githubUserAtom, globalStateMachineAtom } from "../global-state"
import { sessionStatusAtom } from "../utils/github-session"
import { requestDatabasePull, startDatabaseMode, stopDatabaseMode } from "./database-mode"

/**
 * Mounts the database storage runtime (see `database-mode.ts`). Rendered once
 * from the app root. Active exactly when the user is signed in — GitHub auth
 * is the identity for the Worker API. Signed out, the machine's sample notes
 * render instead.
 *
 * Cross-device pulls re-run when the app becomes visible again, when the
 * window regains focus, and when the browser comes back online. (Failed pulls
 * also self-retry on a timer inside `database-mode.ts`.)
 *
 * A terminally expired GitHub session (the Worker's /github-refresh answered
 * 401 — the refresh token is dead) signs the machine out cleanly: the stale
 * localStorage user is cleared by the sign-out actions and the signed-out
 * screen says "session expired" (`sessionExpiredAtom`) instead of the
 * offline-database notice, which is reserved for genuine network failure.
 */
export function useDatabaseMode() {
  const githubUser = useAtomValue(githubUserAtom)
  const active = githubUser !== null
  const { online } = useNetworkState()
  const session = useAtomValue(sessionStatusAtom)
  const send = useSetAtom(globalStateMachineAtom)

  // The store is bound to the signed-in identity (stable GitHub id when the
  // session carries one; login otherwise) so a different account signing in
  // on this browser can never read the previous owner's local cache.
  const owner =
    githubUser === null
      ? null
      : githubUser.id !== undefined
        ? String(githubUser.id)
        : githubUser.login

  React.useEffect(() => {
    if (!active || owner === null) return
    startDatabaseMode({ owner })
    return () => stopDatabaseMode()
  }, [active, owner])

  React.useEffect(() => {
    if (session === "expired" && active) send({ type: "SIGN_OUT" })
  }, [session, active, send])

  useEvent("visibilitychange", () => {
    if (active && document.visibilityState === "visible" && online) {
      requestDatabasePull()
    }
  })

  useEvent("focus", () => {
    if (active && online) requestDatabasePull()
  })

  useEvent("online", () => {
    if (active) requestDatabasePull()
  })
}
