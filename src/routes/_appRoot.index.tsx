import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { NoteIcon16 } from "../components/icons"
import { NoteList } from "../components/note-list"
import { PageLayout } from "../components/page-layout"

type RouteSearch = {
  query: string | undefined
}

export const Route = createFileRoute("/_appRoot/")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { query } = Route.useSearch()
  const navigate = Route.useNavigate()
  // The text as typed, held here so the box shows a keystroke the same
  // render; the URL follows (and leads on back/forward, or a link in).
  const [text, setText] = useState(query ?? "")
  useEffect(() => {
    setText(query ?? "")
  }, [query])

  return (
    <PageLayout title="Notes" icon={<NoteIcon16 />}>
      <div className="p-4 pt-0">
        <NoteList
          query={text}
          onQueryChange={(next) => {
            setText(next)
            navigate({ search: (prev) => ({ ...prev, query: next }), replace: true })
          }}
          enableKeyboardNav
        />
      </div>
    </PageLayout>
  )
}
