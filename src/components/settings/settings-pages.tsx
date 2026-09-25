import { useAtomValue } from "jotai"
import { useIsAdmin } from "../../data/features"
import { githubUserAtom } from "../../global-state"
import { DeletedNotesSection } from "../deleted-notes-section"
import { McpTokensSection } from "../mcp-tokens-section"
import { SharingSection } from "../sharing-section"
import { AboutSection } from "./about-section"
import { AccountSection } from "./account-section"
import { AppearanceSection } from "./appearance-section"
import { ChangelogSection } from "./changelog-section"
import { EditorSection } from "./editor-section"
import { FeaturesSection } from "./features-section"
import { InvitesSection } from "./invites-section"
import type { SettingsPageId } from "./settings-nav"
import { StorageSection } from "./storage-section"

/**
 * A page's cards, in order (the pages themselves are named in
 * settings-nav.tsx). A card that needs a sign-in is not drawn without one
 * (the preferences follow the account; Recently deleted reads the local
 * database, which only a signed-in user has); the admin's page draws for
 * the admin alone, as the server says, and says so to anyone else.
 */
export function SettingsPageContent({ id }: { id: SettingsPageId }) {
  const githubUser = useAtomValue(githubUserAtom)
  const isAdmin = useIsAdmin()
  switch (id) {
    case "account":
      return <AccountSection />
    case "preferences":
      return (
        <>
          <AppearanceSection />
          <EditorSection />
          {githubUser ? <ChangelogSection /> : null}
        </>
      )
    case "sharing":
      return <SharingSection />
    case "mcp":
      return <McpTokensSection />
    case "data":
      return (
        <>
          <StorageSection />
          {githubUser ? <DeletedNotesSection /> : null}
        </>
      )
    case "about":
      return <AboutSection />
    case "admin":
      return isAdmin ? (
        <>
          <FeaturesSection />
          <InvitesSection />
        </>
      ) : (
        <span className="text-text-secondary">Nothing here.</span>
      )
  }
}
