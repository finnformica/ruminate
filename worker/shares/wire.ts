// The sharing wire format, shared between the Worker and the client
// (docs/sharing.md). Pure: types only, so the settings page and the shared
// runtime build exactly the bodies the handler parses — same repo, same file,
// no drift.

import type { LinkRow, NodeRow } from "../handlers/replica-payload"
import type { Permission } from "../mcp/grant"

/**
 * The view a share is of (migrations/0017): the owner's row, as the share
 * resolves it at request time — where it starts, and the filter and sort
 * the grantee opens it with (docs/metadata.md, "Views"). Presentation, not
 * permission: the slice is the whole subtree beneath the root.
 */
export interface ShareView {
  id: string
  rootId: string
  filter: string | null
  sort: string | null
}

/** A share as its OWNER sees it: the address they typed, the view, the verbs. */
export interface GivenShare {
  id: string
  granteeEmail: string
  view: ShareView
  permissions: Permission[]
  createdAt: number
  revokedAt: number | null
}

/** A share as its GRANTEE sees it: who shared it (login and display name,
 * never an address), the view, the verbs. */
export interface ReceivedShareSummary {
  id: string
  owner: { login: string; name: string | null }
  view: ShareView
  permissions: Permission[]
  createdAt: number
}

/** Body of `GET /api/shares`. */
export interface SharesListBody {
  /** The caller's own recorded address — the one shares reach them at. */
  me: { email: string }
  given: GivenShare[]
  received: ReceivedShareSummary[]
}

/** Body of `POST /api/shares`: the node to share (the view rooted at it is
 * made if the owner has none) and the verbs. */
export interface CreateShareBody {
  email: string
  rootId: string
  permissions: Permission[]
}

/** Body of `GET /api/shares/:id/notes` — the slice, live rows only, and the
 * view it is of as it stands now, so a pull follows the owner's edits to it. */
export interface SliceBody {
  nodes: NodeRow[]
  links: LinkRow[]
  view: ShareView
}
