import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { useMedia } from "react-use"
import { SettingsIndexList } from "../components/settings/settings-pages"
import { githubUserAtom } from "../global-state"

/**
 * `/settings` itself. On a phone, the list of pages; on a screen wide enough
 * for the column beside the page, straight to the first page — the account's
 * signed in, else the device's, since signed out there is no account to show.
 */
export const Route = createFileRoute("/_appRoot/settings/")({
  component: RouteComponent,
})

function RouteComponent() {
  const wide = useMedia("(min-width: 640px)")
  const githubUser = useAtomValue(githubUserAtom)
  if (wide) {
    return (
      <Navigate
        to="/settings/$page"
        params={{ page: githubUser ? "account" : "preferences" }}
        replace
      />
    )
  }
  return <SettingsIndexList />
}
