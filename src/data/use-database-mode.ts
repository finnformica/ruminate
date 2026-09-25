import { useAtomValue, useSetAtom } from "jotai"
import React from "react"
import { useEvent, useNetworkState } from "react-use"
import { githubUserAtom, signOutAtom } from "../global-state"
import { sessionStatusAtom } from "../utils/github-session"
import { requestAmbientDatabasePull, startDatabaseMode, stopDatabaseMode } from "./database-mode"
import { refreshFeatures, resetFeatures, seedFeatures } from "./features"
import { startImageCache, stopImageCache } from "./image-cache"
import { imagesEnabled, resetImageObjectUrls } from "./images"
import { refreshPreferences, resetPreferences } from "./account-preferences"
import { requestAmbientSharesRefresh, startSharedMode, stopSharedMode } from "./shared-mode"

/**
 * Mounts the database storage runtime (see `database-mode.ts`). Rendered once
 * from the app root. Active exactly when the user is signed in — GitHub auth
 * is the identity for the Worker API. Signed out, the sample notes render
 * instead.
 *
 * Cross-device pulls re-run when the app becomes visible again, when the
 * window regains focus, and when the browser comes back online — coalesced to
 * at most one pull per 30s, because those events fire in bursts and in pairs
 * and a pull is not free (`AMBIENT_PULL_INTERVAL_MS` in `database-mode.ts`).
 * (Failed pulls also self-retry on a timer inside `database-mode.ts`.)
 *
 * A terminally expired GitHub session (the Worker's /github-refresh answered
 * 401 — the refresh token is dead) signs out cleanly: the stale
 * localStorage user is cleared by the sign-out actions and the signed-out
 * screen says "session expired" (`sessionExpiredAtom`) instead of the
 * offline-database notice, which is reserved for genuine network failure.
 */
export function useDatabaseMode() {
  const githubUser = useAtomValue(githubUserAtom)
  const active = githubUser !== null
  const { online } = useNetworkState()
  const session = useAtomValue(sessionStatusAtom)
  const signOut = useSetAtom(signOutAtom)

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
    // The notes others shared with this identity ride alongside the user's
    // own corpus (src/data/shared-mode.ts) and stop with it.
    startSharedMode()
    // The feature flags for this account (src/data/features.ts): what the
    // Settings panels, the menus and the Admin link draw. The last answer
    // stands from the start — offline, that is all there is — and the
    // server's is fetched once per sign-in, again when the network returns.
    seedFeatures(owner)
    void refreshFeatures()
    // The account's preferences (src/data/account-preferences.ts): the
    // server's, once per sign-in and again when the network returns. Nothing
    // is kept on the device, so until it answers the defaults stand.
    void refreshPreferences()
    // The user's pictures, kept on the device for offline (image-cache.ts),
    // bound to the same identity as the store.
    if (imagesEnabled) startImageCache(owner)
    return () => {
      stopImageCache()
      resetImageObjectUrls()
      resetPreferences()
      resetFeatures()
      stopSharedMode()
      stopDatabaseMode()
    }
  }, [active, owner])

  React.useEffect(() => {
    if (session === "expired" && active) signOut()
  }, [session, active, signOut])

  // All three are AMBIENT: they fire on every alt-tab and window raise, and a
  // single tab switch raises `focus` and `visibilitychange` together. They go
  // through the coalescing entry point so a burst costs one pull, not one
  // each (see AMBIENT_PULL_INTERVAL_MS).
  useEvent("visibilitychange", () => {
    if (active && document.visibilityState === "visible" && online) {
      requestAmbientDatabasePull()
      requestAmbientSharesRefresh()
    }
  })

  useEvent("focus", () => {
    if (active && online) {
      requestAmbientDatabasePull()
      requestAmbientSharesRefresh()
    }
  })

  useEvent("online", () => {
    if (active) {
      requestAmbientDatabasePull()
      requestAmbientSharesRefresh()
      void refreshFeatures()
      void refreshPreferences()
    }
  })
}
