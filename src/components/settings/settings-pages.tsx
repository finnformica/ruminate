import { Link, useLocation } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { useFeature, useIsAdmin } from "../../data/features"
import type { FeatureKey } from "../../data/feature-flags"
import { githubUserAtom } from "../../global-state"
import { cx } from "../../utils/cx"
import { ChevronLeftIcon16, ChevronRightIcon16 } from "../icons"

/**
 * The settings, one page each, in the order the settings nav lists them —
 * grouped by what a page is *about*: the account (it follows the sign-in,
 * wherever it is used), this device (theme, editor and storage are the
 * browser's, and set again on the next one), and the admin's (the bootstrap
 * owner's alone, as the server says).
 *
 * `/settings` itself is the list on a phone and a redirect to the first page
 * on a wider screen, where the list is a column beside the page.
 */
export type SettingsPageId =
  | "account"
  | "sharing"
  | "mcp"
  | "appearance"
  | "editor"
  | "data"
  | "features"
  | "invites"
  | "about"

export interface SettingsPage {
  id: SettingsPageId
  label: string
  /** The line under the page's heading, and under its row on a phone. */
  description: string
  /** Listed only while this account may use the feature. */
  feature?: FeatureKey
  /** Listed only signed in. */
  signedIn?: boolean
  /** Listed for the admin alone. */
  admin?: boolean
}

export interface SettingsGroup {
  /** No heading for the group of one at the end. */
  heading: string | null
  pages: SettingsPage[]
}

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    heading: "Account",
    pages: [
      {
        id: "account",
        label: "Account",
        description: "Your name, your email address and how you sign in.",
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
    ],
  },
  {
    heading: "This device",
    pages: [
      { id: "appearance", label: "Appearance", description: "Theme and accent colour." },
      {
        id: "editor",
        label: "Editor",
        description: "How a note opens, and what a new block starts as.",
      },
      {
        id: "data",
        label: "Data",
        description: "The local database, cloud sync, and recently deleted notes.",
      },
    ],
  },
  {
    heading: "Admin",
    pages: [
      {
        id: "features",
        label: "Feature flags",
        description: "Who may use each feature.",
        admin: true,
      },
      { id: "invites", label: "Invites", description: "The links that admit people.", admin: true },
    ],
  },
  {
    heading: null,
    pages: [{ id: "about", label: "About", description: "Version and credits." }],
  },
]

const settingsPagePath = (id: SettingsPageId) => `/settings/${id}` as const

/** The groups this reader is shown, with the pages they may not use left out. */
function useSettingsGroups(): SettingsGroup[] {
  const githubUser = useAtomValue(githubUserAtom)
  const isAdmin = useIsAdmin()
  const sharing = useFeature("sharing")
  const mcp = useFeature("mcp")
  const features: Record<FeatureKey, boolean> = { sharing, mcp }
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    pages: group.pages.filter(
      (page) =>
        (!page.signedIn || githubUser) &&
        (!page.admin || isAdmin) &&
        (!page.feature || features[page.feature]),
    ),
  })).filter((group) => group.pages.length > 0)
}

/** The page the address names, if any. */
export function useCurrentSettingsPage(): SettingsPage | undefined {
  const { pathname } = useLocation()
  const id = pathname.split("/")[2]
  for (const group of SETTINGS_GROUPS) {
    const page = group.pages.find((entry) => entry.id === id)
    if (page) return page
  }
  return undefined
}

/**
 * The settings nav: the column beside the page on a wide screen. Rows in the
 * sidebar's own recipe (`.nav-item`), grouped under quiet headings, so it
 * reads as the sidebar's continuation rather than a second kind of list.
 */
export function SettingsNav({ className }: { className?: string }) {
  const groups = useSettingsGroups()
  return (
    <nav aria-label="Settings" className={cx("flex flex-col gap-4", className)}>
      {groups.map((group, index) => (
        <div key={group.heading ?? index} className="flex flex-col gap-1">
          {group.heading ? (
            <span className="flex h-6 items-center px-2 text-sm text-text-secondary">
              {group.heading}
            </span>
          ) : null}
          <ul className="flex flex-col gap-1">
            {group.pages.map((page) => (
              <li key={page.id}>
                <Link
                  to={settingsPagePath(page.id)}
                  className="nav-item"
                  activeOptions={{ exact: true }}
                >
                  <span className="truncate">{page.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/**
 * The same pages as a list of rows, for a phone, where there is no room for
 * a column beside the page: each row is a page, with its description under
 * its name and a chevron at its end, in the size the phone's drawer uses.
 */
export function SettingsIndexList() {
  const groups = useSettingsGroups()
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group, index) => (
        <div key={group.heading ?? index} className="flex flex-col gap-1">
          {group.heading ? (
            <span className="flex h-6 items-center px-3 text-sm text-text-secondary">
              {group.heading}
            </span>
          ) : null}
          <ul className="flex flex-col gap-1">
            {group.pages.map((page) => (
              <li key={page.id}>
                <Link
                  to={settingsPagePath(page.id)}
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
        </div>
      ))}
    </div>
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
  for (const group of SETTINGS_GROUPS) {
    const page = group.pages.find((entry) => entry.id === id)
    if (page) return page
  }
  throw new Error(`No settings page ${id}`)
}
