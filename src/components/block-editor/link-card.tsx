import type React from "react"
import { useState } from "react"
import type { ReactNode } from "react"
import { hostOf, linkPropsOf } from "../../blocks/link"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { cx } from "../../utils/cx"
import { ExternalLinkIcon16 } from "../icons"
import type { BlockEditorApi } from "./block-item"
import { FigureFrame, FigureTool } from "./figure-frame"
import { LinkHoverCard, openLink } from "./link-hover-card"

/**
 * A link block's card: the page it points at, as the page describes itself
 * (docs/links.md) — its title (the block's text, the row's own content
 * line, so it edits like a caption), its description beneath, and a byline
 * of favicon and site name, with the page's picture at the side when it
 * has one. The byline and the picture are links: click either to open the
 * page in a new tab, as **Open link** in the card's corner and **Visit**
 * on the hover card do. Click anywhere else and the row is selected, as it
 * is on a picture's margin; double-click to edit the title.
 *
 * Hover the card and the link's hover card opens over it (`link-hover-
 * card.tsx`), as it does over an inline link: Visit, the display text —
 * the block's title — and **Turn into inline**, which puts the link back
 * in the text.
 *
 * A link whose page said nothing — not yet fetched, or a page that will
 * not say — is the card with its host for a title, so it is still
 * something to read and to open. The card is the row's full width unless
 * dragged narrower; the frame (`figure-frame.tsx`) holds the layout.
 */
export function LinkCard({
  block,
  occurrence,
  api,
  title,
  pointer,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  /** The title line (the row's body, view or textarea), or null for an
   * untitled link that is not being edited — the host stands in. */
  title: ReactNode
  /** The row's click and double-click, for the card's plain surface. */
  pointer: Pick<React.HTMLAttributes<HTMLElement>, "onClick" | "onDoubleClick">
}) {
  const { url, description, image, favicon, site } = linkPropsOf(block)
  const host = hostOf(url)
  const [imageBroken, setImageBroken] = useState(false)
  const [faviconBroken, setFaviconBroken] = useState(false)
  const editable = !api.readOnly
  const picture = image && !imageBroken ? image : null

  // The card's own surface takes the row's click; its links, tools and the
  // title being edited keep theirs.
  const plain = (event: React.MouseEvent<HTMLElement>) =>
    !(event.target as Element).closest("a, button, textarea, [data-block-body]")
  const surface = {
    onClick: (event: React.MouseEvent<HTMLElement>) => plain(event) && pointer.onClick?.(event),
    onDoubleClick: (event: React.MouseEvent<HTMLElement>) =>
      plain(event) && pointer.onDoubleClick?.(event),
  }

  const card = (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      data-testid="link-card"
      className={cx(
        "flex w-full overflow-hidden rounded-lg border border-border-secondary bg-bg-card",
        "transition-colors duration-150 hover:bg-bg-hover",
      )}
      {...surface}
    />
  )
  const inner = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3">
        {title ? (
          <div data-block-body className="flex min-w-0">
            {title}
          </div>
        ) : (
          <div
            data-testid="link-untitled"
            className="min-h-[1lh] truncate text-base font-medium leading-relaxed text-text"
          >
            {url ? host : "No address"}
          </div>
        )}
        {description ? (
          <p
            data-testid="link-description"
            className="line-clamp-2 text-sm leading-normal text-text-secondary"
          >
            {description}
          </p>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            data-testid="link-byline"
            onClick={(event) => event.stopPropagation()}
            className="focus-ring mt-1 flex min-w-0 items-center gap-1.5 self-start rounded-sm text-xs text-text-secondary hover:text-text"
          >
            {favicon && !faviconBroken ? (
              <img
                src={favicon}
                alt=""
                width={14}
                height={14}
                draggable={false}
                onError={() => setFaviconBroken(true)}
                className="size-3.5 shrink-0 rounded-[2px]"
              />
            ) : null}
            <span className="truncate">{site ?? host}</span>
            {site && site !== host ? (
              <span className="truncate text-text-tertiary">{host}</span>
            ) : null}
          </a>
        ) : null}
      </div>
      {picture ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          tabIndex={-1}
          aria-label="Open link"
          onClick={(event) => event.stopPropagation()}
          className="block w-1/3 max-w-60 shrink-0 self-stretch"
        >
          <img
            src={picture}
            alt=""
            data-testid="link-image"
            draggable={false}
            onError={() => setImageBroken(true)}
            className="size-full object-cover"
          />
        </a>
      ) : null}
    </>
  )

  return (
    <FigureFrame
      block={block}
      occurrence={occurrence}
      api={api}
      noun="link"
      naturalWidth="100%"
      controls={editable && url !== ""}
      tools={
        url ? (
          <FigureTool label="Open link" onClick={() => openLink(url)}>
            <ExternalLinkIcon16 />
          </FigureTool>
        ) : null
      }
    >
      {() =>
        editable && url && api.linkToInline ? (
          <LinkHoverCard
            href={url}
            title={block.text}
            onRename={(text) => api.onBlockChange(block.id, { text }, "structural")}
            toggle={{ label: "Turn into inline", onClick: () => api.linkToInline?.(block.id) }}
            render={card}
          >
            {inner}
          </LinkHoverCard>
        ) : (
          <div {...card.props}>{inner}</div>
        )
      }
    </FigureFrame>
  )
}
