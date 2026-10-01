import React from "react"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { Button } from "../ui/button"
import { DropdownMenu } from "../ui/dropdown-menu"
import { CameraIcon16, ChevronDownIcon16, ImageIcon16 } from "../icons"
import { SearchInput } from "../search-input"

/**
 * The line above the wall: a box for words matched against captions, and
 * **Add images** — the camera on a phone, the library everywhere — at its
 * end. Narrowing by what a picture carries is the header's Filter, as on
 * the note (docs/boards.md, "Reading").
 */
export function BoardToolbar({
  text,
  onText,
  canUpload,
  exists,
  onFiles,
}: {
  text: string
  onText: (text: string) => void
  /** Whether pictures can be added here (`BoardWrites.canUpload`). */
  canUpload: boolean
  /** Whether there is a board at all, for the button's excuse when not. */
  exists: boolean
  onFiles: (files: File[]) => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const cameraInputRef = React.useRef<HTMLInputElement>(null)
  const coarsePointer = useCoarsePointer()
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ""
  }
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1 sm:max-w-sm">
        <SearchInput placeholder="Search captions…" value={text} onChange={onText} />
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenu.Trigger
          render={
            <Button
              size="small"
              className="ml-auto shrink-0 gap-1.5"
              disabled={!canUpload}
              title={
                canUpload
                  ? undefined
                  : exists
                    ? "Sign in to add images"
                    : "Open it as a note to start it first"
              }
            >
              Add images
              <ChevronDownIcon16 className="text-text-secondary" />
            </Button>
          }
        />
        <DropdownMenu.Content align="end" width={200}>
          {/* The camera is a thing a phone has in hand; on a desktop the
              capture hint is ignored and the row would only open the
              picker twice over. */}
          {coarsePointer ? (
            <DropdownMenu.Item
              icon={<CameraIcon16 />}
              onClick={() => cameraInputRef.current?.click()}
            >
              Take a photo
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item icon={<ImageIcon16 />} onClick={() => fileInputRef.current?.click()}>
            Upload photos
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
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
