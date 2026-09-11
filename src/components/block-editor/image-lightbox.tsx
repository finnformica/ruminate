import * as RadixDialog from "@radix-ui/react-dialog"
import { useImageSrc } from "../../data/images"
import type { Block } from "../../blocks/types"
import { IconButton } from "../icon-button"
import { XIcon16 } from "../icons"

/**
 * The expanded view of an image block: the picture at its full size over a
 * dark scrim, its caption beneath. Click anywhere (or Escape) to close.
 */
export function ImageLightbox({ block, onClose }: { block: Block | null; onClose: () => void }) {
  return (
    <RadixDialog.Root open={block !== null} onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-30 bg-[#000000cc] backdrop-blur-sm" />
        <RadixDialog.Content
          data-testid="image-lightbox"
          className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-3 p-4 outline-none"
          onClick={onClose}
        >
          <RadixDialog.Title className="sr-only">{block?.text.trim() || "Image"}</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">
            Click anywhere or press Escape to close
          </RadixDialog.Description>
          <RadixDialog.Close asChild>
            <IconButton
              aria-label="Close"
              className="absolute right-3 top-3 text-[#ffffff] hover:bg-[#ffffff22]"
              disableTooltip
            >
              <XIcon16 />
            </IconButton>
          </RadixDialog.Close>
          {block ? <LightboxImage block={block} /> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function LightboxImage({ block }: { block: Block }) {
  const { src } = useImageSrc(block)
  const caption = block.text.trim()
  return (
    <>
      {src && src !== "error" ? (
        <img
          src={src}
          alt={caption}
          className="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl"
        />
      ) : (
        <span className="text-[#ffffffaa]">
          {src === "error" ? "Image unavailable" : "Loading…"}
        </span>
      )}
      {caption ? <p className="max-w-prose text-center text-[#ffffffcc]">{caption}</p> : null}
    </>
  )
}
