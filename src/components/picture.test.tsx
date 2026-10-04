// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchImageBlob } from "../data/image-cache"
import { beginPendingImage, releasePendingImage } from "../data/images"
import { Picture } from "./picture"

vi.mock("../data/image-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/image-cache")>()
  return {
    ...actual,
    cacheImage: vi.fn(async () => {}),
    fetchImageBlob: vi.fn(),
    readCachedImage: vi.fn(async () => null),
  }
})

const fetched = vi.mocked(fetchImageBlob)

/** An IntersectionObserver that never fires on its own: the test plays
 * the picture coming near with `intersect`. */
class FakeObserver {
  static instances: FakeObserver[] = []
  watched: Element | null = null
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.instances.push(this)
  }
  observe(element: Element) {
    this.watched = element
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return []
  }
  intersect() {
    this.callback(
      [{ target: this.watched!, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

/** A ResizeObserver the test drives: `measure(width)` plays the box
 * being laid out that wide. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  measure(width: number) {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

// jsdom has no object URLs: each blob gets an address naming its bytes'
// length, so a thumbnail's can be told from the picture's.
beforeAll(() => {
  const url = URL as unknown as Record<string, unknown>
  url.createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`)
  url.revokeObjectURL = vi.fn()
})

beforeEach(() => {
  fetched.mockReset()
  // "thumb" is five bytes, "full" four.
  fetched.mockImplementation(async (_id, variant = "full") => new Blob([variant]))
  FakeObserver.instances = []
  FakeResizeObserver.instances = []
  vi.stubGlobal("IntersectionObserver", FakeObserver)
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const THUMBHASH = "YyUKNJh2d3eAiHh3iIeGcGgHdw=="
const picture = (id: string, props: Record<string, unknown> = {}) => ({
  id: `blk_${id}`,
  text: "",
  props: { image: `img_${id}`, ...props },
})
const img = () => screen.getByTestId("board-image") as HTMLImageElement

describe("Picture", () => {
  it("fetches a lazy picture's bytes only once it is near the screen", async () => {
    render(
      <Picture
        block={picture("lazy00000000")}
        name="board-image"
        fit="cover"
        detail="thumb"
        lazy
      />,
    )
    expect(screen.getByTestId("board-image-placeholder")).toBeTruthy()
    expect(fetched).not.toHaveBeenCalled()

    act(() => FakeObserver.instances[0].intersect())
    await waitFor(() => expect(img().src).toBe("blob:5"))
    expect(fetched).toHaveBeenCalledWith("img_lazy00000000", "thumb")
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it("fetches straight away when it is not lazy, and watches nothing", async () => {
    render(
      <Picture block={picture("eager0000000")} name="board-image" fit="cover" detail="thumb" />,
    )
    await waitFor(() => expect(img().src).toBe("blob:5"))
    expect(FakeObserver.instances).toHaveLength(0)
  })

  it("draws the block's likeness while it waits, and pulses a plain box without one", () => {
    render(
      <Picture
        block={picture("hash00000000", { thumbhash: THUMBHASH })}
        name="board-image"
        fit="cover"
        detail="thumb"
        lazy
      />,
    )
    const likeness = screen.getByTestId("board-image-placeholder")
    expect(likeness.style.backgroundImage).toMatch(/^url\("data:image\/png;base64,/)
    expect(likeness.className).not.toContain("animate-pulse")
    cleanup()

    render(
      <Picture
        block={picture("plain0000000")}
        name="board-image"
        fit="cover"
        detail="thumb"
        lazy
      />,
    )
    const plain = screen.getByTestId("board-image-placeholder")
    expect(plain.style.backgroundImage).toBe("")
    expect(plain.className).toContain("animate-pulse")
  })

  it("fades the picture in over its likeness once it has loaded", async () => {
    render(
      <Picture
        block={picture("fade00000000", { thumbhash: THUMBHASH })}
        name="board-image"
        fit="cover"
        detail="thumb"
      />,
    )
    const image = (await screen.findByTestId("board-image")) as HTMLImageElement
    // Transparent until the bytes have decoded, the likeness behind it.
    expect(image.className).toContain("opacity-0")
    expect(image.parentElement?.style.backgroundImage).toMatch(/^url\("data:image\/png;base64,/)
    fireEvent.load(image)
    expect(image.className).toContain("opacity-100")
    expect(image.parentElement?.style.backgroundImage).toBe("")
  })

  it("draws the thumbnail first, then the picture itself where it is asked for", async () => {
    render(
      <Picture block={picture("full00000000")} name="board-image" fit="natural" detail="full" />,
    )
    // Both are asked for; the picture replaces the thumbnail once decoded
    // (at once here: jsdom cannot decode).
    await waitFor(() => expect(img().src).toBe("blob:4"))
    expect(fetched).toHaveBeenCalledWith("img_full00000000", "thumb")
    expect(fetched).toHaveBeenCalledWith("img_full00000000", "full")
  })

  it("asks for the picture itself only where its box wants more than the thumbnail has", async () => {
    // A 4000×3000 picture's thumbnail is 640 wide: a box narrower than that
    // in device pixels is content with it.
    render(
      <Picture
        block={picture("auto00000000", { width: 4000, height: 3000 })}
        name="board-image"
        fit="natural"
        detail="auto"
      />,
    )
    await waitFor(() => expect(img().src).toBe("blob:5"))
    act(() => FakeResizeObserver.instances[0].measure(400))
    await waitFor(() => expect(fetched).toHaveBeenCalledTimes(1))
    expect(img().src).toBe("blob:5")
    // Laid out wider than the thumbnail, it wants the picture.
    act(() => FakeResizeObserver.instances[0].measure(900))
    await waitFor(() => expect(img().src).toBe("blob:4"))
    expect(fetched).toHaveBeenCalledWith("img_auto00000000", "full")
  })

  it("never holds back a picture still uploading: its preview is in hand", () => {
    const id = "blk_up0000000000"
    beginPendingImage(id, new File(["png"], "a.png", { type: "image/png" }))
    try {
      render(
        <Picture
          block={{ id, text: "", props: null }}
          name="board-image"
          fit="cover"
          detail="thumb"
          lazy
        />,
      )
      expect(screen.getByTestId("board-image-uploading")).toBeTruthy()
      expect(fetched).not.toHaveBeenCalled()
    } finally {
      releasePendingImage(id)
    }
  })

  it("tells its surroundings what it is up to", async () => {
    const onState = vi.fn()
    render(
      <Picture
        block={picture("state0000000")}
        name="board-image"
        fit="cover"
        detail="thumb"
        onState={onState}
      />,
    )
    await waitFor(() =>
      expect(onState).toHaveBeenLastCalledWith({ uploading: false, ready: true, missing: false }),
    )
  })
})
