import { createFileRoute, redirect } from "@tanstack/react-router"

/** `/views` is the home page: the Views list lives at `/`. */
export const Route = createFileRoute("/_appRoot/views/")({
  loader: () => {
    throw redirect({ to: "/", search: { query: undefined } })
  },
})
