import { Link, createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { AddImages } from "../components/boards/add-images"
import { BoardFeaturesDialog } from "../components/boards/board-features-dialog"
import { BoardInspector } from "../components/boards/board-inspector"
import { BoardWall, type BoardImage } from "../components/boards/board-wall"
import { BoardIcon16 } from "../components/icons"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { Notice } from "../components/notice"
import { PageLayout } from "../components/page-layout"
import { listHeading } from "../components/ui/list"
import { FilterMenu, SortMenu, type FilterBranch } from "../components/view-controls"
import { parentIdsOf, parseProps } from "../data/graph"
import { imageFilesOf } from "../data/images"
import { graphSnapshotAtom } from "../global-state"
import { useBoard, useBoardMatches, useBoardNarrowing, useBoardWrites } from "../hooks/board"
import { useNoteById } from "../hooks/note"
import { useSavedView, useWriteView } from "../hooks/views"
import { filterText, narrowingParam, resolveNarrowing } from "../utils/view-filter"

/**
 * A board (docs/boards.md): a note whose page carries the `board` property,
 * shown as a wall of its pictures, with a window to caption and tag the one
 * you pick. Its header is the note's own — Sort, Filter and the ⋯ menu —
 * and the Filter leads with the board's features and takes the words to
 * match captions by, so narrowing the wall is narrowing the note, by the
 * same filter string, resolved the same way.
 * Everything on screen is the note's own graph — the same rows its outline
 * shows — read and written through the same seams. A note without the
 * property is refused: it is opened as a note.
 */

type RouteSearch = {
  /** The view's filter and sort, as on the note page: absent means the
   * saved default, empty means explicitly none (`resolveNarrowing`). */
  filter?: string
  sort?: string
}

export const Route = createFileRoute("/_appRoot/boards/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => ({
    filter: typeof search.filter === "string" ? search.filter : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { _splat: boardId = "" } = Route.useParams()
  return <BoardPage key={boardId} boardId={boardId} />
}

function BoardPage({ boardId }: { boardId: string }) {
  const { filter: filterParam, sort: sortParam } = Route.useSearch()
  const navigate = Route.useNavigate()
  const note = useNoteById(boardId)
  const snapshot = useAtomValue(graphSnapshotAtom)
  const { exists, features, outlineIds, basketIds, imageIds } = useBoard(boardId)
  const writes = useBoardWrites(boardId, exists)

  // The view's narrowing, exactly as the note page resolves it: the URL
  // where it speaks, else what the note saved as its default view — the
  // same row the outline opens with. Every narrowing is a link.
  const savedView = useSavedView(null, boardId)
  const filter = resolveNarrowing(filterParam, savedView.filter)
  const sort = resolveNarrowing(sortParam, savedView.sort)
  const setNarrowing = React.useCallback(
    (patch: { filter?: string; sort?: string }) => {
      void navigate({
        search: (prev) => ({
          ...prev,
          ...("filter" in patch
            ? { filter: narrowingParam(patch.filter ?? "", savedView.filter) }
            : {}),
          ...("sort" in patch ? { sort: narrowingParam(patch.sort ?? "", savedView.sort) } : {}),
        }),
        replace: true,
      })
    },
    [navigate, savedView],
  )
  // Saving the view is the note's own: one row on the note, both halves.
  const writeView = useWriteView()
  const saveDefaultView = React.useCallback(() => {
    writeView(boardId, { filter, sort })
    navigate({ search: (prev) => ({ ...prev, filter: undefined, sort: undefined }), replace: true })
  }, [boardId, filter, sort, writeView, navigate])
  const resetToDefaultView = React.useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, filter: undefined, sort: undefined }), replace: true })
  }, [navigate])
  const savedViewActions = React.useMemo(
    () => ({ onUpdateDefault: saveDefaultView, onResetDefault: resetToDefaultView }),
    [saveDefaultView, resetToDefaultView],
  )
  const filterDirty = savedView.writable && savedView.filter !== filter
  const sortDirty = savedView.writable && savedView.sort !== sort

  // The board's features as the Filter menu's first branches: each value a
  // parent to tick, with how many of the board's pictures carry it.
  const branches = React.useMemo<FilterBranch[]>(() => {
    const counts = new Map<string, number>()
    for (const id of imageIds) {
      for (const parent of parentIdsOf(snapshot, id))
        counts.set(parent, (counts.get(parent) ?? 0) + 1)
    }
    return features
      .filter((state) => state.values.length > 0)
      .map((state) => ({
        label: state.feature.label,
        values: state.values.map((value) => ({
          id: value.id,
          label: value.text.trim() || "Untitled",
          count: counts.get(value.id) ?? 0,
        })),
      }))
  }, [features, imageIds, snapshot])

  // The outline's pictures, narrowed and ordered as the note's view would
  // be — the filter's words included, matched by the engine over the
  // captions. The basket's beneath them, as the note page draws the basket:
  // its rows are in no index, so only the filter's words reach them, with
  // the same matcher, and an untagged picture is still found by what it
  // says.
  const narrowedOutline = useBoardNarrowing(boardId, filter, sort, outlineIds)
  const basketMatches = useBoardMatches(basketIds, filterText(filter))
  const toImages = React.useCallback(
    (ids: readonly string[]): BoardImage[] =>
      ids.flatMap((id) => {
        const node = snapshot.nodes.get(id)
        return node ? [{ id, text: node.text, props: parseProps(node.props) }] : []
      }),
    [snapshot],
  )
  const outlineImages = React.useMemo(() => toImages(narrowedOutline), [toImages, narrowedOutline])
  const basketImages = React.useMemo(
    () => toImages(basketMatches ?? basketIds),
    [toImages, basketMatches, basketIds],
  )
  const narrowed = filter !== ""

  // The picked picture, while it is still on the board. Read off the whole
  // board rather than the narrowed wall: a picture just added opens in the
  // window at once, and a filter that does not match its empty caption
  // yet must not keep it out.
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = React.useMemo(
    () => (selectedId && imageIds.includes(selectedId) ? toImages([selectedId])[0] : undefined),
    [toImages, imageIds, selectedId],
  )
  React.useEffect(() => {
    if (selectedId && !imageIds.includes(selectedId)) setSelectedId(null)
  }, [selectedId, imageIds])
  const close = React.useCallback(() => setSelectedId(null), [])

  // The Features editor, from the ⋯ menu (docs/boards.md, "Features").
  const [featuresOpen, setFeaturesOpen] = React.useState(false)

  // Adding pictures: the buttons' pickers, the camera, a drop anywhere on
  // the page, or a paste while nothing else is taking the keys. Whichever
  // way they came, the first new picture opens in the window straight
  // away, under its spinner, so it can be captioned and tagged while its
  // bytes are still going up.
  const addFiles = (files: File[], source?: "camera" | "photos") => {
    if (files.length === 0) return
    const [first] = writes.addImages(files, source)
    if (first) setSelectedId(first)
  }
  React.useEffect(() => {
    if (!writes.canUpload) return
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && target.closest("input, textarea, [contenteditable]")) return
      const files = imageFilesOf(event.clipboardData)
      if (files.length === 0) return
      event.preventDefault()
      addFiles(files)
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addFiles reads the latest writes
  }, [writes])

  return (
    <PageLayout
      title={<span className="truncate">{note?.displayName || "Untitled"}</span>}
      icon={<BoardIcon16 />}
      actions={
        <div className="flex items-center">
          <SortMenu
            sort={sort}
            onSortChange={(next) => setNarrowing({ sort: next })}
            saved={savedView.writable ? { ...savedViewActions, dirty: sortDirty } : undefined}
          />
          <FilterMenu
            filter={filter}
            onFilterChange={(next) => setNarrowing({ filter: next })}
            scope={boardId}
            branches={branches}
            saved={savedView.writable ? { ...savedViewActions, dirty: filterDirty } : undefined}
          />
          <NoteActionsMenu
            noteId={boardId}
            align="end"
            surface="board"
            onFeatures={exists ? () => setFeaturesOpen(true) : undefined}
          />
        </div>
      }
    >
      <div
        // One gap throughout: the buttons, the wall's tiles and the space
        // between them share it (`GAP` in board-wall.tsx).
        className="mx-auto flex w-full max-w-6xl flex-col gap-2 p-4"
        onDragOver={(event) => {
          if (writes.canUpload && event.dataTransfer.types.includes("Files")) {
            event.preventDefault()
          }
        }}
        onDrop={(event) => {
          const files = imageFilesOf(event.dataTransfer)
          if (files.length === 0 || !writes.canUpload) return
          event.preventDefault()
          addFiles(files)
        }}
      >
        {!exists ? (
          <Notice>
            {note ? (
              <>
                This note is not a board.{" "}
                <Link
                  to="/views/$"
                  params={{ _splat: boardId }}
                  search={{ query: undefined }}
                  className="link"
                >
                  Open it as a note
                </Link>
                , or make a new board from the header.
              </>
            ) : (
              <>There is no board here. Make one with New board in the header.</>
            )}
          </Notice>
        ) : null}
        <AddImages canUpload={writes.canUpload} exists={exists} onFiles={addFiles} />
        <BoardFeaturesDialog
          open={featuresOpen && exists}
          features={features}
          writes={writes}
          onClose={() => setFeaturesOpen(false)}
        />
        {selected ? (
          <BoardInspector
            key={selected.id}
            image={selected}
            features={features}
            writes={writes}
            onClose={close}
          />
        ) : null}
        {outlineImages.length === 0 && basketImages.length === 0 ? (
          <p className="py-12 text-center text-text-secondary">
            {narrowed
              ? "Nothing on the board matches."
              : "No pictures yet. Add some, or paste one into the note."}
          </p>
        ) : (
          <>
            {outlineImages.length > 0 ? (
              <BoardWall
                images={outlineImages}
                selectedId={selectedId}
                onPick={setSelectedId}
                label="Pictures"
              />
            ) : narrowed ? (
              <p className="py-6 text-center text-text-secondary">Nothing on the board matches.</p>
            ) : null}
            {basketImages.length > 0 ? (
              <>
                {/* The basket's pictures beneath the outline's, as the note
                    page draws its basket: a filter narrows the outline, not
                    the basket, whose rows the index does not hold. */}
                <h2 className={listHeading({ className: "-mx-3 mt-2" })}>
                  Unassigned ({basketImages.length})
                </h2>
                <BoardWall
                  images={basketImages}
                  selectedId={selectedId}
                  onPick={setSelectedId}
                  label="Unassigned"
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </PageLayout>
  )
}
