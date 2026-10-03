import { Searcher } from "fast-fuzzy"
import { useAtomValue, useStore } from "jotai"
import React from "react"
import { toast } from "sonner"
import { blockId } from "../blocks/id"
import {
  addImageOps,
  boardFeatures,
  boardImageIds,
  clearValueOps,
  imageUploadedOps,
  inverseOps,
  isBoard,
  outlineImageIds,
  setCaptionOps,
  suggestionOps,
  tagFeaturesOf,
  unassignedImageIds,
  setValueOps,
  type BoardFeature,
  type BoardFeatureState,
  type BoardValue,
  type ValueRef,
} from "../data/boards"
import { refreshAnthropicKey, useAnthropicKey } from "../data/anthropic-key"
import { requestDatabaseFlush } from "../data/database-mode"
import {
  ImageUploadError,
  beginPendingImage,
  imagesEnabled,
  primeImageObjectUrl,
  releasePendingImage,
  uploadImage,
} from "../data/images"
import { parseProps } from "../data/graph"
import { deleteBlockOps, type Op } from "../data/ops"
import { useApplyOps } from "../data/store"
import { requestTagSuggestion, SuggestTagsError } from "../data/suggest-tags"
import { blockIndexAtom, graphSnapshotAtom, isDatabaseModeAtom } from "../global-state"
import type { NoteId } from "../schema"
import { viewNarrowing } from "../utils/view-narrowing"

/**
 * A board (docs/boards.md) as the page draws it: whether the note is there,
 * its features as they stand, and its pictures — the ones the outline
 * reaches, in document order, and the ones in the note's Unassigned basket,
 * apart, as the note page draws the basket beneath the outline. Derived
 * from the live graph, so an edit in the outline — or on another device —
 * is on the board at once.
 */
export function useBoard(boardId: NoteId): {
  exists: boolean
  features: BoardFeatureState[]
  /** The pictures the outline reaches, in document order. */
  outlineIds: string[]
  /** The basket's pictures, most recently changed first. */
  basketIds: string[]
  /** Both, once each: the outline's, then the basket's. */
  imageIds: string[]
} {
  const snapshot = useAtomValue(graphSnapshotAtom)
  return React.useMemo(
    () => ({
      exists: isBoard(snapshot, boardId),
      features: boardFeatures(snapshot, boardId),
      outlineIds: outlineImageIds(snapshot, boardId),
      basketIds: unassignedImageIds(snapshot, boardId),
      imageIds: boardImageIds(snapshot, boardId),
    }),
    [snapshot, boardId],
  )
}

/**
 * The outline's pictures as the note's Filter and Sort leave them: the
 * filter is a query-language string and the sort a comparator, both
 * resolved through the search engine exactly as the note page resolves
 * them (`viewNarrowing`, src/utils/view-narrowing.ts), so `parent:<value>`
 * narrows the wall as it narrows the outline and `text:desc` orders it as
 * it orders the rows. The basket's pictures are not here: the index holds
 * what a note reaches, and the note page draws its basket whole beneath a
 * narrowed outline, so the board does the same.
 */
export function useBoardNarrowing(
  boardId: NoteId,
  filter: string,
  sort: string,
  outlineIds: readonly string[],
): string[] {
  const index = useAtomValue(blockIndexAtom)
  return React.useMemo(() => {
    const { matched, compare } = viewNarrowing({ filter, sort, noteId: boardId, index })
    const kept = matched ? outlineIds.filter((id) => matched.has(id)) : [...outlineIds]
    // `sort` is stable, so rows the comparator ties keep the note's order.
    return compare ? kept.sort(compare) : kept
  }, [index, boardId, filter, sort, outlineIds])
}

/**
 * The pictures whose caption the typed words match, in the order given —
 * fuzzy-matched with the search engine's own matcher and threshold, run
 * over the board's pictures directly, because the corpus index holds only
 * what a note reaches and an untagged picture in the basket is on the
 * board too. Null when nothing is typed, so the caller shows them all.
 */
export function useBoardMatches(imageIds: readonly string[], text: string): string[] | null {
  const snapshot = useAtomValue(graphSnapshotAtom)
  return React.useMemo(() => {
    const fuzzy = text.trim()
    if (fuzzy === "") return null
    const captions = imageIds.map((id) => ({ id, text: snapshot.nodes.get(id)?.text ?? "" }))
    const searcher = new Searcher(captions, { keySelector: (item) => item.text, threshold: 0.8 })
    const matched = new Set(searcher.search(fuzzy).map((item) => item.id))
    return imageIds.filter((id) => matched.has(id))
  }, [snapshot, imageIds, text])
}

