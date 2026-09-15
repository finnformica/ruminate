import { describe, expect, it } from "vitest"
import { attentionTone, syncStatusKind } from "./sync-status"

const base = {
  isDatabaseMode: true,
  online: true,
  session: "active",
  isSyncing: false,
  isSyncError: false,
}

describe("syncStatusKind", () => {
  it("reads Synced when nothing is pending or wrong", () => {
    expect(syncStatusKind(base)).toBe("synced")
  })

  it("is hidden outside database mode, whatever else is true", () => {
    expect(syncStatusKind({ ...base, isDatabaseMode: false, online: false })).toBe("hidden")
    expect(syncStatusKind({ ...base, isDatabaseMode: false, session: "expired" })).toBe("hidden")
  })

  it("reads Offline over everything but being signed out", () => {
    expect(syncStatusKind({ ...base, online: false })).toBe("offline")
    // A push that failed before the network went is not the news now.
    expect(syncStatusKind({ ...base, online: false, isSyncError: true })).toBe("offline")
    // Pending edits wait for the network; they are not "syncing".
    expect(syncStatusKind({ ...base, online: false, isSyncing: true })).toBe("offline")
    // A re-sign-in cannot happen offline either.
    expect(syncStatusKind({ ...base, online: false, session: "expired" })).toBe("offline")
    expect(syncStatusKind({ ...base, online: false, session: "expiring" })).toBe("offline")
  })

  it("online, a dead sign-in outranks the sync state", () => {
    expect(syncStatusKind({ ...base, session: "expired", isSyncing: true })).toBe("signed-out")
    expect(syncStatusKind({ ...base, isSyncing: true, isSyncError: true })).toBe("syncing")
    expect(syncStatusKind({ ...base, session: "expiring", isSyncError: true })).toBe("expiring")
    expect(syncStatusKind({ ...base, isSyncError: true })).toBe("failed")
  })
})

describe("attentionTone", () => {
  it("is quiet when everything is fine", () => {
    expect(attentionTone(base)).toBeNull()
  })

  it("is danger on a failed sync or a dead sign-in", () => {
    expect(attentionTone({ ...base, isSyncError: true })).toBe("danger")
    expect(attentionTone({ ...base, session: "expired" })).toBe("danger")
    // A dead sign-in outranks everything, syncing included.
    expect(attentionTone({ ...base, session: "expired", isSyncing: true })).toBe("danger")
  })

  it("is pending while the sign-in is about to expire", () => {
    expect(attentionTone({ ...base, session: "expiring" })).toBe("pending")
    // The dead-or-failed reading wins over a mere warning.
    expect(attentionTone({ ...base, session: "expiring", isSyncError: true })).toBe("pending")
  })

  it("stays quiet while a sync is in flight (the error may be clearing)", () => {
    expect(attentionTone({ ...base, isSyncing: true, isSyncError: true })).toBeNull()
  })

  it("says nothing offline or outside database mode (there is no sync to fail)", () => {
    expect(attentionTone({ ...base, online: false, isSyncError: true })).toBeNull()
    expect(attentionTone({ ...base, isDatabaseMode: false, session: "expired" })).toBeNull()
  })
})
