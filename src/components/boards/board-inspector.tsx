import { useAtomValue } from "jotai"
import React from "react"
import { imageValues, type BoardFeature, type BoardFeatureState } from "../../data/boards"
import { graphSnapshotAtom } from "../../global-state"
import type { BoardWrites } from "../../hooks/board"
import { usePending } from "../../hooks/pending"
import { Button } from "../ui/button"
import { Dialog } from "../ui/dialog"
import { FormControl } from "../form-control"
import { SparklesIcon16, TrashIcon16 } from "../icons"
import { TextInput } from "../ui/text-input"
import { BoardPicture, type BoardImage } from "./board-picture"
import { NewValueDialog } from "./new-value-dialog"
import { ValuePicker } from "./value-picker"

/**
 * The picture that was picked, in a window of its own: the picture large,
 * with its caption and its features beside it — the form a board is for
 * (docs/boards.md). The app's dialog, as wide as the screen allows, so the
 * picture has the room the wall could not give it; the pickers' menus and
 * the window for a new value's name open over it. Escape, the close
 * control or the scrim put it away.
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

  // The feature a new value is being named for (`NewValueDialog`), if any.
  const [naming, setNaming] = React.useState<BoardFeature | null>(null)

  // Claude's caption and tags for this picture (docs/boards.md, "Tagging
  // with Claude"): **Suggest**, the sparkles in the title bar, busy from the
  // press until the toast (docs/design-principles.md, Busy controls).
  const [suggest, suggesting] = usePending(() => writes.suggestTags(image.id))

  return (
    // Focus is kept in the window, but the page is not made inert: the
    // toast that answers a change — with its Undo — must stay in reach
    // while the window is open. A press on the scrim still puts it away.
    <Dialog open modal="trap-focus" onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Content
        title={image.text.trim() || "Picture"}
        actions={
          writes.canSuggest ? (
            // The word is the control's name; the icon's slot is where the
            // spinner goes.
            <Button
              size="small"
              icon={<SparklesIcon16 />}
              loading={suggesting}
              onClick={() => suggest()}
            >
              Suggest
            </Button>
          ) : null
        }
        className="max-h-[90vh] w-[calc(100vw-24px)] max-w-5xl"
      >
        <div
          data-testid="board-inspector"
          className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]"
        >
          <BoardPicture
            image={image}
            fit="contain"
            className="max-h-[70vh] min-h-40 bg-bg-secondary sm:min-h-80"
          />
          <div className="flex flex-col gap-4">
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
                  onNew={() => setNaming(state.feature)}
                />
              </div>
            ))}
            <NewValueDialog
              feature={naming}
              onAdd={(feature, text) => writes.setValue(feature, image.id, { text })}
              onClose={() => setNaming(null)}
            />
            <Button
              size="small"
              className="mt-auto self-start text-text-danger"
              onClick={() => {
                onClose()
                writes.deleteImage(image.id)
              }}
            >
              <TrashIcon16 />
              Delete image
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
