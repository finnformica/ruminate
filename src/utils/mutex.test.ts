import { describe, expect, it } from "vitest"
import { withGitLock } from "./mutex"

// In the test environment there is no `navigator.locks`, so these tests
// exercise the in-process fallback mutex — the same serialization contract the
// Web Locks path provides.
describe("withGitLock", () => {
  it("returns the callback's result", async () => {
    await expect(withGitLock(async () => 42)).resolves.toBe(42)
  })

  it("runs critical sections one at a time, in order", async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = withGitLock(async () => {
      events.push("first:start")
      await gate
      events.push("first:end")
    })
    const second = withGitLock(async () => {
      events.push("second")
    })

    // The second section must not start while the first holds the lock.
    await Promise.resolve()
    expect(events).toEqual(["first:start"])

    release()
    await Promise.all([first, second])
    expect(events).toEqual(["first:start", "first:end", "second"])
  })

  it("propagates rejections without breaking the lock for later sections", async () => {
    await expect(
      withGitLock(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    await expect(withGitLock(async () => "still works")).resolves.toBe("still works")
  })
})
