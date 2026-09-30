import { Link, createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { BoardFilters } from "../components/boards/board-filters"
import { BoardInspector } from "../components/boards/board-inspector"
import { BoardPicture, type BoardImage } from "../components/boards/board-picture"
import { Button } from "../components/ui/button"
import { IconButton } from "../components/ui/icon-button"
import { GridIcon16, NoteIcon16 } from "../components/icons"
import { Notice } from "../components/notice"
import { PageLayout } from "../components/page-layout"
import type { BoardFeatureState } from "../data/boards"
import { useFeature } from "../data/features"
import { parentIdsOf, parseProps } from "../data/graph"
import { imageFilesOf } from "../data/images"
import { graphSnapshotAtom } from "../global-state"
import { useBoard, useBoardMatches, useBoardWrites } from "../hooks/board"
import { useNoteById } from "../hooks/note"
import { cx } from "../utils/cx"

/**
 * A note as a board (docs/boards.md): its pictures as a wall of tiles, a
 * form to caption and tag the one you pick, and menus to narrow the wall by
 * what has been set. Everything on screen is the note's own graph — the
 * same rows the outline shows — read and written through the same seams.
 */

type RouteSearch = {
  /** The chosen values narrowing the wall: value block ids, comma-joined. */
  values?: string
  /** Words matched against captions. */
  q?: string
}

export const Route = createFileRoute("/_appRoot/boards/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => ({
    values: typeof search.values === "string" && search.values !== "" ? search.values : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { _splat: boardId = "" } = Route.useParams()
  const enabled = useFeature("boards")
  if (!enabled) {
    return (
      <PageLayout title="Board" icon={<GridIcon16 />}>
        <div className="p-4">
          <Notice>Boards aren’t switched on for this account.</Notice>
        </div>
      </PageLayout>
    )
  }
  return <BoardPage key={boardId} boardId={boardId} />
}

const NO_IDS: string[] = []

function BoardPage({ boardId }: { boardId: string }) {
  const { values: valuesParam, q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const note = useNoteById(boardId)
  const snapshot = useAtomValue(graphSnapshotAtom)
  const { exists, features, imageIds } = useBoard(boardId)
  const writes = useBoardWrites(boardId)

  // The narrowing lives in the URL, so a narrowed board is a link and the
  // back button widens it again.
  const valueIds = React.useMemo(
    () => (valuesParam ? valuesParam.split(",").filter(Boolean) : NO_IDS),
    [valuesParam],
  )
  const text = q ?? ""
  const setNarrowing = React.useCallback(
    (patch: { values?: string[]; q?: string }) => {
      void navigate({
        search: (prev) => ({
          values:
            patch.values !== undefined
              ? patch.values.length
                ? patch.values.join(",")
                : undefined
              : prev.values,
          q: patch.q !== undefined ? patch.q || undefined : prev.q,
        }),
        replace: true,
      })
    },
    [navigate],
  )
  // The chosen value of each feature: the id in the URL that is one of its
  // values. A value that has since gone narrows nothing.
  const active = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const state of features) {
      const chosen = state.values.find((value) => valueIds.includes(value.id))
      if (chosen) map.set(state.feature.label, chosen.id)
    }
    return map
  }, [features, valueIds])
  const pick = (state: BoardFeatureState, valueId: string | null) => {
    const others = valueIds.filter((id) => !state.values.some((value) => value.id === id))
    setNarrowing({ values: valueId ? [...others, valueId] : others })
  }

  const matches = useBoardMatches(boardId, imageIds, valueIds, text)
  const shown = matches ?? imageIds
  const images = React.useMemo<BoardImage[]>(
    () =>
      shown.flatMap((id) => {
        const node = snapshot.nodes.get(id)
        return node ? [{ id, text: node.text, props: parseProps(node.props) }] : []
      }),
    [shown, snapshot],
  )
  // How many of the board's pictures carry each value.
  const counts = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const id of imageIds) {
      for (const parent of parentIdsOf(snapshot, id)) map.set(parent, (map.get(parent) ?? 0) + 1)
    }
    return map
  }, [imageIds, snapshot])

  // The picked picture, while it is still on the board.
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = React.useMemo(
    () => (selectedId ? images.find((image) => image.id === selectedId) : undefined),
    [images, selectedId],
  )
  React.useEffect(() => {
    if (selectedId && !imageIds.includes(selectedId)) setSelectedId(null)
  }, [selectedId, imageIds])

  // Adding pictures: the button's file picker, a drop anywhere on the page,
  // or a paste while nothing else is taking the keys.
  const fileInputRef = React.useRef<HTMLInputElement>(null)
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

  const narrowed = matches !== null

  return (
    <PageLayout
      title={<span className="truncate">{note?.displayName || "Untitled"}</span>}
      icon={<GridIcon16 />}
      actions={
        <div className="flex items-center gap-2">
          <Button
            size="small"
            disabled={!writes.canUpload}
            title={writes.canUpload ? undefined : "Sign in to add images"}
            onClick={() => fileInputRef.current?.click()}
          >
            Add images
          </Button>
          <IconButton
            aria-label="Open as note"
            size="small"
            onClick={() =>
              navigate({
                to: "/views/$",
                params: { _splat: boardId },
                search: { query: undefined },
              })
            }
          >
            <NoteIcon16 />
          </IconButton>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="board-file-input"
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []))
              event.currentTarget.value = ""
            }}
          />
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
            There is no note here yet.{" "}
            <Link
              to="/views/$"
              params={{ _splat: boardId }}
              search={{ query: undefined }}
              className="link"
            >
              Open it as a note
            </Link>{" "}
            to start it.
          </Notice>
        ) : null}
        <BoardFilters
          features={features}
          active={active}
          counts={counts}
          text={text}
          onText={(value) => setNarrowing({ q: value })}
          onPick={pick}
          onClear={() => setNarrowing({ values: [], q: "" })}
        />
        {selected ? (
          <BoardInspector
            key={selected.id}
            image={selected}
            features={features}
            writes={writes}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
        {images.length === 0 ? (
          <p className="py-12 text-center text-text-secondary">
            {narrowed
              ? "Nothing on the board matches."
              : imageIds.length === 0
                ? "No pictures yet. Add images, or paste one into the note."
                : "Loading…"}
          </p>
        ) : (
          <ul
            data-testid="board-grid"
            className="grid list-none grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-0"
          >
            {images.map((image) => {
              const caption = image.text.trim()
              return (
                <li key={image.id} className="min-w-0">
                  <button
                    type="button"
                    aria-label={caption || "Picture"}
                    aria-pressed={image.id === selectedId}
                    onClick={() => setSelectedId(image.id === selectedId ? null : image.id)}
                    className={cx(
                      "focus-ring group relative block aspect-square w-full overflow-hidden rounded-lg bg-bg-secondary",
                      image.id === selectedId && "ring-2 ring-border-selected",
                    )}
                  >
                    <BoardPicture image={image} fit="cover" className="h-full w-full" />
                    {caption ? (
                      <span className="absolute inset-x-0 bottom-0 truncate bg-bg-overlay-backdrop px-2 py-1 text-left text-sm text-text">
                        {caption}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </PageLayout>
  )
}
