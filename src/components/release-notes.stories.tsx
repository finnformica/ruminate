import { parseChangelog } from "../utils/changelog"
import { ReleaseNotes } from "./release-notes"

const SOURCE = `# Changelog

## 2026-W38

### Added

- Pin a block. **Pin** in a block's right-click menu lists it in the sidebar under **Pinned**, and the row opens the note zoomed into that block.

### Changed

- <kbd>⌘</kbd> <kbd>K</kbd> searches everything, not just the note you are in. To look inside the open note, type \`in:\` and pick it.
- The palette starts empty each time it opens. The query goes with the dialog.

### Fixed

- A copied to-do keeps its box when pasted elsewhere. The box is now the \`[ ]\` text itself, which every app keeps.
`

const [release] = parseChangelog(SOURCE).releases

export default {
  title: "ReleaseNotes",
  component: ReleaseNotes,
}

/** A release as the changelog page draws it: the lead sentence carrying the
 * weight, the detail quieter behind it, and shortcuts drawn as keycaps. */
export const Release = {
  render: () => (
    <div style={{ width: 640, padding: 16 }}>
      <ReleaseNotes release={release} />
    </div>
  ),
}
