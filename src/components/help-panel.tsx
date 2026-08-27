import { useAtom } from "jotai"
import { Fragment, useMemo, useState } from "react"
import { Drawer } from "vaul"
import { isHelpPanelOpenAtom } from "../global-state"
import {
  APP_SHORTCUTS,
  formatCombo,
  groupedShortcuts,
  isMacPlatform,
  type Shortcut,
} from "../shortcuts/registry"
import { IconButton } from "./icon-button"
import { CircleQuestionMarkIcon16, XIcon16 } from "./icons"
import { Markdown } from "./markdown"
import { Details } from "./details"
import { HoverCard } from "./hover-card"
import { SearchInput } from "./search-input"

function HelpSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 p-4">
      <Details>
        <Details.Summary>{title}</Details.Summary>
        <ul className="flex flex-col gap-1">{children}</ul>
      </Details>
    </div>
  )
}

function HelpItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between h-8 group-data-[size=medium]/help:h-10 gap-3 *:first:min-w-0 *:first:truncate *:last:shrink-0">
      {children}
    </li>
  )
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <div className="flex items-center gap-0.5">
      {keys.map((key) => (
        <kbd
          key={key}
          className="min-w-[22px] font-[inherit] rounded-sm bg-bg-secondary p-1 text-center font-body leading-none text-text-secondary shadow-[inset_0_-1px_0_var(--color-border-secondary)] dark:shadow-[inset_0_1px_0_var(--color-border-secondary),0_1px_2px_-1px_var(--color-bg)] epaper:shadow-none"
        >
          {key}
        </kbd>
      ))}
    </div>
  )
}

/** An entry's combos: the primary one, then alternates separated by "/". */
function ShortcutKeys({ shortcut, isMac }: { shortcut: Shortcut; isMac: boolean }) {
  return (
    <div className="flex items-center gap-1">
      {shortcut.combos.map((combo, index) => (
        <Fragment key={combo}>
          {index > 0 ? <span className="text-text-tertiary text-sm">/</span> : null}
          <Keys keys={formatCombo(combo, isMac)} />
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The complete shortcut reference, rendered from the shortcut registry
 * (`src/shortcuts/registry.ts`) — every binding in the app, grouped and
 * filterable. Opened with `?` (or ⌘/, which toggles the whole help panel).
 */
function ShortcutReference() {
  const [filter, setFilter] = useState("")
  const isMac = isMacPlatform()
  const groups = useMemo(() => groupedShortcuts(filter, isMac), [filter, isMac])
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-text-secondary">Keyboard shortcuts</h2>
        <Keys keys={["?"]} />
      </div>
      <SearchInput placeholder="Filter shortcuts…" value={filter} onChange={setFilter} />
      {groups.length === 0 ? (
        <div className="text-text-secondary">No shortcuts match your filter</div>
      ) : null}
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <h3 className="font-sans text-sm font-medium text-text-secondary">{group.title}</h3>
          <ul className="flex flex-col gap-1">
            {group.shortcuts.map((shortcut) => (
              <HelpItem key={`${group.title}:${shortcut.description}`}>
                <span>{shortcut.description}</span>
                <ShortcutKeys shortcut={shortcut} isMac={isMac} />
              </HelpItem>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <HelpItem>
      <a href={href} target="_blank" rel="noopener noreferrer" className="link link-external">
        {children}
      </a>
    </HelpItem>
  )
}

function MarkdownSyntaxItem({ syntax }: { syntax: string }) {
  return (
    <li className="flex flex-col gap-1 py-2">
      <code className="text-text-secondary">{syntax}</code>
      <Markdown>{syntax}</Markdown>
    </li>
  )
}

function HelpContent({
  onClose,
  size = "small",
}: {
  onClose: () => void
  size?: "small" | "medium"
}) {
  return (
    <HoverCard.Provider container={null}>
      <div className="grid grid-rows-[auto_1fr] overflow-hidden h-full group/help" data-size={size}>
        <header className="flex items-center gap-2 px-2 py-2">
          <div className="flex w-0 grow items-center gap-3 px-2">
            <CircleQuestionMarkIcon16 className="shrink-0 text-text-secondary" />
            <div className="truncate">Help</div>
          </div>
          <IconButton
            aria-label="Close"
            shortcut={formatCombo(APP_SHORTCUTS.helpPanel)}
            size={size}
            onClick={onClose}
          >
            <XIcon16 />
          </IconButton>
        </header>

        <div className="overflow-auto scroll-mask grid content-start divide-y divide-border-secondary">
          <HelpSection title="Links">
            <HelpLink href="https://github.com/finnformica/ruminate/issues/new">
              Send feedback
            </HelpLink>
            <HelpLink href="https://github.com/finnformica/ruminate/blob/main/CHANGELOG.md">
              Changelog
            </HelpLink>
            <HelpLink href="https://github.com/finnformica/ruminate">GitHub</HelpLink>
          </HelpSection>

          <ShortcutReference />

          <HelpSection title="Formatting">
            <MarkdownSyntaxItem syntax="# Heading 1" />
            <MarkdownSyntaxItem syntax="## Heading 2" />
            <MarkdownSyntaxItem syntax="_Italic_" />
            <MarkdownSyntaxItem syntax="**Bold**" />
            <MarkdownSyntaxItem syntax="~~Strikethrough~~" />
            <MarkdownSyntaxItem syntax="`Code`" />
            <MarkdownSyntaxItem syntax="[Link](https://example.com)" />
            <MarkdownSyntaxItem syntax="- Unordered list" />
            <MarkdownSyntaxItem syntax="1. Ordered list" />
            <MarkdownSyntaxItem syntax="- [ ] Unchecked" />
            <MarkdownSyntaxItem syntax="- [x] Checked" />
            <MarkdownSyntaxItem syntax="> Blockquote" />
            <MarkdownSyntaxItem syntax="$$LaTeX^{math}$$" />
            <MarkdownSyntaxItem syntax="---" />
            <MarkdownSyntaxItem syntax="[[id|Note link]]" />
            <MarkdownSyntaxItem syntax="[[2024-07-11]]" />
            <MarkdownSyntaxItem syntax="[[2024-W28]]" />
            <MarkdownSyntaxItem syntax="#tag" />
          </HelpSection>
        </div>
      </div>
    </HoverCard.Provider>
  )
}

export function HelpSidebar() {
  const [, setHelpPanel] = useAtom(isHelpPanelOpenAtom)
  return (
    <div className="grid grid-rows-[1fr] overflow-hidden h-full">
      <HelpContent onClose={() => setHelpPanel(false)} />
    </div>
  )
}

export function HelpDrawer() {
  const [isOpen, setIsOpen] = useAtom(isHelpPanelOpenAtom)
  return (
    <Drawer.Root open={isOpen} onOpenChange={setIsOpen} shouldScaleBackground={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-linear-to-t from-[#000000] to-[#00000000] epaper:bg-none" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 flex h-[80%] flex-col bg-bg-overlay epaper:ring-2 epaper:ring-border rounded-t-xl outline-none">
          <Drawer.Title className="sr-only">Help</Drawer.Title>
          <div className="flex-1 overflow-hidden">
            <HelpContent onClose={() => setIsOpen(false)} size="medium" />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