/** What the board page may write, and how. */
export interface BoardWrites {
  /** Whether pictures can be added here: uploads are on, there is a store
   * to keep them (signed in), and a note to write them in. */
  canUpload: boolean
  /** Writes a row for each picture and hands back their ids at once, in
   * the order given; the uploads go on behind. Empty when nothing could
   * be added. */
  addImages: (files: File[]) => string[]
  setValue: (feature: BoardFeature, imageId: string, ref: ValueRef) => void
  clearValue: (feature: BoardFeature, value: BoardValue, imageId: string) => void
  setCaption: (imageId: string, caption: string) => void
  deleteImage: (imageId: string) => void
  /** Whether Claude can be asked to tag a picture here: there is a store
   * (signed in), and the account has an API key kept (docs/boards.md,
   * "Tagging with Claude"). */
  canSuggest: boolean
  /** Ask Claude for a caption and tags for a picture, and apply what it
   * says as one undoable batch. Settles when the toast has been shown. */
  suggestTags: (imageId: string) => Promise<void>
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

  // Tagging with Claude: signed in, with a key kept. Whether one is kept is
  // asked for the first time a board needs to know.
  const anthropicKey = useAnthropicKey()
  React.useEffect(() => {
    if (isDatabaseMode && anthropicKey === null) void refreshAnthropicKey()
  }, [isDatabaseMode, anthropicKey])
  const canSuggest = isDatabaseMode && exists && anthropicKey?.set === true

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
   * Claude's caption and tags for a picture: the board's features as they
   * stand go with the asset's id; the answer is read into the writes it
   * amounts to (`suggestionOps` — filling in, never overriding) and applied
   * as one batch with one Undo. A picture without an uploaded asset (an
   * external one, or one still on its way up) cannot be sent.
   */
  const suggestTags = React.useCallback(
    async (imageId: string) => {
      if (!canSuggest) return
      const snapshot = store.get(graphSnapshotAtom)
      const asset = parseProps(snapshot.nodes.get(imageId)?.props ?? null)?.image
      if (typeof asset !== "string") {
        toast.error("Only uploaded pictures can be tagged.")
        return
      }
      try {
        const suggestion = await requestTagSuggestion(asset, tagFeaturesOf(snapshot, boardId))
        const { ops, summary } = suggestionOps(
          store.get(graphSnapshotAtom),
          boardId,
          imageId,
          suggestion,
          Date.now(),
        )
        if (ops.length === 0) {
          toast("Nothing to add.")
          return
        }
        undoable(ops, summary.join(" · "))
      } catch (error) {
        toast.error(error instanceof SuggestTagsError ? error.message : "Couldn’t suggest tags.")
      }
    },
    [canSuggest, store, boardId, undoable],
  )

  /**
   * Pictures added from the board, the editor's way: every row is on the
   * page at once, drawing the file already in hand, and the uploads happen
   * behind it one at a time. The ids are handed back as soon as the rows
   * are written, so the page can open the first picture in its window
   * while its bytes are still going up — the caption and the features are
   * the row's own and take at once, and the asset id joins them when it
   * lands. A failed upload takes its row back out and says why.
   */
  const addImages = React.useCallback(
    (files: File[]): string[] => {
      if (!canUpload) return []
      const queued: { id: string; file: File }[] = []
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue
        const id = blockId()
        // The preview is registered before the row is written, so the
        // first paint of the row already has the file to draw.
        beginPendingImage(id, file)
        apply(addImageOps(store.get(graphSnapshotAtom), boardId, id))
        queued.push({ id, file })
      }
      if (queued.length === 0) return []
      void (async () => {
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
        void requestDatabaseFlush()
      })()
      return queued.map(({ id }) => id)
    },
    [canUpload, store, apply, boardId],
  )

  return React.useMemo(
    () => ({
      canUpload,
      addImages,
      setValue,
      clearValue,
      setCaption,
      deleteImage,
      canSuggest,
      suggestTags,
    }),
    [canUpload, addImages, setValue, clearValue, setCaption, deleteImage, canSuggest, suggestTags],
  )
}
