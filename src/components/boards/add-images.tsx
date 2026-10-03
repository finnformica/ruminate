import React from "react"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { Button } from "../ui/button"
import { CameraIcon16, ImageIcon16 } from "../icons"

/**
 * The two ways to add pictures, as buttons at the top of the wall: the
 * camera, on a phone, and the photo library. A drop anywhere on the page,
 * or a paste, adds too.
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
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ""
  }
  const excuse = canUpload
    ? undefined
    : exists
      ? "Sign in to add images"
      : "Open it as a note to start it first"
  return (
    // Full width on a phone, each button an equal share; their own width
    // on a desktop.
    <div className="flex items-center gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">
      {coarsePointer ? (
        <Button
          disabled={!canUpload}
          title={excuse}
          onClick={() => cameraInputRef.current?.click()}
        >
          <CameraIcon16 />
          Camera
        </Button>
      ) : null}
      <Button disabled={!canUpload} title={excuse} onClick={() => fileInputRef.current?.click()}>
        <ImageIcon16 />
        Photos
      </Button>
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
    </div>
  )
}
