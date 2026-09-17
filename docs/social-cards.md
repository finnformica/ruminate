# Social cards

What a Ruminate link looks like when somebody pastes it into a message, a
chat or a timeline. Ruminate reads other people's cards to build link blocks
(docs/links.md); this is the other direction — the card Ruminate offers.

## Two links, two cards

An unfurler is not a browser. It fetches the page, reads the `<head>` and
leaves; it runs no JavaScript at all. So the per-route titles the router sets
(`Route.head`) are invisible to it, and the tags have to be in the HTML the
server hands back.

Only two addresses are worth a card, and they are the two people actually
send:

| Path        | Card                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `/`         | **Ruminate** — "A block-based note-taking app for better thinking."             |
| `/invite/…` | **You're invited to Ruminate** — what the link is and what signing in gets you. |

Everything else is somebody's private note. A crawler that asks for one gets
the page's own title and nothing more: no card, and nothing said about a note
whose address happened to be forwarded. That is not an access control — the
note's content needs a session either way — it is a refusal to help a link
leak.

An invite token appears in one place, `og:url`, which is the address the
reader is about to open anyway. Nothing else repeats it, and no title or
description is built from it.

## How it is served

`worker/handlers/social.ts` writes the tags into the page's `<head>` with
`HTMLRewriter`, on the way out. `wrangler.jsonc` lists `/` and `/invite/*`
under `assets.run_worker_first` so those two paths reach the Worker at all;
every other path is served straight from static assets, as before.

`og:image` is made absolute against **the request's own origin**, never a
constant. The same Worker answers the production domain, the `workers.dev`
address and every preview URL, and a card whose picture points somewhere else
is a card that does not load. (A relative `og:image` is resolved by some
unfurlers and dropped by others, which is the worst of both.) The rewrite also
drops the response's `etag`: the bytes are no longer the ones it names.

`index.html` carries a plain `<title>` and description of its own, so a deep
link that never reaches the Worker still unfurls as text rather than as an
address.

## The pictures

`public/og-card.png` and `public/og-invite.png`, 1200×630 — the size every
unfurler crops to, and the size the tags declare. They are committed assets,
not generated at deploy time.

To change them, edit the template in `scripts/og-cards.mjs` and run it:

```
node scripts/og-cards.mjs
```

It renders the card as a page and screenshots it with Chromium, so the result
is reproducible: same template, same bytes. Commit the PNGs with the change.
`CHROMIUM_PATH` names a browser to use where the one Playwright pinned is not
the one installed.

Both cards come from one template, so they can only differ in the words they
carry. They are drawn in the app's own clothes — the icon's black, the
editor's text face, the cyan a ticked box is filled with — with four rows of
outline down the side saying what the app is to somebody who has never seen
it.
