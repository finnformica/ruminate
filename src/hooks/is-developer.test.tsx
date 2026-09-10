// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { atom, createStore, Provider } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return {
    githubUserAtom: atom<{ email: string } | null>(null),
    graphSnapshotAtom: atom({ nodes: new Map(), childLinks: new Map() }),
  }
})

import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { githubUserAtom, graphSnapshotAtom } from "../global-state"
import {
  upstreamIndexAtom,
  developerDebugAtom,
  developerDebugPreferenceAtom,
  isDeveloperEmail,
  isDeveloperUser,
  useDeveloperDebug,
  useIsDeveloper,
} from "./is-developer"

const DEVELOPER = "finnformica@gmail.com"
const userAtom = githubUserAtom as unknown as ReturnType<typeof atom<{ email: string } | null>>

function setup(user: { email: string } | null) {
  const store = createStore()
  store.set(userAtom, user)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { store, wrapper }
}

describe("isDeveloperEmail", () => {
  it("matches the developer's email, ignoring case and whitespace", () => {
    expect(isDeveloperEmail(DEVELOPER)).toBe(true)
    expect(isDeveloperEmail("  FinnFormica@Gmail.com ")).toBe(true)
  })

  it("matches GitHub's private-email alias by id or login", () => {
    expect(isDeveloperEmail("42536816+finnformica@users.noreply.github.com")).toBe(true)
    expect(isDeveloperEmail("42536816+renamed@users.noreply.github.com")).toBe(true)
    expect(isDeveloperEmail("1+finnformica@users.noreply.github.com")).toBe(true)
    expect(isDeveloperEmail("1+someone@users.noreply.github.com")).toBe(false)
  })

  it("rejects everyone else, including no email at all", () => {
    expect(isDeveloperEmail("someone@example.com")).toBe(false)
    expect(isDeveloperEmail("finnformica@gmail.com.evil.com")).toBe(false)
    expect(isDeveloperEmail("")).toBe(false)
    expect(isDeveloperEmail(null)).toBe(false)
    expect(isDeveloperEmail(undefined)).toBe(false)
  })
})

describe("isDeveloperUser", () => {
  it("accepts the developer's GitHub id, login, or email on their own", () => {
    expect(isDeveloperUser({ id: 42536816, login: "x", email: "x@example.com" })).toBe(true)
    expect(isDeveloperUser({ login: "FinnFormica", email: "x@example.com" })).toBe(true)
    expect(isDeveloperUser({ email: DEVELOPER })).toBe(true)
  })

  it("rejects other accounts and no account", () => {
    expect(isDeveloperUser({ id: 1, login: "someone", email: "someone@example.com" })).toBe(false)
    expect(isDeveloperUser(null)).toBe(false)
    expect(isDeveloperUser(undefined)).toBe(false)
  })
})

describe("useIsDeveloper", () => {
  it("is true only for the developer's signed-in account", () => {
    const dev = setup({ email: DEVELOPER })
    expect(renderHook(() => useIsDeveloper(), { wrapper: dev.wrapper }).result.current).toBe(true)

    const other = setup({ email: "someone@example.com" })
    expect(renderHook(() => useIsDeveloper(), { wrapper: other.wrapper }).result.current).toBe(
      false,
    )

    const signedOut = setup(null)
    expect(renderHook(() => useIsDeveloper(), { wrapper: signedOut.wrapper }).result.current).toBe(
      false,
    )
  })
})

describe("useDeveloperDebug", () => {
  it("returns the stored toggles for the developer", () => {
    const { store, wrapper } = setup({ email: DEVELOPER })
    store.set(developerDebugPreferenceAtom, { blockIds: true, blockMetadata: false })
    expect(renderHook(() => useDeveloperDebug(), { wrapper }).result.current).toEqual({
      blockIds: true,
      blockMetadata: false,
    })
  })

  it("is all-off for anyone else, whatever is stored", () => {
    const { store, wrapper } = setup({ email: "someone@example.com" })
    store.set(developerDebugPreferenceAtom, { blockIds: true, blockMetadata: true })
    expect(renderHook(() => useDeveloperDebug(), { wrapper }).result.current).toEqual({
      blockIds: false,
      blockMetadata: false,
    })
    // And the derived atom reads the same way outside React.
    expect(store.get(developerDebugAtom)).toEqual({ blockIds: false, blockMetadata: false })
  })

  it("fills in flags missing from an older stored preference", () => {
    const { store, wrapper } = setup({ email: DEVELOPER })
    store.set(developerDebugPreferenceAtom, { blockIds: true } as never)
    expect(renderHook(() => useDeveloperDebug(), { wrapper }).result.current).toEqual({
      blockIds: true,
      blockMetadata: false,
    })
  })
})

describe("upstreamIndexAtom", () => {
  it("indexes the corpus only while block metadata is on", () => {
    const { store } = setup({ email: DEVELOPER })
    const a = docToGraph("blk_notea", "- shared\n  id:: blk_shared0000\n", 1)
    const b = docToGraph("blk_noteb", "- shared\n  id:: blk_shared0000\n", 1)
    store.set(
      graphSnapshotAtom as never,
      buildGraphSnapshot([...a.nodes, ...b.nodes], [...a.links, ...b.links]) as never,
    )
    expect(store.get(upstreamIndexAtom)).toBeNull()

    store.set(developerDebugPreferenceAtom, { blockIds: false, blockMetadata: true })
    expect(store.get(upstreamIndexAtom)?.get("blk_shared0000")).toEqual(["blk_notea", "blk_noteb"])
  })
})
