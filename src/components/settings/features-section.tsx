import React from "react"
import { listFeatureAudiences, setFeatureAudience } from "../../data/admin"
import {
  AUDIENCE_LABELS,
  AUDIENCES,
  FEATURES,
  type Audience,
  type FeatureAudiences,
  type FeatureKey,
} from "../../data/feature-flags"
import { refreshFeatures } from "../../data/features"
import { usePending } from "../../hooks/pending"
import { Button } from "../ui/button"
import { DropdownMenu } from "../ui/dropdown-menu"
import { ChevronDownIcon16 } from "../icons"
import { SettingsSection } from "../settings-section"

export function FeaturesSection() {
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
    <SettingsSection title="Feature flags">
      {error ? <p className="text-text-danger">{error}</p> : null}

      {audiences === null ? (
        <span className="text-text-secondary">Loading…</span>
      ) : (
        FEATURES.map((feature) => (
          <div key={feature.key} className="flex items-center justify-between gap-4">
            <span className="w-0 grow truncate leading-4">{feature.label}</span>
            <AudienceMenu
              label={feature.label}
              value={audiences[feature.key]}
              onChange={(audience) => update(feature.key, audience)}
            />
          </div>
        ))
      )}
    </SettingsSection>
  )
}

/** The Off / Admin / Everyone pick, as a dropdown on a button — busy, with
 * the label it still has, while the change is out. */
function AudienceMenu({
  label,
  value,
  onChange,
}: {
  label: string
  value: Audience
  onChange: (audience: Audience) => Promise<void>
}) {
  const [change, changing] = usePending(onChange)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <Button
            className="shrink-0"
            aria-label={`${label}: ${AUDIENCE_LABELS[value]}`}
            loading={changing}
          >
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
            onClick={() => change(audience)}
          >
            {AUDIENCE_LABELS[audience]}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
