// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearMarkdownFilesCache,
  getMarkdownFilesCache,
  setMarkdownFilesCache,
  storageWarningAtom,
} from "./markdown-cache"

const store = getDefaultStore()

beforeEach(() => {
  window.localStorage.clear()
  store.set(storageWarningAtom, null)
})
afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("markdown files cache", () => {
  it("round-trips files through localStorage", () => {
    setMarkdownFilesCache({ "a.md": "alpha", "b.md": "beta" })
    expect(getMarkdownFilesCache()).toEqual({ "a.md": "alpha", "b.md": "beta" })
    clearMarkdownFilesCache()
    expect(getMarkdownFilesCache()).toBeNull()
  })

  it("returns null for absent or malformed cache (reads fall through to the fs walk)", () => {
    expect(getMarkdownFilesCache()).toBeNull()
    window.localStorage.setItem("markdown_files", "not json")
    expect(getMarkdownFilesCache()).toBeNull()
    window.localStorage.setItem("markdown_files", JSON.stringify({ "a.md": 42 }))
    expect(getMarkdownFilesCache()).toBeNull()
  })

  it("degrades to fs-only on quota: no crash, cache cleared, one-time warning set", () => {
    // A stale cache exists from before the quota hit…
    setMarkdownFilesCache({ "a.md": "old cached value" })
    expect(getMarkdownFilesCache()).not.toBeNull()

    // Spy on the prototype: assigning a property directly to a real (jsdom)
    // Storage object stores it as an item instead of installing the spy.
    vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })

    // …then a write fails: it must not throw, and the stale cache must be
    // cleared so reads fall through to the worktree walk instead of serving
    // stale data.
    expect(() => setMarkdownFilesCache({ "a.md": "new value" })).not.toThrow()
    expect(getMarkdownFilesCache()).toBeNull()
    const warning = store.get(storageWarningAtom)
    expect(warning).toBeTruthy()

    // The warning is one-time: a second failure leaves it untouched.
    expect(() => setMarkdownFilesCache({ "b.md": "x" })).not.toThrow()
    expect(store.get(storageWarningAtom)).toBe(warning)
  })
})
