import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * The old address of a note. Notes are views now (docs/metadata.md), and
 * open at `/views/<id>` — but a link to `/notes/<id>` is in other people's
 * notes, browsers' bookmarks and the links copied before the move, so it
 * still opens the note, with everything the address said (a focused block,
 * a filter, a sort) carried across.
 */
export const Route = createFileRoute("/_appRoot/notes_/$")({
  validateSearch: (search: Record<string, unknown>) => search,
  loader: ({ params, location }) => {
    const search = location.search as Record<string, unknown>
    const text = (key: string) =>
      typeof search[key] === "string" ? (search[key] as string) : undefined
    throw redirect({
      to: "/views/$",
      params: { _splat: params._splat },
      search: {
        query: text("query"),
        block: text("block"),
        filter: text("filter"),
        sort: text("sort"),
      },
      replace: true,
    })
  },
})
