// The sharing wire format, shared between the Worker and the client
// (docs/sharing.md). Pure: types only, so the settings page and the shared
// runtime build exactly the bodies the handler parses — same repo, same file,
// no drift.

import type { LinkRow, NodeRow } from "../handlers/replica-payload"

/** A share as its OWNER sees it: the address they typed and the roots. */
export interface GivenShare {
  id: string
  granteeEmail: string
  rootIds: string[]
  createdAt: number
  revokedAt: number | null
}

/** A share as its GRANTEE sees it: who shared it (login and display name,
 * never an address) and the roots. */
export interface ReceivedShareSummary {
  id: string
  owner: { login: string; name: string | null }
  rootIds: string[]
  createdAt: number
}

/** Body of `GET /api/shares`. */
export interface SharesListBody {
  /** The caller's own recorded address — the one shares reach them at. */
  me: { email: string }
  given: GivenShare[]
  received: ReceivedShareSummary[]
}

/** Body of `POST /api/shares`. */
export interface CreateShareBody {
  email: string
  rootIds: string[]
}

/** Body of `GET /api/shares/:id/notes` — the slice, live rows only. */
export interface SliceBody {
  nodes: NodeRow[]
  links: LinkRow[]
}
