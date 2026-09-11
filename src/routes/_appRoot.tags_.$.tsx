import { createFileRoute } from "@tanstack/react-router"
import { DropdownMenu } from "../components/dropdown-menu"
import { IconButton } from "../components/icon-button"
import { EditIcon16, MoreIcon16, TagIcon16, TrashIcon16 } from "../components/icons"
import { NoteList } from "../components/note-list"
import { PageLayout } from "../components/page-layout"
import { useDeleteTag, useRenameTag } from "../hooks/tag"

type RouteSearch = {
  query: string | undefined
}

export const Route = createFileRoute("/_appRoot/tags_/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
    }
  },
  component: RouteComponent,
  head: ({ params }) => ({
    meta: [{ title: `#${params._splat} · Ruminate` }],
  }),
})

function RouteComponent() {
  const { _splat: tag } = Route.useParams()
  const { query } = Route.useSearch()
  const navigate = Route.useNavigate()
  const renameTag = useRenameTag()
  const deleteTag = useDeleteTag()

  return (
    <PageLayout
      title={tag}
      icon={<TagIcon16 />}
      actions={
        <DropdownMenu modal={false}>
          <DropdownMenu.Trigger
            render={
              <IconButton aria-label="More actions" size="small" disableTooltip>
                <MoreIcon16 />
              </IconButton>
            }
          />
          <DropdownMenu.Content align="end" side="top">
            <DropdownMenu.Item
              icon={<EditIcon16 />}
              onClick={() => {
                if (!tag) return

                const newName = window.prompt("Rename tag", tag)

                if (newName) {
                  renameTag(tag, newName)
                  navigate({
                    to: "/tags/$",
                    params: { _splat: newName },
                    search: { query },
                    replace: true,
                  })
                }
              }}
            >
              Rename tag
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              icon={<TrashIcon16 />}
              variant="danger"
              onClick={() => {
                if (!tag) return

                // Confirm deletion
                if (
                  window.confirm(
                    `Remove the "${tag}" tag from all notes?\nDon't worry—no notes will be deleted.`,
                  )
                ) {
                  deleteTag(tag)
                  navigate({
                    to: "/tags",
                    search: { query: undefined, sort: "name" },
                    replace: true,
                  })
                }
              }}
            >
              Delete tag
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      }
    >
      <div className="px-4 pt-0 pb-[50vh]">
        <NoteList
          key={tag}
          baseQuery={`tag:${tag}`}
          query={query ?? ""}
          onQueryChange={(query) =>
            navigate({
              search: (prev) => ({ ...prev, query }),
              replace: true,
            })
          }
        />
      </div>
    </PageLayout>
  )
}
