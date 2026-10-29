// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockType } from "../blocks/types"
import type { Note } from "../schema"

// The sidebar sits inside the router and the whole global-state machine. Only
// the pieces the Pinned list needs are real here: the graph (a pin is a prop
// on it) and the list's entries. Everything the surrounding chrome wants is
// stubbed.
const mocks = vi.hoisted(() => ({
  pathname: "/",
  navigate: vi.fn(),
  // The page the router is on (`useOpenFramesInPane`): none, or a split
  // note page (`onSplitPage`).
  matches: [] as unknown[],
}))

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to?: string }) => (
    <a href={to ?? "#"} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({
    history: { back: vi.fn(), forward: vi.fn() },
    state: { matches: mocks.matches },
  }),
}))
vi.mock("../hooks/note", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/note")>()),
  useNoteById: () => undefined,
  useRenameNote: () => vi.fn(),
  useDeleteNote: () => vi.fn(),
  useSetNoteProps: () => vi.fn(),
}))
vi.mock("../hooks/share", () => ({ useNoteShare: () => null }))
vi.mock("../data/features", () => ({ useIsAdmin: () => false, useFeature: () => false }))
vi.mock("../data/store", () => ({ useApplyOps: () => () => {} }))
vi.mock("../hooks/app-update", async () => {
  const { atom } = await import("jotai")
  return { appUpdateAtom: atom({ needRefresh: false, apply: () => {} }) }
})
vi.mock("./sync-status", () => ({
  SyncStatusIcon: () => null,
  useSyncStatusText: () => null,
  useSyncStatusMeta: () => ({ action: null, tooltip: null }),
}))

vi.mock("../global-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("../global-state")>()
  const { atom } = await import("jotai")
  const { buildGraphSnapshot } = await import("../data/graph")
  return {
    ...original,
    graphSnapshotAtom: atom(buildGraphSnapshot([], [])),
    isBootingAtom: atom(false),
    isSignedOutAtom: atom(false),
    // Derived from the graph in the real module; a plain writable atom
    // here, so a test can state the rows and be about the list.
    pinnedEntriesAtom: atom([]),
    sharedNotesAtom: atom([]),
  }
})

import { graphSnapshotAtom, pinnedEntriesAtom, sharedNotesAtom } from "../global-state"
import { buildGraphSnapshot } from "../data/graph"
import { layoutFromSearch, layoutToSearch, type PaneLayout } from "../data/panes"
import { isRootFrame, rootFrame } from "../data/root-frame"
import { NavItems } from "./nav-items"

const noteOf = (id: string, name: string): Note =>
  ({
    id,
    type: "note",
    displayName: name,
    title: name,
    props: {},
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  }) as Note

afterEach(cleanup)
beforeEach(() => {
  mocks.pathname = "/"
  mocks.navigate.mockReset()
  mocks.matches = []
})

type PinnedBlockRow = { id: string; noteId: string; text: string; type: BlockType; note: Note }

function renderSidebar({
  notes,
  blocks = [],
  shared = [],
}: {
  notes: Note[]
  /** The pinned blocks, listed after the notes. */
  blocks?: PinnedBlockRow[]
  shared?: Note[]
}) {
  const store = createStore()
  // Every row here is pinned: its node carries the prop, as the real list's.
  const pinned = JSON.stringify({ pinned_at: 1 })
  store.set(
    graphSnapshotAtom as never,
    buildGraphSnapshot(
      [...notes, ...blocks].map((row) => ({
        id: row.id,
        type: "note",
        text: "",
        props: pinned,
        updated_at: 0,
      })),
      [],
    ) as never,
  )
  store.set(
    pinnedEntriesAtom as never,
    [
      ...notes.map((note) => ({ kind: "note", id: note.id, noteId: note.id, note })),
      ...blocks.map((block) => ({ kind: "block", id: block.id, noteId: block.noteId, block })),
    ] as never,
  )
  store.set(
    sharedNotesAtom as never,
    shared.map((note) => ({
      note,
      share: { owner: { login: "octocat", name: "Octo" }, permissions: ["read"] },
    })) as never,
  )
  render(
    <Provider store={store}>
      <NavItems />
    </Provider>,
  )
  return store
}

/** The Pinned list's rows — the top nav is a list of its own. */
const pinnedRows = () => within(screen.getByTestId("pinned-rows")).getAllByRole("listitem")

/** The rows' names, in the order drawn — the label alone, without the
 * glyph a block row leads with. */
const rowNames = () =>
  pinnedRows().map((li) => li.querySelector(".nav-item .truncate")?.textContent?.trim() ?? "")

/** The section headings, in order. */
const headings = () => screen.getAllByTestId("section-heading").map((el) => el.textContent?.trim())

const THREE = [noteOf("a", "Alpha"), noteOf("b", "Bravo"), noteOf("c", "Charlie")]
const BLOCK: PinnedBlockRow = {
  id: "blk_x",
  noteId: "a",
  text: "A pinned block",
  type: "ul",
  note: THREE[0],
}

