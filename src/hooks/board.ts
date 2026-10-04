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
  imageLocationOf,
  imageLocationOps,
  imageUploadedOps,
  type ImageLocation,
  inverseOps,
  isBoard,
  outlineImageIds,
  resetImageOps,
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
import { requestDatabaseFlush } from "../data/database-mode"
import { devicePosition } from "../data/device-position"
import { readExifLocation } from "../data/exif-location"
import { visionCopy } from "../data/image-fit"
import {
  ImageUploadError,
  beginPendingImage,
  imageBlob,
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
import { useAiAvailable } from "./ai"

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

/**
 * A failure's toast, with its detail a press away: **Copy** puts the lines
 * the person would otherwise have to describe — the code, the provider,
 * the log the call is under, what the model said — on the clipboard. It
 * stays up long enough to be read and pressed.
 */
function failedToast(message: string, detail: string): void {
  toast.error(message, { duration: 10000, action: copyControl(detail) })
}

/** A toast control that puts `detail` on the clipboard. */
const copyControl = (detail: string) => ({
  label: "Copy",
  onClick: () => void navigator.clipboard?.writeText(detail).catch(() => {}),
})

/** An error that is not the route's — the network, a decode — as lines:
 * what it says, and the first lines of where it came from. */
function describeError(error: unknown): string {
  const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 4) : []
  return [String(error), ...stack.slice(1)].join("\n")
}

/** What the board page may write, and how. */
export interface BoardWrites {
  /** Whether pictures can be added here: uploads are on, there is a store
   * to keep them (signed in), and a note to write them in. */
  canUpload: boolean
  /** Writes a row for each picture and hands back their ids at once, in
   * the order given; the uploads go on behind. Empty when nothing could
   * be added. */
  /** Add pictures; `source` says where they came from, which is where
   * their location comes from: the camera's from the device, a library's
   * from the picture's own metadata. Neither is required. */
  addImages: (files: File[], source?: "camera" | "photos") => string[]
  /** Give a picture a value, or take one off: the picker shows the result,
   * and nothing else is said. */
  setValue: (feature: BoardFeature, imageId: string, ref: ValueRef) => void
  clearValue: (value: BoardValue, imageId: string) => void
  /** Take the caption and every value off a picture, all features at once,
   * as one batch with a toast that can undo it. */
  resetImage: (imageId: string) => void
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

  // Tagging: whether a provider answers for this account is the one hook's
  // answer (src/hooks/ai.ts); which one, the Worker decides for itself by
  // the same router.
  const canSuggest = useAiAvailable().available && exists

  // A batch applied at once, the page showing the result — the editor's
  // own optimism, and no toast (docs/design-principles.md, Notices).
  const write = React.useCallback(
    (ops: Op[]) => {
      if (ops.length === 0) return
      apply(ops)
      void requestDatabaseFlush()
    },
    [apply],
  )

  // A change that takes several things off at once, or that a model made:
  // applied the same way, and answered with a plain toast whose job is the
  // way back — **Undo**, the inverse batch. A single pick or clear is not
  // one of these: the picker shows the result, and clearing is one click.
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
      write(ops)
    },
    [store, boardId, write],
  )

  const clearValue = React.useCallback(
    (value: BoardValue, imageId: string) => {
      write(clearValueOps(store.get(graphSnapshotAtom), value.id, imageId))
    },
    [store, write],
  )

  const resetImage = React.useCallback(
    (imageId: string) => {
      undoable(resetImageOps(store.get(graphSnapshotAtom), boardId, imageId), "Picture reset")
    },
    [store, boardId, undoable],
  )

  const setCaption = React.useCallback(
    (imageId: string, caption: string) => {
      write(setCaptionOps(store.get(graphSnapshotAtom), imageId, caption))
    },
    [store, write],
  )

  // The tile leaves the wall, which says it; a tombstone has no way back.
  const deleteImage = React.useCallback(
    (imageId: string) => {
      write(deleteBlockOps(imageId, store.get(graphSnapshotAtom)))
    },
    [store, write],
  )

  /**
   * A caption and tags for a picture: its bytes, as the page already has
   * them (`imageBlob`), fitted on the device for the model (`visionCopy` —
   * a JPEG no larger than 1,568 px on its longest side, so a phone photo of
   * any size goes, and goes small), go with the board's features as they
   * stand; the answer is read into the writes it amounts to
   * (`suggestionOps` — filling in, never overriding) and applied as one
   * batch with one Undo. A picture without an uploaded asset (an external
   * one, or one still on its way up) cannot be sent. Where the browser
   * cannot make the copy, the original goes and the Worker's size limit
   * answers for it.
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
      let picture: Blob
      try {
        const original = await imageBlob(asset)
        picture = (await visionCopy(original)) ?? original
      } catch (error) {
        failedToast("Couldn’t read that picture.", describeError(error))
        return
      }
      try {
        const suggestion = await requestTagSuggestion(
          picture,
          tagFeaturesOf(snapshot, boardId),
          imageLocationOf(snapshot, imageId),
        )
        const ops = suggestionOps(
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
        undoable(ops, "Picture updated")
      } catch (error) {
        if (error instanceof SuggestTagsError) failedToast(error.message, error.detail)
        else failedToast("Couldn’t suggest tags.", describeError(error))
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
   *
   * Where a picture was taken goes on its block as `lat`/`lon`, when it can
   * be known (docs/boards.md, "Tagging with Claude"): a picture from the
   * CAMERA is placed by the device, asked once for all of them as the
   * uploads start, with the browser's own permission prompt, and never
   * waited for — a position that answers after the asset has landed is
   * added to the block by a follow-up op, and one that answers after the
   * upload failed is dropped with the row; a picture from the PHOTOS
   * library is placed by its own EXIF, read from the original before the
   * fitter strips it. A picture with no coordinates gets no such props.
   */
  const addImages = React.useCallback(
    (files: File[], source?: "camera" | "photos"): string[] => {
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
      // The device's position, for the camera's pictures: one ask, beside
      // the uploads, never holding them. What it answers is written where
      // the row stands by then.
      const landed = new Set<string>()
      let position: ImageLocation | null = null
      const positioned =
        source === "camera"
          ? devicePosition().then((found) => {
              position = found
              if (!found) return
              for (const { id } of queued) {
                if (!landed.has(id)) continue
                apply(imageLocationOps(store.get(graphSnapshotAtom), id, found))
              }
              void requestDatabaseFlush()
            })
          : null
      void positioned
      void (async () => {
        for (const { id, file } of queued) {
          try {
            const exif = source === "photos" ? await readExifLocation(file) : null
            const asset = await uploadImage(file)
            primeImageObjectUrl(asset.id, file)
            apply(imageUploadedOps(id, asset, exif ?? position))
            landed.add(id)
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
      resetImage,
      setCaption,
      deleteImage,
      canSuggest,
      suggestTags,
    }),
    [
      canUpload,
      addImages,
      setValue,
      clearValue,
      resetImage,
      setCaption,
      deleteImage,
      canSuggest,
      suggestTags,
    ],
  )
}
