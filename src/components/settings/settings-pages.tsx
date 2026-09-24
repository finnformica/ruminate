import { Link, useLocation } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { useFeature, useIsAdmin } from "../../data/features"
import type { FeatureKey } from "../../data/feature-flags"
import { githubUserAtom } from "../../global-state"
import { DeletedNotesSection } from "../deleted-notes-section"
import { ArrowLeftIcon16, ChevronLeftIcon16, ChevronRightIcon16 } from "../icons"
import { McpTokensSection } from "../mcp-tokens-section"
import { SharingSection } from "../sharing-section"
import { AboutSection } from "./about-section"
import { AccountSection } from "./account-section"
import { AppearanceSection } from "./appearance-section"
import { EditorSection } from "./editor-section"
import { FeaturesSection } from "./features-section"
import { InvitesSection } from "./invites-section"
import { StorageSection } from "./storage-section"
import { UpdatesSection } from "./updates-section"

/**
 * The settings, one page per subject, in the order the settings nav lists
 * them. A page holds every card about its subject — the account's name and
 * sign-in; how the app looks and the editor behaves; the notes shared and
 * received; and so on — so a subject is one place, and the list stays short.
 * The admin's page is the bootstrap owner's alone, as the server says, and
 * sits apart at the foot of the list.
 *
 * `/settings` itself is the list on a phone and a redirect to the first page
 * on a wider screen, where the sidebar lists the pages.
 */
export type SettingsPageId =
  "account" | "preferences" | "sharing" | "mcp" | "data" | "about" | "admin"

export interface SettingsPage {
  id: SettingsPageId
  label: string
  /** The line under the page's heading, and under its row on a phone. */
  description: string
  /** Listed only while this account may use the feature. */
  feature?: FeatureKey
  /** Listed only signed in. */
  signedIn?: boolean
  /** Listed for the admin alone, apart from the rest. */
  admin?: boolean
}

const SETTINGS_PAGES: SettingsPage[] = [
  {
    id: "account",
    label: "Account",
    description: "The GitHub account you sign in with.",
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Theme and accent colour, how notes open, and what's new.",
  },
  {
    id: "sharing",
    label: "Sharing",
    description: "The notes you have shared, and the ones shared with you.",
    feature: "sharing",
    signedIn: true,
  },
  {
    id: "mcp",
    label: "MCP access",
    description: "Tokens that let an agent read or write your notes.",
    feature: "mcp",
    signedIn: true,
  },
  {
    id: "data",
    label: "Data",
    description: "The local database, cloud sync, and recently deleted notes.",
  },
  { id: "about", label: "About", description: "Version and credits." },
  {
    id: "admin",
    label: "Admin",
    description: "Feature flags, and the invites that admit people.",
    admin: true,
  },
]

export const isSettingsPageId = (id: string): id is SettingsPageId =>
  SETTINGS_PAGES.some((page) => page.id === id)

/**
 * A page's cards, in order. A card that needs a sign-in is not drawn without
 * one (the preferences follow the account; Recently deleted reads the local
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
          {githubUser ? <UpdatesSection /> : null}
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

/** The pages this reader is shown, with the ones they may not use left out. */
function useSettingsPages(): SettingsPage[] {
  const githubUser = useAtomValue(githubUserAtom)
  const isAdmin = useIsAdmin()
  const sharing = useFeature("sharing")
  const mcp = useFeature("mcp")
  const features: Record<FeatureKey, boolean> = { sharing, mcp }
  return SETTINGS_PAGES.filter(
    (page) =>
      (!page.signedIn || githubUser) &&
      (!page.admin || isAdmin) &&
      (!page.feature || features[page.feature]),
  )
}

/** The page the address names, if any. */
export function useCurrentSettingsPage(): SettingsPage | undefined {
  const { pathname } = useLocation()
  return SETTINGS_PAGES.find((entry) => entry.id === pathname.split("/")[2])
}

/**
 * The sidebar while Settings is open (src/components/sidebar.tsx): the pages
 * in place of the notes, which are not what anyone is here for, with a way
 * back above them. Rows in the sidebar's own recipe (`.nav-item`), so the
 * sidebar reads as one thing that changed its contents rather than two;
 * the admin's page is set off beneath a rule, the sidebar's own way of
 * setting a row apart.
 */
export function SettingsNavItems() {
  const pages = useSettingsPages()
  return (
    <nav aria-label="Settings" className="flex flex-col gap-1">
      <Link to="/" search={{ query: undefined }} className="nav-item text-text-secondary">
        <ArrowLeftIcon16 className="shrink-0" />
        <span className="truncate">Back to notes</span>
      </Link>
      <div className="flex flex-col gap-1 border-t border-border-secondary pt-3">
        <span className="flex h-6 items-center px-2 text-sm text-text-secondary coarse:px-3">
          Settings
        </span>
        <SettingsNavRows pages={pages.filter((page) => !page.admin)} />
      </div>
      {pages.some((page) => page.admin) ? (
        <div className="mt-1 border-t border-border-secondary pt-2">
          <SettingsNavRows pages={pages.filter((page) => page.admin)} />
        </div>
      ) : null}
    </nav>
  )
}

function SettingsNavRows({ pages }: { pages: SettingsPage[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {pages.map((page) => (
        <li key={page.id}>
          <Link
            to="/settings/$page"
            params={{ page: page.id }}
            className="nav-item"
            activeOptions={{ exact: true }}
          >
            <span className="truncate">{page.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * The same pages as a list of rows, for a phone, where there is no room for
 * a column beside the page: each row is a page, with its description under
 * its name and a chevron at its end, in the size the phone's drawer uses.
 */
export function SettingsIndexList() {
  const pages = useSettingsPages()
  return (
    <div className="flex flex-col gap-1">
      <SettingsIndexRows pages={pages.filter((page) => !page.admin)} />
      {pages.some((page) => page.admin) ? (
        <div className="mt-2 border-t border-border-secondary pt-3">
          <SettingsIndexRows pages={pages.filter((page) => page.admin)} />
        </div>
      ) : null}
    </div>
  )
}

function SettingsIndexRows({ pages }: { pages: SettingsPage[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {pages.map((page) => (
        <li key={page.id}>
          <Link
            to="/settings/$page"
            params={{ page: page.id }}
            className="nav-item h-auto! py-2"
            data-size="large"
          >
            <span className="flex w-0 grow flex-col gap-0.5">
              <span className="truncate leading-5">{page.label}</span>
              <span className="line-clamp-2 text-sm leading-4 text-text-secondary">
                {page.description}
              </span>
            </span>
            <ChevronRightIcon16 className="shrink-0 text-text-tertiary" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * One settings page's column: its heading and the line under it, then its
 * cards. On a phone, where the page stands alone, a way back to the list
 * above the heading.
 */
export function SettingsPageBody({
  page,
  children,
}: {
  page: SettingsPage
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          to="/settings"
          className="link -ml-1 inline-flex items-center gap-1 self-start text-sm text-text-secondary no-underline sm:hidden"
        >
          <ChevronLeftIcon16 />
          All settings
        </Link>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold leading-6">{page.label}</h2>
          <p className="leading-5 text-text-secondary">{page.description}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

/** The page named by its id — for a route to look itself up. */
export function settingsPage(id: SettingsPageId): SettingsPage {
  const page = SETTINGS_PAGES.find((entry) => entry.id === id)
  if (!page) throw new Error(`No settings page ${id}`)
  return page
}
