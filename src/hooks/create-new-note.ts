import { useLocation, useMatch, useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"
import { generateNoteId } from "../utils/note-id"
import { parseQuery } from "../utils/search"

function useTagsFromRoute() {
  const tags = new Set<string>()

  const tagMatch = useMatch({ from: "/_appRoot/tags_/$", shouldThrow: false })
  if (tagMatch?.params._splat) {
    tags.add(tagMatch.params._splat)
  }

  const location = useLocation()
  const query = location.search.query ?? ""
  const tagFilters = parseQuery(query).filters.filter((q) => q.key === "tag" && !q.exclude)

  tagFilters.forEach((filter) => {
    filter.values.forEach((tag) => tags.add(tag))
  })

  return Array.from(tags)
}

export function useCreateNewNote() {
  const navigate = useNavigate()
  const tags = useTagsFromRoute()

  return useCallback(() => {
    const noteId = generateNoteId()

    // A note created from a tag page or a tag-filtered list starts with
    // those tags (as page props, applied when the note is first saved).
    navigate({
      to: "/notes/$",
      params: { _splat: noteId },
      search: {
        query: undefined,
        tags: tags.length > 0 ? tags.join(",") : undefined,
      },
    })
  }, [navigate, tags])
}