describe("the sidebar's Pinned list", () => {
  it("is the pinned notes and blocks under one heading", () => {
    renderSidebar({ notes: THREE, blocks: [BLOCK] })
    expect(headings()).toEqual(["Pinned"])
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie", "A pinned block"])
  })

  it("is not there with nothing pinned: Notes is the list of every note", () => {
    renderSidebar({ notes: [] })
    expect(screen.queryByTestId("pinned-rows")).toBeNull()
    expect(screen.queryAllByTestId("section-heading")).toEqual([])
  })

  it("lists what other people shared apart, beneath it", () => {
    renderSidebar({ notes: THREE, shared: [noteOf("s", "Shared one")] })
    expect(headings()).toEqual(["Pinned", "Shared"])
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"])
    expect(screen.getByText("Shared one")).toBeTruthy()
  })

  it("leads with Notes, the list of every note, reached by g then v — and no Views", () => {
    renderSidebar({ notes: THREE })
    const links = screen.getAllByRole("link")
    expect(links[0].textContent).toMatch(/^Notes/)
    expect(links[0].getAttribute("href")).toBe("/notes/$")
    expect(links[0].textContent?.toUpperCase()).toContain("V")
    expect(screen.queryByText("Views")).toBeNull()
  })

  it("has no sort menu and no drag: the order is the pins'", () => {
    renderSidebar({ notes: THREE, blocks: [BLOCK] })
    expect(screen.queryByRole("button", { name: /^Sort/ })).toBeNull()
    for (const row of pinnedRows()) expect(row.getAttribute("draggable")).toBeNull()
  })

  it("a pinned note's ⋯ offers Unpin", async () => {
    renderSidebar({ notes: [THREE[0]] })
    fireEvent.click(within(pinnedRows()[0]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: /Views/ })).toBeNull()
  })

  it("a pinned block's ⋯ is the block's menu — Copy, Copy link, Share, Rename, Unpin", async () => {
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    fireEvent.click(within(pinnedRows()[1]).getByRole("button", { name: "Pinned block actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "Copy",
      "Copy link to block",
      "Share",
      "Rename",
      "Unpin",
    ])
    // Every item leads with an icon, as the note's menu does.
    expect(items.every((item) => item.querySelector("svg") !== null)).toBe(true)
  })

  it("opens the row's menu on a right-click too, so a pin is managed where it is listed", async () => {
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    fireEvent.contextMenu(within(pinnedRows()[1]).getByRole("link"))
    const menu = await screen.findByTestId("row-context-menu")
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
    expect(items).toContain("Rename")
    expect(items).toContain("Unpin")
  })

  it("a block row opens its note focused on it", () => {
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    const link = within(pinnedRows()[1]).getByRole("link")
    expect(link.getAttribute("href")).toBe("/notes/$")
    expect(link.getAttribute("title")).toBe("Alpha › A pinned block")
  })

  it("draws a note row's icon and a block row's glyph through the same slot, neither tinted", () => {
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    const icons = pinnedRows().map((row) =>
      row.querySelector(".nav-item .nav-item-icon:not(.hidden)"),
    )
    expect(icons.every((icon) => icon !== null)).toBe(true)
    // A favicon NAMES the row, and so does the marker glyph on a block's:
    // both lean with the label when the row is current. Nothing reports a
    // state any more.
    for (const icon of icons) expect(icon!.className).not.toContain("nav-item-tint")
    // The note's favicon is an icon; the block's slot holds its KEY — the
    // editor's own (a bullet's dot), never a markdown dash of the list's.
    expect(icons[0]!.querySelector("svg")).not.toBeNull()
    expect(icons[1]!.querySelector("[data-key]")?.getAttribute("data-key")).toBe("ul")
    expect(icons[1]!.querySelector(".block-glyph-fill")).not.toBeNull()
  })

  it("leads a block row with the block's key, as the editor draws it, whatever its type", () => {
    const rows: PinnedBlockRow[] = [
      { ...BLOCK, id: "blk_todo", type: "todo" },
      { ...BLOCK, id: "blk_h2", type: "h2" },
      { ...BLOCK, id: "blk_ol", type: "ol" },
      { ...BLOCK, id: "blk_text", type: "text" },
      { ...BLOCK, id: "blk_code", type: "code" },
    ]
    renderSidebar({ notes: [], blocks: rows })
    const keys = pinnedRows().map((row) =>
      row.querySelector(".nav-item-icon:not(.hidden) [data-key]")!,
    )
    // A to-do's box, a heading's #, a number, a pilcrow — the keys the
    // block's row in its note carries.
    expect(keys[0].querySelector(".block-checkbox")).not.toBeNull()
    expect(keys[1].textContent).toBe("#")
    expect(keys[2].textContent).toBe("1.")
    expect(keys[3].textContent).toBe("¶")
    // A figure has no key (its frame is its mark), so its row says what it
    // is in markdown.
    expect(keys[4].textContent).toBe("```")
  })

  it("lights the note's row only at the note's root, and the block's only focused on it", () => {
    mocks.pathname = "/notes/a"
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    // The Calendar link reads the path the same way the note page does.
    expect(screen.getByRole("link", { name: /Calendar/ }).getAttribute("aria-current")).toBeNull()
  })
})

