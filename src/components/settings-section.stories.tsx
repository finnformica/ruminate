import { SettingsSection } from "./settings-section"
import { Button } from "./ui/button"
import { Checkbox } from "./ui/checkbox"

export default {
  title: "SettingsSection",
  component: SettingsSection,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story: React.ComponentType) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
}

export const Default = {
  render: () => (
    <SettingsSection title="Editor">
      <div className="flex items-center gap-2">
        <Checkbox id="settings-section-story-links" defaultChecked />
        <label htmlFor="settings-section-story-links">Show links</label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>Export every note as markdown</span>
        <Button size="small">Export</Button>
      </div>
    </SettingsSection>
  ),
}
