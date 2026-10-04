import { Dialog } from "@base-ui/react/dialog"
import type { Block } from "../../blocks/types"
import { XIcon16 } from "../icons"
import { Picture } from "../picture"
import { IconButton } from "../ui/icon-button"

/**
 * The expanded view of an image block: the picture at its full size over a
 * dark scrim, its caption beneath. Click anywhere (or Escape) to close.
 * The picture is drawn as everywhere (`Picture`): the thumbnail the figure
 * already holds at once, the picture itself swapped in once decoded.
 */
export function ImageLightbox({ block, onClose }: { block: Block | null; onClose: () => void }) {
  return (
    <Dialog.Root open={block !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        {/* The scrim and the picture fade in and out together: this is a
            view of the page rather than a surface raised over it, so no
            scale. */}
        <Dialog.Backdrop className="fixed inset-0 z-modal bg-[#000000cc] backdrop-blur-sm transition-opacity duration-base data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          data-testid="image-lightbox"
          className="fixed inset-0 z-modal flex flex-col items-center justify-center gap-3 p-4 outline-none transition-opacity duration-base data-ending-style:opacity-0 data-starting-style:opacity-0"
          onClick={onClose}
        >
          <Dialog.Title className="sr-only">{block?.text.trim() || "Image"}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Click anywhere or press Escape to close
          </Dialog.Description>
          <Dialog.Close
            render={
              <IconButton
                aria-label="Close"
                className="absolute right-3 top-3 text-[#ffffff] hover:bg-[#ffffff22]"
                disableTooltip
              />
            }
          >
            <XIcon16 />
          </Dialog.Close>
          {block ? (
            <>
              <Picture
                block={block}
                name="lightbox-image"
                fit="natural"
                detail="full"
                maxHeight="85vh"
                className="shadow-2xl"
              />
              {block.text.trim() ? (
                <p className="max-w-prose text-center text-[#ffffffcc]">{block.text.trim()}</p>
              ) : null}
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
