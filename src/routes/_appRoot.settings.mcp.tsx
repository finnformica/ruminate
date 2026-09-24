import { createFileRoute } from "@tanstack/react-router"
import { McpTokensSection } from "../components/mcp-tokens-section"
import { SettingsPageBody, settingsPage } from "../components/settings/settings-pages"

export const Route = createFileRoute("/_appRoot/settings/mcp")({
  component: RouteComponent,
  head: () => ({ meta: [{ title: "MCP access · Settings · Ruminate" }] }),
})

const page = settingsPage("mcp")

function RouteComponent() {
  return (
    <SettingsPageBody page={page}>
      <McpTokensSection />
    </SettingsPageBody>
  )
}
