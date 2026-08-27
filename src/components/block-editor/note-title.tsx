import { useEffect, useRef, useState } from "react"
import { cx } from "../../utils/cx"

/**
 * The note's name shown as an editable `# ` heading at the top of the page —
 * outside the block flow, but modelled on a block so it feels like one: it has a
 * **selected** state (highlighted, navigable with the keyboard) and an **edit**
 * state (a text field), mirroring the block editor's two modes.
 *
 * - Arrow-up from the first block selects the title (via `focusSignal`), which
 *   highlights it and clears the block highlight below.
 * - Enter (or a click) edits it; Escape / Enter / blur commit or revert.
 * - Arrow-down returns focus to the editor (`onArrowDown`).
 *
 * `onRename` returns whether the rename succeeded so the field can revert on
 * failure (invalid name, duplicate).
 */
export function NoteTitle({
  noteId,
  onRename,
  onArrowDown,
  onCreateBelow,
  focusSignal,
}: {
  noteId: string
  onRename: (name: string) => boolean
  /**
   * Down-arrow returns focus to the editor below. The mode mirrors the title's
   * own: from an edited title it drops into the first block *editing* (like
   * moving between blocks with the caret); from a highlighted title it just
   * highlights the first block.
   */
  onArrowDown?: (mode: "edit" | "select") => void
  /** Cmd/Shift+Enter while the title is selected adds a new root block. */
  onCreateBelow?: () => void
  /** Bump to select the title from the keyboard (arrow-up past the first block). */
  focusSignal?: number
}) {
  const [value, setValue] = useState(noteId)
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState(false)
  const headingRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset the field when navigating to a different note (no effect needed).
  const [prevId, setPrevId] = useState(noteId)
  if (noteId !== prevId) {
    setPrevId(noteId)
    setValue(noteId)
    setEditing(false)
    setSelected(false)
  }

  // Select (highlight) the title when the editor hands focus up to it.
  useEffect(() => {
    if (!focusSignal) return
    setEditing(false)
    setSelected(true)
  }, [focusSignal])

  useEffect(() => {
    if (selected && !editing) headingRef.current?.focus()
  }, [selected, editing])

  useEffect(() => {
    if (editing) {
      const el = inputRef.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editing])

  const commit = () => {
    const next = value.trim()
    if (!next || next === noteId) {
      setValue(noteId)
      return
    }
    if (!onRename(next)) setValue(noteId)
  }

  return (
    // pl-8 aligns the title with the block content column (past the block
    // editor's collapse-toggle gutter). The # hangs to its left as a marker.
    <h1 className="relative font-content text-3xl font-bold leading-tight tracking-[-0.02em]">
      <span
        aria-hidden
        className="pointer-events-none absolute left-0.5 top-0 select-none text-text-tertiary"
      >
        #
      </span>
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            commit()
            setEditing(false)
            setSelected(false)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
              setEditing(false)
              setSelected(true)
            } else if (event.key === "Escape") {
              event.preventDefault()
              setValue(noteId)
              setEditing(false)
              setSelected(true)
            } else if (event.key === "ArrowDown") {
              // The title is a single line, so Down drops into the editor below —
              // and since we're editing the title, the first block opens editing
              // too, matching how Down moves the caret between blocks.
              event.preventDefault()
              commit()
              setEditing(false)
              setSelected(false)
              onArrowDown?.("edit")
            }
          }}
          spellCheck={false}
          aria-label="Note name"
          placeholder="Untitled"
          className="w-full border-none bg-transparent py-0 pl-8 pr-0 text-text outline-none placeholder:text-text-tertiary"
        />
      ) : (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div
          ref={headingRef}
          role="button"
          tabIndex={0}
          onFocus={() => setSelected(true)}
          onBlur={() => setSelected(false)}
          onClick={() => {
            setSelected(true)
            setEditing(true)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.shiftKey)) {
              // Cmd/Shift+Enter: create a new root block below the title.
              event.preventDefault()
              setSelected(false)
              onCreateBelow?.()
            } else if (event.key === "Enter") {
              event.preventDefault()
              setEditing(true)
            } else if (event.key === "ArrowDown") {
              event.preventDefault()
              setSelected(false)
              onArrowDown?.("select")
            }
          }}
          className={cx(
            "cursor-text rounded-sm py-0 pl-8 pr-0 outline-none transition-colors duration-100",
            // Same selection treatment as a block (see .block-highlight).
            selected && "bg-bg-secondary block-highlight",
          )}
        >
          {value || <span className="text-text-tertiary">Untitled</span>}
        </div>
      )}
    </h1>
  )
}
