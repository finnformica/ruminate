import { createFileRoute, redirect } from "@tanstack/react-router"

/** The admin page's old address: it is a settings page now
 * (feature flags, invites), so a bookmark of it still opens it. */
export const Route = createFileRoute("/_appRoot/admin")({
  loader: () => {
    throw redirect({ to: "/settings/$page", params: { page: "admin" }, replace: true })
  },
})