describe("the sidebar while Settings is open", () => {
  it("keeps the links above and the rows below, and lists the pages in the Pinned list's place", () => {
    mocks.pathname = "/settings/preferences"
    renderSidebar({ notes: THREE, shared: [noteOf("shared", "Theirs")] })
    // The chrome every page has.
    expect(screen.getByRole("link", { name: /^Notes/ })).toBeTruthy()
    expect(screen.getByRole("link", { name: /^Calendar/ })).toBeTruthy()
    // Settings is marked on any of its pages, exactly as Help is while
    // open: pressed, not current.
    expect(screen.getByRole("link", { name: /^Settings/ }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    expect(screen.getByRole("link", { name: /^Changelog/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /^Help/ })).toBeTruthy()
    // The pages, where the pins were — and no way back, since Notes is
    // right there above them.
    const headings = screen.getAllByTestId("section-heading").map((el) => el.textContent)
    expect(headings).toEqual(["Settings"])
    expect(screen.queryByTestId("pinned-rows")).toBeNull()
    expect(screen.queryByText("Theirs")).toBeNull()
    expect(screen.queryByText("Back to notes")).toBeNull()
    for (const page of ["Account", "Preferences", "About"]) {
      expect(screen.getByRole("link", { name: page })).toBeTruthy()
    }
    // Not this reader's: Sharing and Data (signed out), MCP access (no
    // feature is on here) and Admin.
    expect(screen.queryByRole("link", { name: "Sharing" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Data" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull()
  })

  it("lists the pins again once Settings is left", () => {
    mocks.pathname = "/"
    renderSidebar({ notes: THREE })
    expect(screen.getByTestId("pinned-rows")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Account" })).toBeNull()
    expect(screen.getByRole("link", { name: /^Settings/ }).getAttribute("aria-pressed")).toBeNull()
  })
})

describe("a sidebar row's actions", () => {
  it("keep their box while out of sight, so a closing menu keeps its anchor", () => {
    // The menu fades out after its trigger has dropped `data-popup-open`.
    // A wrapper that went `display: none` then would take the anchor with
    // it, and the fading menu would snap to the page's corner (RowActions).
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    for (const row of pinnedRows()) {
      const wrapper = within(row).getByRole("button").parentElement!
      expect(wrapper.className).not.toContain("hidden")
      expect(wrapper.className).toContain("opacity-0")
      expect(wrapper.className).toContain("has-data-[popup-open]:opacity-100")
    }
  })
})

describe("the sidebar's bottom block", () => {
  it("names the changelog Changelog, and gives it a chord", () => {
    renderSidebar({ notes: THREE })
    const changelog = screen.getByRole("link", { name: /Changelog/ })
    expect(changelog.textContent).toContain("Changelog")
    expect(changelog.textContent).not.toContain("What's new")
    expect(changelog.textContent?.toUpperCase()).toContain("C")
  })
})

describe("a shared note's row in a split", () => {
  /** The router on a note page with `layout` in its URL. */
  const onSplitPage = (layout: PaneLayout) => {
    const { noteId, search } = layoutToSearch(layout)
    mocks.matches = [{ routeId: "/_appRoot/notes_/$", params: { _splat: noteId }, search }]
  }

  it("restarts the stack of the pane with the keyboard: Root › the note, the other pane as it is", () => {
    // The left pane on Alpha; the right pane, with the keyboard, two frames deep in Bravo.
    onSplitPage({
      panes: [
        { frames: [rootFrame(), { noteId: "a", root: null, selected: null }] },
        {
          frames: [
            rootFrame(),
            { noteId: "b", root: null, selected: null },
            { noteId: "b", root: "blk_b1", selected: null },
          ],
        },
      ],
      active: 1,
    })
    renderSidebar({ notes: THREE, shared: [noteOf("s", "Shared one")] })
    fireEvent.click(screen.getByText("Shared one"))
    const { params, search } = mocks.navigate.mock.lastCall![0]
    const layout = layoutFromSearch(params._splat, search)
    const stackOf = (frames: PaneLayout["panes"][number]["frames"]) =>
      frames.map((f) => (isRootFrame(f) ? "Root" : (f.root ?? f.noteId)))
    expect(layout.panes.map((pane) => stackOf(pane.frames))).toEqual([
      ["Root", "a"],
      ["Root", "s"],
    ])
    expect(layout.active).toBe(1)
  })
})
