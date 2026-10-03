import React from "react"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { useInView } from "../../hooks/in-view"
import { Button } from "../ui/button"
import { FloatingBar, FloatingBarButton } from "../ui/floating-bar"
import { CameraIcon16, ImageIcon16 } from "../icons"

/**
 * The two ways to add pictures, as buttons at the top of the wall: the
 * camera, on a phone, and the photo library. Down a long wall the row
 * scrolls away, so once it is out of view the same two follow as glyphs
 * on the floating pill (`FloatingBar`, the edit bar's shape) at the foot
 * of the page, and leave again when the row is back. A drop anywhere on
 * the page, or a paste, adds too.
 */
export function AddImages({
  canUpload,
  exists,
  onFiles,
}: {
  /** Whether pictures can be added here (`BoardWrites.canUpload`). */
  canUpload: boolean
  /** Whether there is a board at all, for the buttons' excuse when not. */
  exists: boolean
  onFiles: (files: File[]) => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const cameraInputRef = React.useRef<HTMLInputElement>(null)
  // The camera is a thing a phone has in hand; on a desktop the capture
  // hint is ignored and the button would only open the picker twice over.
  const coarsePointer = useCoarsePointer()
  const { ref: rowRef, inView } = useInView<HTMLDivElement>()
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ""
  }
  const camera = () => cameraInputRef.current?.click()
  const photos = () => fileInputRef.current?.click()
  const excuse = canUpload
    ? undefined
    : exists
      ? "Sign in to add images"
      : "Open it as a note to start it first"
  return (
    <>
      {/* Full width on a phone, each button an equal share; their own
          width on a desktop. */}
      <div
        ref={rowRef}
        className="flex items-center gap-2 [&>button]:flex-1 sm:[&>button]:flex-none"
      >
        {coarsePointer ? (
          <Button disabled={!canUpload} title={excuse} onClick={camera}>
            <CameraIcon16 />
            Camera
          </Button>
        ) : null}
        <Button disabled={!canUpload} title={excuse} onClick={photos}>
          <ImageIcon16 />
          Photos
        </Button>
      </div>
      {/* The same two, as icons, while the row is scrolled out of view —
          greyed as the row's are, where nothing can be added yet. */}
      <FloatingBar
        open={exists && !inView}
        label="Add images"
        data-testid="add-images-bar"
        className="justify-center"
      >
        {coarsePointer ? (
          <FloatingBarButton label="Camera" disabled={!canUpload} onClick={camera}>
            <CameraIcon16 />
          </FloatingBarButton>
        ) : null}
        <FloatingBarButton label="Photos" disabled={!canUpload} onClick={photos}>
          <ImageIcon16 />
        </FloatingBarButton>
      </FloatingBar>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="board-file-input"
        onChange={pick}
      />
      {/* `capture` asks a phone for its camera rather than its library;
          one picture at a time, as a camera gives. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="board-camera-input"
        onChange={pick}
      />
    </>
  )
}
