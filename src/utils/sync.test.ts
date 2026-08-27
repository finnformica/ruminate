import { Errors } from "isomorphic-git"
import { describe, expect, it } from "vitest"
import {
  MAX_SYNC_ATTEMPTS,
  StatusRow,
  canRetrySync,
  gitUserName,
  hasStagedChanges,
  isMergeUnsupportedError,
  isPushRejectionError,
  isStagedChange,
} from "./sync"

describe("canRetrySync", () => {
  it("allows retries below the cap and refuses at the cap", () => {
    expect(canRetrySync(0)).toBe(true)
    expect(canRetrySync(MAX_SYNC_ATTEMPTS - 1)).toBe(true)
    expect(canRetrySync(MAX_SYNC_ATTEMPTS)).toBe(false)
    expect(canRetrySync(MAX_SYNC_ATTEMPTS + 1)).toBe(false)
  })
})

describe("isPushRejectionError", () => {
  it("matches isomorphic-git's local non-fast-forward rejection", () => {
    expect(isPushRejectionError(new Errors.PushRejectedError("not-fast-forward"))).toBe(true)
  })

  it("matches the server-side push rejection", () => {
    expect(
      isPushRejectionError(
        new Errors.GitPushError("refs/heads/main failed", {
          ok: false,
          error: "failed",
          refs: {},
        }),
      ),
    ).toBe(true)
  })

  it("does not match network or generic errors (they must not burn retries)", () => {
    expect(isPushRejectionError(new Error("Failed to fetch"))).toBe(false)
    expect(isPushRejectionError(new Errors.HttpError(500, "oops", "body"))).toBe(false)
    expect(isPushRejectionError(undefined)).toBe(false)
    expect(isPushRejectionError("PushRejectedError")).toBe(false)
  })
})

describe("isMergeUnsupportedError", () => {
  it("matches MergeNotSupportedError", () => {
    // The runtime constructor takes no arguments (the typings inherit
    // BaseError's `message` parameter, which is ignored here).
    expect(isMergeUnsupportedError(new Errors.MergeNotSupportedError(undefined))).toBe(true)
  })

  it("does not match other merge errors", () => {
    expect(isMergeUnsupportedError(new Errors.MergeConflictError(["a.md"], ["a.md"], [], []))).toBe(
      false,
    )
    expect(isMergeUnsupportedError(new Error("nope"))).toBe(false)
    expect(isMergeUnsupportedError(null)).toBe(false)
  })
})

describe("gitUserName", () => {
  it("uses the stored display name when it is real", () => {
    expect(gitUserName({ name: "Ada Lovelace", login: "ada" })).toBe("Ada Lovelace")
  })

  it("falls back to the login for null, empty, or the literal 'null'", () => {
    expect(gitUserName({ name: null, login: "ada" })).toBe("ada")
    expect(gitUserName({ name: undefined, login: "ada" })).toBe("ada")
    expect(gitUserName({ name: "", login: "ada" })).toBe("ada")
    expect(gitUserName({ name: "  ", login: "ada" })).toBe("ada")
    expect(gitUserName({ name: "null", login: "ada" })).toBe("ada")
  })
})

describe("staged-change detection (empty-commit guard)", () => {
  it("classifies statusMatrix rows", () => {
    // [filepath, HEAD, workdir, stage]
    expect(isStagedChange(["unchanged.md", 1, 1, 1])).toBe(false)
    expect(isStagedChange(["absent.md", 0, 0, 0])).toBe(false)
    expect(isStagedChange(["modified.md", 1, 2, 2])).toBe(true)
    expect(isStagedChange(["added.md", 0, 2, 2])).toBe(true)
    expect(isStagedChange(["deleted.md", 1, 0, 0])).toBe(true)
    expect(isStagedChange(["staged-plus-unstaged.md", 1, 2, 3])).toBe(true)
  })

  it("hasStagedChanges is true when any row changed", () => {
    const unchanged: StatusRow[] = [
      ["a.md", 1, 1, 1],
      ["b.md", 0, 0, 0],
    ]
    expect(hasStagedChanges(unchanged)).toBe(false)
    expect(hasStagedChanges([...unchanged, ["c.md", 1, 2, 2]])).toBe(true)
    expect(hasStagedChanges([])).toBe(false)
  })
})
