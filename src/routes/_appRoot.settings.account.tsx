import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { ProfileSection, SignInSection } from "../components/settings/profile-section"
import { UpdatesSection } from "../components/settings/updates-section"
import { githubUserAtom } from "../global-state"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/account")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Account · Settings · Ruminate" }] }),
})

const page = settingsPage("account")

function RouteComponent() {
  const githubUser = useAtomValue(githubUserAtom)
  return (
    <SettingsPageBody page={page}>
      <ProfileSection />
      <SignInSection />
      {githubUser ? <UpdatesSection /> : null}
    </SettingsPageBody>
  )
}
