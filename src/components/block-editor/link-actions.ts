import { createContext } from "react"

/**
 * What a rendered inline link can do to the block it is in, offered on
 * its hover card (`link-hover-card.tsx`). Provided by the row
 * (`block-item.tsx`) in an editable editor, and absent everywhere else —
 * a read-only view, the help panel — where a link is only a link.
 */
export interface LinkActions {
  /** Make a link block of this link (docs/links.md): the block itself,
   * when its text is nothing but the link, else a new row beneath. */
  toBlock: (href: string, title: string) => void
  /** Change the link's display text, `[title](href)` in the block's text
   * (a bare address is written out as a link to do it). */
  rename: (href: string, title: string, next: string) => void
}

export const LinkActionsContext = createContext<LinkActions | null>(null)
