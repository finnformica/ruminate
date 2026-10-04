import type { BoardValue } from "../../data/boards"
import { Button } from "../ui/button"
import { IconButton } from "../ui/icon-button"
import { LinkCardBody, openLink } from "../block-editor/link-card"
import { ExternalLinkIcon16, PlusIcon16, XIcon16 } from "../icons"

/**
 * A link feature on one picture (docs/boards.md): the pages it came from,
 * each the editor's own link card (`LinkCardBody`, docs/links.md) — the
 * page's title, its description and its byline, with a control to open
 * it and one to take it off the picture — and **Add link**, which asks for
 * an address. The page's picture is left off the card: the window already
 * shows a picture, and the column is narrow.
 */
export function LinkValues({
  values,
  onRemove,
  onAdd,
}: {
  /** The link values the picture carries. */
  values: readonly BoardValue[]
  onRemove: (value: BoardValue) => void
  /** Asks for a new link's address. */
  onAdd: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {values.map((value) => {
        const url = value.link?.url ?? ""
        return (
          <div
            key={value.id}
            data-testid="board-link"
            className="flex w-full overflow-hidden rounded-lg border border-border-secondary bg-bg-card"
          >
            <LinkCardBody
              props={{ ...value.link, url, image: undefined }}
              text={value.text}
              title={
                <span className="min-h-[1lh] min-w-0 truncate text-base font-medium leading-relaxed text-text">
                  {value.text}
                </span>
              }
              editing={false}
            />
            <div className="flex shrink-0 flex-col gap-1 p-1.5">
              <IconButton
                aria-label="Open link"
                size="small"
                tooltipSide="left"
                disabled={url === ""}
                onClick={() => openLink(url)}
              >
                <ExternalLinkIcon16 />
              </IconButton>
              <IconButton
                aria-label="Remove link"
                size="small"
                tooltipSide="left"
                onClick={() => onRemove(value)}
              >
                <XIcon16 />
              </IconButton>
            </div>
          </div>
        )
      })}
      <Button size="small" className="self-start" onClick={onAdd}>
        <PlusIcon16 />
        Add link
      </Button>
    </div>
  )
}
