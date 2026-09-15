// The admin wire format, shared between the Worker and the client. Pure:
// types only, so the admin page builds exactly the bodies the handler parses
// and reads exactly what it answers — same repo, same file, no drift. (Like
// worker/shares/wire.ts.)

import type { FeatureAudiences } from "../src/data/feature-flags"

/** What `GET /api/admin/features` and `PUT /api/admin/features/<key>` answer. */
export interface FeatureAudiencesBody {
  audiences: FeatureAudiences
}
