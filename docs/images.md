# Images

Pictures in notes: paste a screenshot, drop a file, or type `/image` on a
line, and the picture becomes an **image block** — a row like any other, with
an optional caption beneath it. Click the picture to see it full size; right-
click it to open, download, or delete it.

Switched on since 2026-W37 (see "Switching it on" below for the two halves
and how to turn it off again).

## The block

An image block is an ordinary node in the graph (docs/graph-schema-v2.md):

| field   | holds                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `type`  | `image`                                                                                                                 |
| `text`  | the caption (may be empty)                                                                                              |
| `props` | `{ image: "img_…" }` for an uploaded picture, `{ src: url }` for an external one; `width`/`height` in pixels when known |

The picture's bytes are **not** in the graph. An uploaded picture lives in an
R2 bucket, and the block keeps only its asset id. The graph stays small rows
(every device holds a copy of the whole graph, and D1 rows have a size cap);
the bytes live where bytes belong.

In markdown (the note rollup, copy/paste, export) the block is one line:

```
![caption](/api/images/img_6f9619ff8b86d011b42d00c0)
```

which the parser reads straight back into the same props. A whole-line image
with any other URL parses as an external picture (`props.src`) and loads
straight from that address; an image in the middle of a sentence stays text.

Search: `type:image` finds image blocks; the caption is what text queries
match.

## Uploading and reading

`POST /api/images` takes the raw bytes (the request's `Content-Type` is the
image type) and answers `{ id, size, type }`. `GET /api/images/<id>` serves
them back, marked `private, immutable` so the browser keeps them for good.
Both are session-guarded exactly like the replica routes; the R2 key is
`<verified GitHub id>/<asset id>`, minted from the session and a validated
id, so one tenant can neither read nor overwrite another's picture.

Limits (`worker/handlers/image-policy.ts`, shared with the client, which
checks them before uploading): PNG, JPEG, GIF, WebP and AVIF; ten megabytes a
picture. SVG is refused on purpose — served from the app's own origin it can
run script when opened directly.

The client (`src/data/images.ts`) puts the row in FIRST and uploads behind
it. The block starts with no image props at all and draws the pasted file
from a local object URL held in memory (`beginPendingImage`), under a
spinner; the asset id is written only when the upload lands, and without a
history step, so the whole picture is still one undo. A failed upload takes
the row back out (restoring the blank line it took over, if it took one) and
says why in a toast ([sonner](https://sonner.emilkowal.ski), mounted in
`src/routes/_appRoot.tsx`). Nothing provisional is ever written to the graph,
so a note mid-upload syncs as an empty image block rather than a broken
reference.

On success the bytes already in hand seed the read cache
(`primeImageObjectUrl`), so a picture just uploaded is never fetched straight
back down. Other reads go through `fetch` with the bearer token (an
`<img src>` cannot carry one) and become object URLs, cached for the page's
life.

## Switching it on

Two halves, both now in place:

1. **A bucket.** `ruminate-images`, created with `npx wrangler r2 bucket create
ruminate-images` and named by the `r2_buckets` binding in `wrangler.jsonc`.
   Deploying with a binding that names a bucket that does not exist fails the
   deploy, so the bucket comes first. R2 itself must be activated on the
   account once, in the dashboard — the CLI cannot do it.
2. **The variable.** `VITE_IMAGES_ENABLED=true` in `wrangler.jsonc` `vars`,
   which the Worker reads at runtime (it answers `501 images_disabled`
   otherwise), **and** in `.env.production`, which is what Vite inlines into
   the client bundle when Workers Builds runs the build. With the client half
   off, pasting a picture does nothing and the slash menu has no "Image"; with
   the Worker half off, an upload is refused with a clear message.

To turn it off again, set either half to anything but `true`; the bucket and
its bytes are untouched.

For local development `.env` and `.dev.vars` carry the same variable (both are
git-ignored; copy them from the `.example` files). `wrangler dev` serves a
local R2 bucket automatically once the binding exists, so nothing you upload
locally reaches the real one.

## Cost

R2 has no egress charge, which is what makes it the right home for pictures
a phone and a laptop both pull. As of writing, the free allowance per
account per month is 10 GB stored, one million writes (Class A) and ten
million reads (Class B); beyond it, storage is USD 0.015 per GB-month, writes
USD 4.50 per million, reads USD 0.36 per million. A personal corpus of a few
thousand screenshots stays inside the free allowance. Check Cloudflare's
pricing page for the current figures.

## Not yet

- **Deleting bytes.** Deleting an image block (or its note) leaves the asset
  in the bucket: a block delete is undoable, and the bytes must outlive the
  undo window. A sweep that removes assets no block names is future work;
  until then orphans cost storage only, at the rate above.
- **External pictures on paste.** HTML pasted from a web page drops its
  `<img>` tags (as before); only files upload. Typing the markdown line by
  hand does work.
