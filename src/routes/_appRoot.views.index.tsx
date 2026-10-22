import { createFileRoute, redirect } from "@tanstack/react-router"

/** `/views` is Root, by way of the home page (`_appRoot.index.tsx`). */
export const Route = createFileRoute("/_appRoot/views/")({
  loader: () => {
    throw redirect({ to: "/", search: { query: undefined } })
  },
})
