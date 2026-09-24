import { createFileRoute } from "@tanstack/react-router"
import { ProfileSection, SignInSection } from "../components/settings/profile-section"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/account")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "Account · Settings · Ruminate" }] }),
})

const page = settingsPage("account")

function RouteComponent() {
  return (
    <SettingsPageBody page={page}>
      <ProfileSection />
      <SignInSection />
    </SettingsPageBody>
  )
}
