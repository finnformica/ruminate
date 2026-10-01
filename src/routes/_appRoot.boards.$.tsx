import { Link, createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { BoardInspector } from "../components/boards/board-inspector"
import { type BoardImage } from "../components/boards/board-picture"
import { BoardToolbar } from "../components/boards/board-toolbar"
import { BoardWall } from "../components/boards/board-wall"
import { BoardIcon16 } from "../components/icons"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { Notice } from "../components/notice"
import { PageLayout } from "../components/page-layout"
import { listHeading } from "../components/ui/list"
import { FilterMenu, SortMenu, type FilterBranch } from "../components/view-controls"
import { useFeature } from "../data/features"
import { parentIdsOf, parseProps } from "../data/graph"
import { imageFilesOf } from "../data/images"
import { graphSnapshotAtom } from "../global-state"
import { useBoard, useBoardMatches, useBoardNarrowing, useBoardWrites } from "../hooks/board"
import { useNoteById } from "../hooks/note"
import { useSavedView, useWriteView } from "../hooks/views"
import { narrowingParam, resolveNarrowing } from "../utils/view-filter"

/**
 * A board (docs/boards.md): a note whose page carries the `board` property,
 * shown as a wall of its pictures, with a window to caption and tag the one
 * you pick. Its header is the note's own — Sort, Filter and the ⋯ menu —
 * and the Filter leads with the board's features, so narrowing the wall is
 * narrowing the note, by the same filter string, resolved the same way.
 * Everything on screen is the note's own graph — the same rows its outline
 * shows — read and written through the same seams. A note without the
 * property is refused: it is opened as a note.
 */

type RouteSearch = {
  /** The view's filter and sort, as on the note page: absent means the
   * saved default, empty means explicitly none (`resolveNarrowing`). */
  filter?: string
  sort?: string
  /** Words matched against captions. */
  q?: string
}

export const Route = createFileRoute("/_appRoot/boards/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => ({
    filter: typeof search.filter === "string" ? search.filter : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { _splat: boardId = "" } = Route.useParams()
  const enabled = useFeature("boards")
  if (!enabled) {
    return (
      <PageLayout title="Board" icon={<BoardIcon16 />}>
        <div className="p-4">
          <Notice>Boards aren’t switched on for this account.</Notice>
        </div>
      </PageLayout>
    )
  }
  return <BoardPage key={boardId} boardId={boardId} />
}

function BoardPage({ boardId }: { boardId: string }) {
  const { filter: filterParam, sort: sortParam, q } = Route.useSearch()
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
  const text = q ?? ""
  const setNarrowing = React.useCallback(
    (patch: { filter?: string; sort?: string; q?: string }) => {
      void navigate({
        search: (prev) => ({
          ...prev,
          ...("filter" in patch
            ? { filter: narrowingParam(patch.filter ?? "", savedView.filter) }
            : {}),
          ...("sort" in patch ? { sort: narrowingParam(patch.sort ?? "", savedView.sort) } : {}),
          ...("q" in patch ? { q: patch.q || undefined } : {}),
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
  // be; the basket's whole beneath them, as the note page draws the basket;
  // the typed words over both.
  const narrowedOutline = useBoardNarrowing(boardId, filter, sort, outlineIds)
  const outlineMatches = useBoardMatches(narrowedOutline, text)
  const basketMatches = useBoardMatches(basketIds, text)
  const toImages = React.useCallback(
    (ids: readonly string[]): BoardImage[] =>
      ids.flatMap((id) => {
        const node = snapshot.nodes.get(id)
        return node ? [{ id, text: node.text, props: parseProps(node.props) }] : []
      }),
    [snapshot],
  )
  const outlineImages = React.useMemo(
    () => toImages(outlineMatches ?? narrowedOutline),
    [toImages, outlineMatches, narrowedOutline],
  )
  const basketImages = React.useMemo(
    () => toImages(basketMatches ?? basketIds),
    [toImages, basketMatches, basketIds],
  )
  const narrowed = filter !== "" || text.trim() !== ""

  // The picked picture, while it is still on the board.
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = React.useMemo(
    () =>
      selectedId
        ? [...outlineImages, ...basketImages].find((image) => image.id === selectedId)
        : undefined,
    [outlineImages, basketImages, selectedId],
  )
  React.useEffect(() => {
    if (selectedId && !imageIds.includes(selectedId)) setSelectedId(null)
  }, [selectedId, imageIds])
  const close = React.useCallback(() => setSelectedId(null), [])

  // Adding pictures: the toolbar's picker, a drop anywhere on the page, or
  // a paste while nothing else is taking the keys.
  const addFiles = (files: File[]) => {
    if (files.length > 0) void writes.addImages(files)
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
          <NoteActionsMenu noteId={boardId} align="end" surface="board" />
        </div>
      }
    >
      <div
        className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
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
        <BoardToolbar
          text={text}
          onText={(value) => setNarrowing({ q: value })}
          canUpload={writes.canUpload}
          exists={exists}
          onFiles={addFiles}
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
              : "No pictures yet. Add images, or paste one into the note."}
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
