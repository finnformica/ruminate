import { useAtomValue } from "jotai"
import React from "react"
import { imageValues, type BoardFeatureState } from "../../data/boards"
import { graphSnapshotAtom } from "../../global-state"
import type { BoardWrites } from "../../hooks/board"
import { Button } from "../ui/button"
import { FormControl } from "../form-control"
import { IconButton } from "../ui/icon-button"
import { TrashIcon16, XIcon16 } from "../icons"
import { TextInput } from "../ui/text-input"
import { BoardPicture, type BoardImage } from "./board-picture"
import { ValuePicker } from "./value-picker"

/**
 * The picture that was picked, large, with its caption and its features
 * beside it — the form a board is for (docs/boards.md). Drawn on the page
 * above the grid rather than in a dialog, so the pickers' menus have
 * nothing to fight and the grid stays in view to pick the next one.
 */
export function BoardInspector({
  image,
  features,
  writes,
  onClose,
}: {
  image: BoardImage
  features: BoardFeatureState[]
  writes: BoardWrites
  onClose: () => void
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const [caption, setCaption] = React.useState(image.text)
  // Another device, or the outline, may retitle it while it is open.
  React.useEffect(() => setCaption(image.text), [image.id, image.text])
  const commitCaption = () => writes.setCaption(image.id, caption.trim())

  // Escape closes it, wherever the keys are — unless something nearer (a
  // picker's open menu) has already answered the key.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const askForNew = (state: BoardFeatureState) => {
    const text = window.prompt(`New ${state.feature.label.toLowerCase()}`)
    if (text === null || text.trim() === "") return
    writes.setValue(state.feature, image.id, { text })
  }

  return (
    <section
      data-testid="board-inspector"
      aria-label={caption.trim() || "Picture"}
      className="relative grid gap-4 rounded-lg border border-border-secondary bg-bg-card p-3 sm:grid-cols-[minmax(0,1fr)_16rem]"
    >
      <IconButton
        aria-label="Close"
        size="small"
        className="absolute right-2 top-2 z-10"
        onClick={onClose}
      >
        <XIcon16 />
      </IconButton>
      <BoardPicture image={image} fit="contain" className="max-h-96 min-h-40 bg-bg-secondary" />
      <div className="flex flex-col gap-4 sm:pr-8">
        <FormControl htmlFor="board-caption" label="Caption">
          <TextInput
            id="board-caption"
            value={caption}
            placeholder="What is this?"
            onChange={(event) => setCaption(event.target.value)}
            onBlur={commitCaption}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitCaption()
                event.currentTarget.blur()
              }
            }}
          />
        </FormControl>
        {features.map((state) => (
          <div key={state.feature.label} className="flex flex-col gap-2">
            <span className="text-sm/4 text-text-secondary">{state.feature.label}</span>
            <ValuePicker
              state={state}
              selected={imageValues(snapshot, state, image.id)}
              onPick={(value) => writes.setValue(state.feature, image.id, { id: value.id })}
              onClear={(value) => writes.clearValue(state.feature, value, image.id)}
              onNew={() => askForNew(state)}
            />
          </div>
        ))}
        <Button
          size="small"
          className="mt-auto self-start text-text-danger"
          onClick={() => {
            writes.deleteImage(image.id)
            onClose()
          }}
        >
          <TrashIcon16 />
          Delete image
        </Button>
      </div>
    </section>
  )
}
