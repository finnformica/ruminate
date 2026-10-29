import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * The old address of a note, and of a View. Views are gone
 * (docs/removing-views.md) and a note opens at `/notes/<id>`. A View's id
 * was always its root's id, so `/views/<id>` opens that root — a note, or a
 * block in its note — with everything the address said (a focused block,
 * the panes, a filter) carried across as it was written.
 */
export const Route = createFileRoute("/_appRoot/views_/$")({
  validateSearch: (search: Record<string, unknown>) => search,
  loader: ({ params, location }) => {
    throw redirect({
      to: "/notes/$",
      params: { _splat: params._splat },
      search: location.search as never,
      replace: true,
    })
  },
})
