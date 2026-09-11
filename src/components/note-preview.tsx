import { useAtomValue } from "jotai"
import { useMemo } from "react"
import { pageDoc } from "../data/graph"
import { graphSnapshotAtom } from "../global-state"
import { Note, fontSchema } from "../schema"
import { cx } from "../utils/cx"
import { formatDate, formatDateDistance, formatWeekDistance } from "../utils/date"
import { BlockEditor } from "./block-editor/block-editor"
import { TagIcon12 } from "./icons"
import { Label } from "./label"

const NUM_VISIBLE_TAGS = 3
const noop = () => {}

type NotePreviewProps = {
  note: Note
  className?: string
  hideProperties?: boolean
}

export function NotePreview({ note, className, hideProperties }: NotePreviewProps) {
  const props = note.props

  // The preview is the page's view, read-only: the same rows the note page
  // renders, walked out of the live graph.
  const snapshot = useAtomValue(graphSnapshotAtom)
  const doc = useMemo(() => pageDoc(note.id, snapshot), [note.id, snapshot])

  // Resolve note font (the page's font prop or the sans default)
  const resolvedFont = useMemo(() => {
    const parseResult = fontSchema.safeParse(props?.font as unknown)
    return parseResult.success ? parseResult.data : "sans"
  }, [props?.font])

  const propTags = useMemo(() => {
    return Array.isArray(props?.tags) &&
      (props.tags as unknown[]).every((tag) => typeof tag === "string")
      ? (props.tags as string[])
      : []
  }, [props?.tags])

  return (
    <div
      {...{ inert: "" }}
      className={cx(
        "flex aspect-[5/3] w-full flex-col gap-3 overflow-hidden p-4 [contain:layout_paint]",
        className,
      )}
      style={
        {
          "--font-family-content": `var(--font-family-${resolvedFont})`,
          "--font-family-mono": `var(--font-family-${resolvedFont}-mono)`,
        } as React.CSSProperties
      }
    >
      {(note.type === "daily" || note.type === "weekly") && !note.title ? (
        <div className="mb-1 shrink-0 flex flex-col gap-0.5">
          <span className="font-bold text-[calc(var(--font-size-xl)*0.66)] [text-box-trim:trim-start]">
            {note.type === "daily" ? formatDate(note.id) : note.displayName}
          </span>
          <span className="text-text-secondary">
            {note.type === "daily" ? formatDateDistance(note.id) : formatWeekDistance(note.id)}
          </span>
        </div>
      ) : null}
      <div className="grow overflow-hidden [mask-image:linear-gradient(to_bottom,black_0%,black_75%,transparent_100%)] [&_*::-webkit-scrollbar]:hidden">
        <div className="w-[152%] origin-top-left scale-[66%]">
          {doc && note.text.trim() !== "" ? (
            <BlockEditor doc={doc} onChange={noop} readOnly />
          ) : (
            <span className="text-text-tertiary italic font-sans">Empty note</span>
          )}
        </div>
      </div>
      {!hideProperties ? (
        <div className="flex flex-wrap gap-x-1.5 gap-y-2 pr-10 font-content empty:hidden coarse:pr-12">
          {/*{note.tasks.length > 0 ? (
            <Label
              icon={
                <ProgressRing
                  size={14}
                  value={note.tasks.filter((t) => t.completed).length / note.tasks.length}
                  strokeWidth={2}
                />
              }
            >
              {note.tasks.filter((t) => t.completed).length}/{note.tasks.length}
            </Label>
          ) : null}*/}
          {propTags.slice(0, NUM_VISIBLE_TAGS).map((tag) => (
            <Label key={tag} icon={<TagIcon12 />}>
              {tag}
            </Label>
          ))}
          {propTags.length > NUM_VISIBLE_TAGS ? (
            <Label icon={<TagIcon12 />}>+{propTags.length - NUM_VISIBLE_TAGS}</Label>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
