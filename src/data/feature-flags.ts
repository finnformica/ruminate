/**
 * The feature-flag registry — the one list of switchable features, shared by
 * the Worker (which enforces a flag on the feature's routes) and the client
 * (which hides what the caller may not use).
 *
 * A flag has an AUDIENCE: `off` (nobody), `admin` (the bootstrap owner only)
 * or `everyone`. The admin sets it from the admin page; the value lives in
 * the control plane's `feature_flags` table (migrations/0013), and a feature
 * with no row is at the default given here. So adding a switch is adding an
 * entry below and checking `featureAllows` (worker/features.ts) where the
 * feature is served.
 */

export const AUDIENCES = ["off", "admin", "everyone"] as const
export type Audience = (typeof AUDIENCES)[number]

export const isAudience = (value: unknown): value is Audience =>
  typeof value === "string" && (AUDIENCES as readonly string[]).includes(value)

export const FEATURE_KEYS = ["mcp", "sharing"] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]

export const isFeatureKey = (value: unknown): value is FeatureKey =>
  typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value)

export interface FeatureDefinition {
  key: FeatureKey
  /** The name on the admin page. */
  label: string
  /** One sentence on what the switch controls. */
  description: string
  /** The audience while no row says otherwise. */
  defaultAudience: Audience
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    key: "mcp",
    label: "MCP access",
    description:
      "Minting MCP tokens in Settings, and the /mcp endpoint the tokens are presented at.",
    defaultAudience: "everyone",
  },
  {
    key: "sharing",
    label: "Sharing",
    description: "Sharing notes and blocks with other users, and the Sharing panel in Settings.",
    defaultAudience: "everyone",
  },
]

export const AUDIENCE_LABELS: Record<Audience, string> = {
  off: "Off",
  admin: "Admin",
  everyone: "Everyone",
}

/** The audiences of every feature, defaults filled in for the unset ones. */
export type FeatureAudiences = Record<FeatureKey, Audience>

/** The features the caller may use, as the client reads them. */
export type EnabledFeatures = Record<FeatureKey, boolean>

export const DEFAULT_AUDIENCES: FeatureAudiences = Object.fromEntries(
  FEATURES.map((feature) => [feature.key, feature.defaultAudience]),
) as FeatureAudiences

/** Whether an audience admits a caller. */
export const audienceAdmits = (audience: Audience, isAdmin: boolean): boolean =>
  audience === "everyone" || (audience === "admin" && isAdmin)

/** What `GET /api/features` answers. */
export interface FeaturesBody {
  /** Whether the caller is the admin (the bootstrap owner). */
  admin: boolean
  features: EnabledFeatures
}
