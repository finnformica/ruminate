// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cacheImage, fetchImageBlob, ImageFetchError, readCachedImage } from "./image-cache"
import { thumbnailCopy } from "./image-fit"
import { useImageSrc } from "./images"
import { sessionFetch } from "./session-fetch"

vi.mock("./image-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-cache")>()
  return {
    ...actual,
    cacheImage: vi.fn(async () => {}),
    fetchImageBlob: vi.fn(),
    readCachedImage: vi.fn(async () => null),
  }
})
// jsdom has no canvas: the thumbnail a browser would make is stood in for.
vi.mock("./image-fit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-fit")>()
  return { ...actual, thumbnailCopy: vi.fn(async () => null) }
})
vi.mock("./session-fetch", () => ({ sessionFetch: vi.fn() }))

const fetched = vi.mocked(fetchImageBlob)
const kept = vi.mocked(readCachedImage)
const cached = vi.mocked(cacheImage)
const thumbnailed = vi.mocked(thumbnailCopy)
const put = vi.mocked(sessionFetch)

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
  thumbnailed.mockReset()
  thumbnailed.mockResolvedValue(null)
  put.mockReset()
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
    expect(cached).toHaveBeenCalledWith("img_fetch00000000", bytes, "full")
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

describe("useImageSrc, for a thumbnail", () => {
  it("draws the thumbnail from its own address", async () => {
    fetched.mockResolvedValueOnce(new Blob(["small"]))
    const { result } = renderHook(() => useImageSrc(block("img_thumb0000000"), "thumb"))
    await waitFor(() => expect(result.current.src).toBe("blob:picture"))
    expect(fetched).toHaveBeenCalledWith("img_thumb0000000", "thumb")
    expect(cached).toHaveBeenCalledWith("img_thumb0000000", expect.any(Blob), "thumb")
  })

  it("draws the picture itself when the server has no thumbnail yet, and makes one", async () => {
    const full = new Blob(["full"], { type: "image/png" })
    fetched.mockImplementation(async (_id, variant) => {
      if (variant === "thumb") throw new ImageFetchError("missing")
      return full
    })
    const made = new Blob(["made"], { type: "image/png" })
    thumbnailed.mockResolvedValueOnce(made)
    put.mockResolvedValueOnce(new Response(null, { status: 201 }))
    const { result } = renderHook(() => useImageSrc(block("img_old000000000"), "thumb"))
    await waitFor(() => expect(result.current.src).toBe("blob:picture"))
    expect(result.current.failure).toBeNull()
    expect(fetched).toHaveBeenCalledWith("img_old000000000")
    // The copy goes up beside the picture, and is kept here too.
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][0]).toBe("/api/images/img_old000000000/thumb")
    expect(put.mock.calls[0][1]).toMatchObject({ method: "PUT", body: made })
    await waitFor(() => expect(cached).toHaveBeenCalledWith("img_old000000000", made, "thumb"))
  })

  it("is still missing when there is no picture at all", async () => {
    fetched.mockRejectedValue(new ImageFetchError("missing"))
    const { result } = renderHook(() => useImageSrc(block("img_gone00000000"), "thumb"))
    await waitFor(() => expect(result.current.failure).toBe("missing"))
    expect(thumbnailed).not.toHaveBeenCalled()
  })
})
