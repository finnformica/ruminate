import { Errors } from "isomorphic-git"
import { describe, expect, it } from "vitest"
import {
  MAX_SYNC_ATTEMPTS,
  StatusRow,
  canRetrySync,
  categorizeSyncError,
  gitUserName,
  hasStagedChanges,
  isMergeUnsupportedError,
  isPushRejectionError,
  isStagedChange,
  syncErrorLabel,
  toSyncError,
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

describe("categorizeSyncError", () => {
  it("categorizes auth failures (401s in isomorphic-git's shapes)", () => {
    expect(categorizeSyncError(new Errors.HttpError(401, "Unauthorized", "body"))).toBe("auth")
    expect(categorizeSyncError({ data: { statusCode: 401 } })).toBe("auth")
    expect(categorizeSyncError(new Error("HTTP Error: 401 Unauthorized"))).toBe("auth")
    expect(categorizeSyncError(new Error("Bad credentials"))).toBe("auth")
    const sessionExpired = new Error("GitHub session expired")
    sessionExpired.name = "SessionExpiredError"
    expect(categorizeSyncError(sessionExpired)).toBe("auth")
  })

  it("categorizes network failures (fetch TypeError, HTTP 5xx, network messages)", () => {
    expect(categorizeSyncError(new TypeError("Failed to fetch"))).toBe("network")
    expect(categorizeSyncError(new Errors.HttpError(502, "Bad Gateway", "body"))).toBe("network")
    expect(categorizeSyncError(new Error("NetworkError when attempting to fetch resource"))).toBe(
      "network",
    )
  })

  it("categorizes push rejections", () => {
    expect(categorizeSyncError(new Errors.PushRejectedError("not-fast-forward"))).toBe(
      "push-rejected",
    )
    expect(
      categorizeSyncError(
        new Errors.GitPushError("refs/heads/main failed", { ok: false, error: "failed", refs: {} }),
      ),
    ).toBe("push-rejected")
  })

  it("categorizes merge conflicts and unsupported merges", () => {
    expect(categorizeSyncError(new Errors.MergeConflictError(["a.md"], ["a.md"], [], []))).toBe(
      "conflict",
    )
    expect(categorizeSyncError(new Errors.MergeNotSupportedError(undefined))).toBe("conflict")
  })

  it("falls back to unknown", () => {
    expect(categorizeSyncError(new Error("something odd"))).toBe("unknown")
    expect(categorizeSyncError(undefined)).toBe("unknown")
    expect(categorizeSyncError("plain string")).toBe("unknown")
  })
})

describe("toSyncError", () => {
  it("keeps the error message and category", () => {
    const error = new Errors.PushRejectedError("not-fast-forward")
    const syncError = toSyncError(error)
    expect(syncError.category).toBe("push-rejected")
    expect(syncError.message).toBe(error.message)
  })

  it("handles the exhausted retry budget (non-error payload)", () => {
    const syncError = toSyncError({ isSynced: false })
    expect(syncError.category).toBe("unknown")
    expect(syncError.message).toMatch(/could not converge/i)
  })
})

describe("syncErrorLabel", () => {
  it("maps every category to a short label", () => {
    expect(syncErrorLabel("auth")).toBe("Sync failed: auth")
    expect(syncErrorLabel("network")).toBe("Sync failed: network")
    expect(syncErrorLabel("conflict")).toBe("Sync failed: merge")
    expect(syncErrorLabel("push-rejected")).toBe("Sync failed: push")
    expect(syncErrorLabel("unknown")).toBe("Sync failed")
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
