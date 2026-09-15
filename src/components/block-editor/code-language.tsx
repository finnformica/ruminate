import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import type { Block, BlockProps } from "../../blocks/types"
import { cx } from "../../utils/cx"
import type { BlockEditorApi } from "./block-item"

/**
 * **A code block's language, in the panel's top-right corner** — chrome, not
 * content: the word after the fence, which picks the grammar the view is
 * highlighted with (`code-highlight.tsx`). Clicking it opens a small field
 * in its place; Enter (or leaving it) sets the block's `language` prop, and
 * Escape puts the old one back. A block with no language shows a ghost
 * "language" while the panel is hovered, so the field can be found. Read
 * only, it is just the label.
 */

const LABEL = "absolute right-[5px] top-1 font-mono text-[11px] leading-4"

const stop = (event: MouseEvent) => event.stopPropagation()

export function CodeLanguage({ block, api }: { block: Block; api: BlockEditorApi }) {
  const language = String(block.props?.language ?? "")
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null
  // The field takes the keyboard as it opens, with the old language selected
  // so typing replaces it.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (value: string) => {
    setDraft(null)
    const next = value.trim()
    if (next === language) return
    const rest: BlockProps = { ...block.props }
    delete rest.language
    const props = next ? { ...rest, language: next } : Object.keys(rest).length > 0 ? rest : null
    api.onBlockChange(block.id, { props }, "structural")
  }

  if (api.readOnly) {
    return language ? (
      <span
        aria-hidden
        data-testid="code-language"
        className={cx(LABEL, "pointer-events-none select-none text-text-tertiary")}
      >
        {language}
      </span>
    ) : null
  }

  if (draft !== null) {
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      // The editor's own keys (select mode's letters, Space, Enter) must not
      // see what is typed here.
      event.stopPropagation()
      if (event.key === "Enter") {
        event.preventDefault()
        commit(draft)
      } else if (event.key === "Escape") {
        event.preventDefault()
        setDraft(null)
      }
    }
    return (
      <input
        data-testid="code-language-input"
        ref={inputRef}
        aria-label="Language"
        value={draft}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={onKeyDown}
        onMouseDown={stop}
        onClick={stop}
        className={cx(
          LABEL,
          "w-20 rounded-sm border-b border-border bg-transparent text-right text-text-secondary outline-none",
        )}
      />
    )
  }

  return (
    <button
      type="button"
      data-testid="code-language"
      title="Set the language"
      onMouseDown={stop}
      onClick={(event) => {
        stop(event)
        setDraft(language)
      }}
      className={cx(
        LABEL,
        "-mr-0.5 select-none rounded-sm px-0.5 text-text-tertiary transition-colors hover:text-text-secondary focus-visible:text-text-secondary",
        // No language: a ghost of the affordance, only while the panel is
        // hovered (or the button focused; always on a touch screen).
        !language &&
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100",
      )}
    >
      {language || "language"}
    </button>
  )
}
