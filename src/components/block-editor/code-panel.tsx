import type { ReactNode } from "react"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { cx } from "../../utils/cx"
import type { BlockEditorApi } from "./block-item"
import { CodeLanguage } from "./code-language"
import { CopyCodeButton } from "./copy-code"
import { FigureFrame } from "./figure-frame"

/**
 * A code block's panel: the figure that sits in the row, as a picture
 * (`image-figure.tsx`) and a link card (`link-card.tsx`) do — a tinted,
 * bordered surface at the card's radius, WRAPPING the row's content line
 * rather than being classes on it. The row sizes its textarea by its text
 * alone (`1lh` empty, else its scroll height) and draws the view with the
 * same `min-h-[1lh]`; padding and a border on the line itself broke both:
 * an empty block's one-line box was eaten by its own padding (the caret
 * clipped, then a jump to size on the first keystroke), and the border
 * went uncounted, so every edit was 2px shorter than its view. Around the
 * line, the chrome adds the same to both states and the text never moves.
 *
 * The layout — the side it keeps to, its width, the handles and toolbar
 * that set them — is the frame's (`figure-frame.tsx`), shared with every
 * figure block; the panel is the row's full width until dragged. (It used
 * to be drawn over the row's surface itself, flush to its edges, with its
 * border taking the selection ring's colour: the one framed block set
 * differently from the other two.) The language sits in its BOTTOM-right
 * corner — chrome, not content, and a control: click it to change it
 * (`code-language.tsx`) — out from under the toolbar, which takes the
 * top-right on hover.
 *
 * The code is copied from the panel's TOP-right corner, while the pointer is
 * over it: in an editable editor as the toolbar's first tool, ahead of the
 * alignment buttons; read only, where there is no toolbar, as a button of
 * its own in the same place, on the same surface.
 */
export function CodePanel({
  block,
  occurrence,
  api,
  line,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  /** The code line (the row's body, view or textarea). */
  line: ReactNode
}) {
  return (
    <FigureFrame
      block={block}
      occurrence={occurrence}
      api={api}
      noun="code"
      naturalWidth="100%"
      controls={!api.readOnly}
      tools={block.text ? <CopyCodeButton text={block.text} /> : null}
    >
      {() => (
        <div
          data-testid="code-panel"
          className="group prism relative flex w-full min-w-0 rounded-lg border border-border-secondary bg-[var(--color-bg-code-block)] px-3 py-2"
        >
          {line}
          <CodeLanguage block={block} api={api} />
          {api.readOnly && block.text ? (
            <div
              className={cx(
                "absolute right-2 top-2 flex p-0.5",
                "rounded-[6px] bg-bg-overlay-backdrop shadow-lg ring-1 ring-[var(--neutral-a3)] backdrop-blur-lg dark:ring-inset",
                "invisible opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100",
              )}
            >
              <CopyCodeButton text={block.text} />
            </div>
          ) : null}
        </div>
      )}
    </FigureFrame>
  )
}
