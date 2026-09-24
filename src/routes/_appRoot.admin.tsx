import { createFileRoute, redirect } from "@tanstack/react-router"

/** The admin page's old address: its cards are settings pages now
 * (Feature flags, Invites), so a bookmark of it opens the first. */
export const Route = createFileRoute("/_appRoot/admin")({
  loader: () => {
    throw redirect({ to: "/settings/features", replace: true })
  },
})
