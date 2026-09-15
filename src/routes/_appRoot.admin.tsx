import { createFileRoute } from "@tanstack/react-router"
import React from "react"
import { listFeatureAudiences, setFeatureAudience } from "../data/admin"
import {
  AUDIENCE_LABELS,
  AUDIENCES,
  FEATURES,
  type Audience,
  type FeatureAudiences,
  type FeatureKey,
} from "../data/feature-flags"
import { refreshFeatures, useIsAdmin } from "../data/features"
import { Button } from "../components/button"
import { DropdownMenu } from "../components/dropdown-menu"
import { ChevronDownIcon16, FlagIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { SettingsSection } from "../components/settings-section"

/**
 * The admin page: the bootstrap owner's controls, laid out like Settings.
 *
 * **Features** sets each flag's audience (Off, Admin, Everyone;
 * src/data/feature-flags.ts). Everything here is refused server-side for
 * anyone but the admin; the page only draws for them too.
 */
export const Route = createFileRoute("/_appRoot/admin")({
  component: RouteComponent,
  head: () => ({
    meta: [{ title: "Admin · Ruminate" }],
  }),
})

function RouteComponent() {
  const isAdmin = useIsAdmin()
  return (
    <PageLayout title="Admin" icon={<FlagIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          {isAdmin ? (
            <FeaturesSection />
          ) : (
            <span className="text-text-secondary">Nothing here.</span>
          )}
        </div>
      </div>
    </PageLayout>
  )
}

// -----------------------------------------------------------------------------
// Features
// -----------------------------------------------------------------------------

function FeaturesSection() {
  const [audiences, setAudiences] = React.useState<FeatureAudiences | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    listFeatureAudiences()
      .then((loaded) => {
        setAudiences(loaded)
        setError(null)
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Could not load the features.")
      })
  }, [])

  async function update(key: FeatureKey, audience: Audience) {
    try {
      setAudiences(await setFeatureAudience(key, audience))
      setError(null)
      // The admin's own panels follow the flags too.
      await refreshFeatures()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change that feature.")
    }
  }

  return (
    <SettingsSection title="Features">
      <p className="leading-5 text-text-secondary">
        Who each feature is on for. <span className="text-text">Admin</span> is you alone;{" "}
        <span className="text-text">Off</span> switches it off for everyone, including you.
      </p>

      {error ? <p className="text-text-danger">{error}</p> : null}

      {audiences === null ? (
        <span className="text-text-secondary">Loading…</span>
      ) : (
        FEATURES.map((feature) => (
          <div key={feature.key} className="flex items-center justify-between gap-4">
            <div className="flex w-0 grow flex-col gap-1">
              <span className="leading-4">{feature.label}</span>
              <span className="text-sm leading-5 text-text-secondary">{feature.description}</span>
            </div>
            <AudienceMenu
              label={feature.label}
              value={audiences[feature.key]}
              onChange={(audience) => void update(feature.key, audience)}
            />
          </div>
        ))
      )}
    </SettingsSection>
  )
}

/** The Off / Admin / Everyone pick, as a dropdown on a button. */
function AudienceMenu({
  label,
  value,
  onChange,
}: {
  label: string
  value: Audience
  onChange: (audience: Audience) => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <Button className="shrink-0" aria-label={`${label}: ${AUDIENCE_LABELS[value]}`}>
            {AUDIENCE_LABELS[value]}
            <ChevronDownIcon16 />
          </Button>
        }
      />
      <DropdownMenu.Content align="end" width={160}>
        {AUDIENCES.map((audience) => (
          <DropdownMenu.Item
            key={audience}
            selected={audience === value}
            onClick={() => onChange(audience)}
          >
            {AUDIENCE_LABELS[audience]}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
