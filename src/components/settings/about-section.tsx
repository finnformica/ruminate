import { Link } from "@tanstack/react-router"
import { SettingsSection } from "../settings-section"

/** Where the credits went when the settings became pages: the foot of the
 * one long page, before. */
export function AboutSection() {
  return (
    <SettingsSection title="Ruminate">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm leading-5 text-text-secondary [&>dd]:text-text">
        <dt>Build</dt>
        <dd className="font-mono">{__CHANGELOG_VERSION__}</dd>
        <dt>Changelog</dt>
        <dd>
          <Link to="/changelog" search={{ release: undefined }} className="link">
            What changed, week by week
          </Link>
        </dd>
        <dt>Source</dt>
        <dd>
          <a
            className="link"
            href="https://github.com/finnformica/ruminate"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/finnformica/ruminate
          </a>
        </dd>
      </dl>
      <div className="flex flex-col gap-1 border-t border-border-secondary pt-4 text-sm leading-5 text-text-secondary">
        <span>
          Made by{" "}
          <a
            className="link decoration-text-tertiary"
            href="https://github.com/finnformica"
            target="_blank"
            rel="noopener noreferrer"
          >
            Finn Formica
          </a>
        </span>
        <span>
          Built on{" "}
          <a
            className="link decoration-text-tertiary"
            href="https://github.com/lumen-notes/lumen"
            target="_blank"
            rel="noopener noreferrer"
          >
            Lumen
          </a>{" "}
          by{" "}
          <a
            className="link decoration-text-tertiary"
            href="https://colebemis.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            Cole Bemis
          </a>{" "}
          &amp; contributors
        </span>
      </div>
    </SettingsSection>
  )
}
