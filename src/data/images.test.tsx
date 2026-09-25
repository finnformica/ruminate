// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheImage, fetchImageBlob, ImageFetchError, readCachedImage } from "./image-cache"
import { useImageSrc } from "./images"

vi.mock("./image-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-cache")>()
  return {
    ...actual,
    cacheImage: vi.fn(async () => {}),
    fetchImageBlob: vi.fn(),
    readCachedImage: vi.fn(async () => null),
  }
})

const fetched = vi.mocked(fetchImageBlob)
const kept = vi.mocked(readCachedImage)
const cached = vi.mocked(cacheImage)

// jsdom has no object URLs.
beforeAll(() => {
  const url = URL as unknown as Record<string, unknown>
  url.createObjectURL = vi.fn(() => "blob:picture")
  url.revokeObjectURL = vi.fn()
})

beforeEach(() => {
  fetched.mockReset()
  kept.mockReset()
  kept.mockResolvedValue(null)
  cached.mockClear()
})

const block = (image: string) => ({ id: `blk_${image}`, props: { image } })

describe("useImageSrc", () => {
  it("draws the device's copy without asking the server", async () => {
    kept.mockResolvedValueOnce(new Blob(["kept"]))
    const { result } = renderHook(() => useImageSrc(block("img_kept000000000")))
    expect(result.current).toEqual({ src: null, uploading: false, failure: null })
    await waitFor(() => expect(result.current.src).toBe("blob:picture"))
    expect(fetched).not.toHaveBeenCalled()
  })

  it("keeps a copy of a picture it had to fetch", async () => {
    const bytes = new Blob(["fetched"])
    fetched.mockResolvedValueOnce(bytes)
    const { result } = renderHook(() => useImageSrc(block("img_fetch00000000")))
    await waitFor(() => expect(result.current.src).toBe("blob:picture"))
    expect(cached).toHaveBeenCalledWith("img_fetch00000000", bytes)
  })

  it("tells a picture the server has not got from one it cannot reach", async () => {
    fetched.mockRejectedValueOnce(new ImageFetchError("missing"))
    const missing = renderHook(() => useImageSrc(block("img_missing000000")))
    await waitFor(() => expect(missing.result.current.failure).toBe("missing"))

    fetched.mockRejectedValueOnce(new ImageFetchError("unreachable"))
    const away = renderHook(() => useImageSrc(block("img_away00000000")))
    await waitFor(() => expect(away.result.current.failure).toBe("unreachable"))
    expect(away.result.current.src).toBeNull()
  })

  it("tries an unreachable picture again when the network comes back", async () => {
    fetched.mockRejectedValueOnce(new ImageFetchError("unreachable"))
    const { result } = renderHook(() => useImageSrc(block("img_retry0000000")))
    await waitFor(() => expect(result.current.failure).toBe("unreachable"))
    fetched.mockResolvedValueOnce(new Blob(["back"]))
    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    // Still unreachable while it tries — the placeholder does not flicker.
    expect(result.current.failure).toBe("unreachable")
    await waitFor(() => expect(result.current.src).toBe("blob:picture"))
    expect(result.current.failure).toBeNull()
  })

  it("is missing when the block names no picture at all", () => {
    const { result } = renderHook(() => useImageSrc({ id: "blk_bare", props: {} }))
    expect(result.current.failure).toBe("missing")
  })
})
