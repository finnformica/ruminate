import { describe, expect, it } from "vitest"
import { attentionTone } from "./sync-status"

const base = {
  isDatabaseMode: true,
  online: true,
  session: "active",
  isSyncing: false,
  isSyncError: false,
}

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
