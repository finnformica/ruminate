import type { LinkPreview } from "../blocks/link"
import { sessionFetch } from "./session-fetch"

/**
 * The client half of link blocks (docs/links.md): asking the Worker what
 * a page says about itself (`worker/handlers/unfurl.ts`), so a link
 * block can show a title, a description and a picture rather than a bare
 * address. Called once when a link block is made, and again on **Refresh
 * preview**; the answer is written onto the block and never fetched on
 * view. Only a signed-in reader can ask — the route takes the session, so
 * the Worker fetches pages for its own users and no one else.
 */

export type LinkPreviewErrorCode = "signed_out" | "invalid" | "unreachable" | "failed"

export class LinkPreviewError extends Error {
  constructor(
    public readonly code: LinkPreviewErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "LinkPreviewError"
  }
}

const signedOut = () => new LinkPreviewError("signed_out", "Sign in to preview links")

/** What the page at `url` says about itself. */
export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const response = await sessionFetch(
    `/api/unfurl?url=${encodeURIComponent(url)}`,
    { method: "GET" },
    signedOut,
  )
  if (response.status === 400) {
    throw new LinkPreviewError("invalid", "That address cannot be previewed")
  }
  if (response.status === 502) {
    throw new LinkPreviewError("unreachable", "The page did not answer")
  }
  if (!response.ok) throw new LinkPreviewError("failed", `Preview failed (${response.status})`)
  const body = (await response.json()) as Partial<LinkPreview> | null
  if (!body || typeof body.url !== "string") throw new LinkPreviewError("failed", "Preview failed")
  return body as LinkPreview
}
