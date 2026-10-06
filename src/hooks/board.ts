import { Searcher } from "fast-fuzzy"
import { useAtomValue, useStore } from "jotai"
import React from "react"
import { toast } from "sonner"
import { blockId } from "../blocks/id"
import {
  addFeatureOps,
  addImageOps,
  boardFeatures,
  boardImageIds,
  boardLinkUrl,
  clearValueOps,
  defaultFeatureOps,
  imageLocationOf,
  imageLocationOps,
  imageUploadedOps,
  type ImageLocation,
  inverseOps,
  isBoard,
  linkPreviewOps,
  notesFeaturesOf,
  notesSuggestionOps,
  outlineImageIds,
  removeFeatureOps,
  resetImageOps,
  setCaptionOps,
  suggestionOps,
  tagFeaturesOf,
  unassignedImageIds,
  updateFeatureOps,
  setValueOps,
  type BoardFeatureState,
  type BoardValue,
  type FeaturePatch,
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
import { NOTE_TYPE, parseProps, propsJson } from "../data/graph"
import { fetchLinkPreview } from "../data/link-previews"
import { notePropsOps } from "../data/note-meta"
import { applyOps, deleteBlockOps, type Op } from "../data/ops"
import { useApplyOps } from "../data/store"
import { requestNotesSuggestion } from "../data/suggest-notes"
import { requestTagSuggestion, SuggestError } from "../data/suggest-tags"
import { emittedNoteTitle } from "../data/note-identity"
import { blockIndexAtom, graphSnapshotAtom, isDatabaseModeAtom } from "../global-state"
import type { NoteId } from "../schema"
import { BOARD_PROP } from "../utils/board-prop"
import { viewNarrowing } from "../utils/view-narrowing"
import { useAiAvailable } from "./ai"

/**
 * Making a board (docs/boards.md): the one property set on the note's
 * page, and the default features written onto it as blocks — Location,
 * Object, Material — in one batch. **New board** makes the note first
 * (`create`, with its title); **Make this a board** marks the note that is
 * there. A default the note already has by label is left as it is, so a
 * note with a `Location` block written by hand keeps it.
 */
export function useMakeBoard(): (noteId: NoteId, create?: { title: string }) => void {
  const store = useStore()
  const apply = useApplyOps()
  return React.useCallback(
    (noteId, create) => {
      const snapshot = store.get(graphSnapshotAtom)
      const ops: Op[] = []
      if (snapshot.nodes.has(noteId)) {
        ops.push(...notePropsOps(noteId, { [BOARD_PROP]: true }, snapshot))
      } else if (create) {
        ops.push({
          op: "create",
          id: noteId,
          type: NOTE_TYPE,
          text: create.title.trim() || noteId,
          props: propsJson({ [BOARD_PROP]: true, updated_at: new Date().toISOString() }),
        })
      } else return
      // The defaults, against the board as the batch so far leaves it.
      ops.push(...defaultFeatureOps(applyOps(snapshot, ops, Date.now()), noteId))
      apply(ops)
    },
    [store, apply],
  )
}

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
  /** Give a picture a value of a feature (by its block), or take one off:
   * the picker shows the result, and nothing else is said. */
  setValue: (featureId: string, imageId: string, ref: ValueRef) => void
  clearValue: (value: BoardValue, imageId: string) => void
  /** The Features editor's writes (docs/boards.md, "Features"): a new text
   * feature, handed back by its block's id so the editor can focus it; a
   * feature's label, type, several-values and notes; and a feature
   * removed — its block left in the note as content, with a toast that
   * can undo it. */
  addFeature: () => string | null
  updateFeature: (featureId: string, patch: FeaturePatch) => void
  removeFeature: (featureId: string) => void
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
  /** Ask Claude for notes on the features that lack them — given the
   * board's name and everything its features already say — and write
   * them as one undoable batch. Settles when the toast has been shown. */
  suggestNotes: () => Promise<void>
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

  /**
   * A link value's preview, fetched behind the write as the editor fetches
   * a new link block's (docs/links.md) and written on quietly. A page that
   * will not answer is not an error here: the card is there to open either
   * way, and says "No preview available" where the description would be.
   * Only a signed-in reader can ask.
   */
  const previewInto = React.useCallback(
    (valueId: string, url: string) => {
      if (!isDatabaseMode) return
      void fetchLinkPreview(url)
        .then((preview) => {
          const ops = linkPreviewOps(store.get(graphSnapshotAtom), valueId, url, preview)
          if (ops.length === 0) return
          apply(ops)
          void requestDatabaseFlush()
        })
        .catch(() => {})
    },
    [isDatabaseMode, store, apply],
  )

  const setValue = React.useCallback(
    (featureId: string, imageId: string, ref: ValueRef) => {
      const snapshot = store.get(graphSnapshotAtom)
      const ops = setValueOps(snapshot, boardId, featureId, imageId, ref)
      write(ops)
      // A card made for a new address is asked for its preview.
      const url = "url" in ref ? boardLinkUrl(ref.url) : null
      const made = ops.find(
        (op): op is Extract<Op, { op: "create" }> => op.op === "create" && op.type === "link",
      )
      if (made && url !== null) previewInto(made.id, url)
    },
    [store, boardId, write, previewInto],
  )

  const clearValue = React.useCallback(
    (value: BoardValue, imageId: string) => {
      write(clearValueOps(store.get(graphSnapshotAtom), value.id, imageId))
    },
    [store, write],
  )

  // The Features editor's writes: each applied at once, the row showing
  // the result. A removal takes the prop off the block and deletes nothing,
  // and is answered with a toast whose Undo puts the prop back.
  const addFeature = React.useCallback((): string | null => {
    const id = blockId()
    const ops = addFeatureOps(store.get(graphSnapshotAtom), boardId, id)
    if (ops.length === 0) return null
    write(ops)
    return id
  }, [store, boardId, write])

  const updateFeature = React.useCallback(
    (featureId: string, patch: FeaturePatch) => {
      write(updateFeatureOps(store.get(graphSnapshotAtom), boardId, featureId, patch))
    },
    [store, boardId, write],
  )

  const removeFeature = React.useCallback(
    (featureId: string) => {
      undoable(
        removeFeatureOps(store.get(graphSnapshotAtom), boardId, featureId),
        "Feature removed",
      )
    },
    [store, boardId, undoable],
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
        // Where the picture was taken goes only where the board has a
        // place feature to offer it to.
        const features = tagFeaturesOf(snapshot, boardId)
        const placed = features.some((feature) => feature.place === true)
        const suggestion = await requestTagSuggestion(
          picture,
          features,
          placed ? imageLocationOf(snapshot, imageId) : null,
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
        if (error instanceof SuggestError) failedToast(error.message, error.detail)
        else failedToast("Couldn’t suggest tags.", describeError(error))
      }
    },
    [canSuggest, store, boardId, undoable],
  )

  /**
   * Notes for the features that lack them (docs/boards.md, "Features"):
   * the board's name and its features as they stand — label, type, one or
   * several values, the values in use, the notes already written — go to
   * the notes route, no picture; the answer is read into the writes it
   * amounts to (`notesSuggestionOps`: only an empty note is written, a
   * note a person wrote is never overwritten) and applied as one batch
   * with one Undo. Nothing to add is a toast that says so.
   */
  const suggestNotes = React.useCallback(async () => {
    if (!canSuggest) return
    const snapshot = store.get(graphSnapshotAtom)
    const title = emittedNoteTitle(boardId, snapshot.nodes.get(boardId)?.text ?? "") ?? ""
    try {
      const suggestion = await requestNotesSuggestion(title, notesFeaturesOf(snapshot, boardId))
      const ops = notesSuggestionOps(store.get(graphSnapshotAtom), boardId, suggestion, Date.now())
      if (ops.length === 0) {
        toast("Nothing to add.")
        return
      }
      undoable(ops, "Notes updated")
    } catch (error) {
      if (error instanceof SuggestError) failedToast(error.message, error.detail)
      else failedToast("Couldn’t suggest notes.", describeError(error))
    }
  }, [canSuggest, store, boardId, undoable])

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
      addFeature,
      updateFeature,
      removeFeature,
      resetImage,
      setCaption,
      deleteImage,
      canSuggest,
      suggestTags,
      suggestNotes,
    }),
    [
      canUpload,
      addImages,
      setValue,
      clearValue,
      addFeature,
      updateFeature,
      removeFeature,
      resetImage,
      setCaption,
      deleteImage,
      canSuggest,
      suggestTags,
      suggestNotes,
    ],
  )
}
