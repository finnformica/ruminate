import { Searcher } from "fast-fuzzy"
import { useAtomValue, useStore } from "jotai"
import React from "react"
import { toast } from "sonner"
import { blockId } from "../blocks/id"
import {
  addImageOps,
  boardFeatures,
  boardImageIds,
  carryingAll,
  clearValueOps,
  imageUploadedOps,
  inverseOps,
  isBoard,
  setCaptionOps,
  setValueOps,
  type BoardFeature,
  type BoardFeatureState,
  type BoardValue,
  type ValueRef,
} from "../data/boards"
import { requestDatabaseFlush } from "../data/database-mode"
import {
  ImageUploadError,
  beginPendingImage,
  imagesEnabled,
  primeImageObjectUrl,
  releasePendingImage,
  uploadImage,
} from "../data/images"
import { deleteBlockOps, type Op } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom, isDatabaseModeAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * A board (docs/boards.md) as the page draws it: whether the note is there,
 * its features as they stand, and its pictures in order. Derived from the
 * live graph, so an edit in the outline — or on another device — is on the
 * board at once.
 */
export function useBoard(boardId: NoteId): {
  exists: boolean
  features: BoardFeatureState[]
  imageIds: string[]
} {
  const snapshot = useAtomValue(graphSnapshotAtom)
  return React.useMemo(
    () => ({
      exists: isBoard(snapshot, boardId),
      features: boardFeatures(snapshot, boardId),
      imageIds: boardImageIds(snapshot, boardId),
    }),
    [snapshot, boardId],
  )
}

/**
 * The pictures a narrowing keeps, in the board's order. The chosen values
 * are tested on each picture's parents (`carryingAll`); the typed words are
 * fuzzy-matched against captions with the search engine's own matcher and
 * threshold — run over the board's pictures directly, because the corpus
 * index holds only what a note reaches, and an untagged picture in the
 * basket is on the board too. Null when nothing narrows, so the caller
 * shows the board whole.
 */
export function useBoardMatches(
  imageIds: readonly string[],
  valueIds: readonly string[],
  text: string,
): string[] | null {
  const snapshot = useAtomValue(graphSnapshotAtom)
  return React.useMemo(() => {
    const fuzzy = text.trim()
    if (valueIds.length === 0 && fuzzy === "") return null
    let kept = carryingAll(snapshot, imageIds, valueIds)
    if (fuzzy !== "") {
      const captions = kept.map((id) => ({ id, text: snapshot.nodes.get(id)?.text ?? "" }))
      const searcher = new Searcher(captions, { keySelector: (item) => item.text, threshold: 0.8 })
      const matched = new Set(searcher.search(fuzzy).map((item) => item.id))
      kept = kept.filter((id) => matched.has(id))
    }
    return kept
  }, [snapshot, imageIds, valueIds, text])
}

/** What the board page may write, and how. */
export interface BoardWrites {
  /** Whether pictures can be added here: uploads are on, there is a store
   * to keep them (signed in), and a note to write them in. */
  canUpload: boolean
  addImages: (files: File[]) => Promise<void>
  setValue: (feature: BoardFeature, imageId: string, ref: ValueRef) => void
  clearValue: (feature: BoardFeature, value: BoardValue, imageId: string) => void
  setCaption: (imageId: string, caption: string) => void
  deleteImage: (imageId: string) => void
}

/**
 * The board's writes: each a batch through the one storage seam
 * (`useApplyOps`), as the editor's are. A form has no editor history behind
 * it, so a change to a picture's features is answered with a toast that can
 * undo it — the inverse batch, worked out against the graph as it stood.
 */
export function useBoardWrites(boardId: NoteId, exists: boolean): BoardWrites {
  const store = useStore()
  const apply = useApplyOps()
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const canUpload = imagesEnabled && isDatabaseMode && exists

  const undoable = React.useCallback(
    (ops: Op[], message: string) => {
      if (ops.length === 0) return
      const before = store.get(graphSnapshotAtom)
      const inverse = inverseOps(ops, before)
      apply(ops)
      void requestDatabaseFlush()
      toast(message, {
        action: inverse
          ? {
              label: "Undo",
              onClick: () => {
                apply(inverse)
                void requestDatabaseFlush()
              },
            }
          : undefined,
      })
    },
    [store, apply],
  )

  const setValue = React.useCallback(
    (feature: BoardFeature, imageId: string, ref: ValueRef) => {
      const snapshot = store.get(graphSnapshotAtom)
      const ops = setValueOps(snapshot, boardId, feature, imageId, ref)
      const text = "text" in ref ? ref.text.trim() : (snapshot.nodes.get(ref.id)?.text ?? "")
      undoable(ops, `${feature.label}: ${text}`)
    },
    [store, boardId, undoable],
  )

  const clearValue = React.useCallback(
    (feature: BoardFeature, value: BoardValue, imageId: string) => {
      const ops = clearValueOps(store.get(graphSnapshotAtom), value.id, imageId)
      undoable(ops, `${feature.label}: ${value.text} removed`)
    },
    [store, undoable],
  )

  const setCaption = React.useCallback(
    (imageId: string, caption: string) => {
      const ops = setCaptionOps(store.get(graphSnapshotAtom), imageId, caption)
      if (ops.length === 0) return
      apply(ops)
      void requestDatabaseFlush()
    },
    [store, apply],
  )

  const deleteImage = React.useCallback(
    (imageId: string) => {
      apply(deleteBlockOps(imageId, store.get(graphSnapshotAtom)))
      void requestDatabaseFlush()
      toast("Image deleted")
    },
    [store, apply],
  )

  /**
   * Pictures added from the board, the editor's way: every row is on the
   * page at once, drawing the file already in hand, and the uploads happen
   * behind it one at a time. The asset id is written when it lands; a
   * failed upload takes its row back out and says why.
   */
  const addImages = React.useCallback(
    async (files: File[]) => {
      if (!canUpload) return
      const queued: { id: string; file: File }[] = []
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue
        const id = blockId()
        apply(addImageOps(store.get(graphSnapshotAtom), boardId, id))
        beginPendingImage(id, file)
        queued.push({ id, file })
      }
      for (const { id, file } of queued) {
        try {
          const asset = await uploadImage(file)
          primeImageObjectUrl(asset.id, file)
          apply(imageUploadedOps(id, asset))
        } catch (error) {
          apply(deleteBlockOps(id, store.get(graphSnapshotAtom)))
          toast.error(error instanceof ImageUploadError ? error.message : "Image upload failed")
        } finally {
          releasePendingImage(id)
        }
      }
      if (queued.length > 0) void requestDatabaseFlush()
    },
    [canUpload, store, apply, boardId],
  )

  return React.useMemo(
    () => ({ canUpload, addImages, setValue, clearValue, setCaption, deleteImage }),
    [canUpload, addImages, setValue, clearValue, setCaption, deleteImage],
  )
}
