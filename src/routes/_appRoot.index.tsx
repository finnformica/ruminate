import { createFileRoute, redirect } from "@tanstack/react-router"
import { CORPUS_ROOT_ID } from "../data/graph"

type RouteSearch = {
  query: string | undefined
}

/**
 * The home page is the Root frame (`src/data/root-frame.ts`): the list of
 * every note, at the base of every pane, and the one list of notes
 * (docs/removing-views.md). `query` is kept so every link made to `/` still
 * reads; it is not used.
 */
export const Route = createFileRoute("/_appRoot/")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => ({
    query: typeof search.query === "string" ? search.query : undefined,
  }),
  beforeLoad: () => {
    throw redirect({
      to: "/notes/$",
      params: { _splat: CORPUS_ROOT_ID },
      search: { query: undefined },
      replace: true,
    })
  },
})
