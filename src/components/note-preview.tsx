import { useAtomValue } from "jotai"
import { useMemo } from "react"
import { noteDoc } from "../data/graph"
import { graphSnapshotAtom } from "../global-state"
import { Note, fontSchema } from "../schema"
import { cx } from "../utils/cx"
import { formatDate, formatDateDistance, formatWeekDistance } from "../utils/date"
import { BlockEditor } from "./block-editor/block-editor"

const noop = () => {}

type NotePreviewProps = {
  note: Note
  className?: string
}

export function NotePreview({ note, className }: NotePreviewProps) {
  const props = note.props

  // The preview is the note's view, read-only: the same rows the note page
  // renders, walked out of the live graph.
  const snapshot = useAtomValue(graphSnapshotAtom)
  const doc = useMemo(() => noteDoc(note.id, snapshot), [note.id, snapshot])

  // Resolve note font (the note's font prop or the sans default)
  const resolvedFont = useMemo(() => {
    const parseResult = fontSchema.safeParse(props?.font as unknown)
    return parseResult.success ? parseResult.data : "sans"
  }, [props?.font])

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
    </div>
  )
}
