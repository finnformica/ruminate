// The admin and invite wire format, shared between the Worker and the client.
// Pure: types only, so the admin page and the invite page build exactly the
// bodies the handlers parse and read exactly what they answer — same repo,
// same file, no drift. (Like worker/shares/wire.ts.)

import type { FeatureAudiences } from "../src/data/feature-flags"
import type { InviteSummary } from "./invites"

/** What `GET /api/admin/invites` answers. */
export interface InvitesListBody {
  invites: InviteSummary[]
}

/** What `POST /api/admin/invites` answers: the secret, once. */
export interface MintedInviteBody {
  token: string
  invite: InviteSummary
}

/** What `GET /api/admin/features` and `PUT /api/admin/features/<key>` answer. */
export interface FeatureAudiencesBody {
  audiences: FeatureAudiences
}

/**
 * What the invite page is told about the link it sent the sign-in through
 * (`?invite=`): `accepted` — admitted by it, just now; `member` — already a
 * tenant, the link untouched; `invalid` — the link is used, revoked, expired
 * or made up, and the sign-in is not a tenant.
 */
export type InviteOutcome = "accepted" | "member" | "invalid"
