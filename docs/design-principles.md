# Ruminate editor design principles

Notion-inspired, adapted to an outliner: the page should read as a **document
first** and an outline second. Chrome (markers, toggles, guides, affordances) is
quiet and stays out of the ink's way; it earns attention only when the pointer
asks for it.

## Principles

1. **Content-first contrast.** Body text is full ink (`--color-text`). Everything
   that is _about_ the content — markers, guides, breadcrumbs, affordances — sits
   two or three steps down the gray ramp (`secondary` → `tertiary` → `border`).
   Never promote chrome to ink.
2. **Quiet chrome, hover affordances.** Structural controls (collapse chevron,
   hover surfaces) are invisible until their own area is hovered or they hold
   focus, and they appear **without any layout shift** — always reserving their
   space, only fading opacity. The collapse chevron reveals _in the block's own
   key_: hovering the key slot (never the whole row) fades the bullet dot, `#`
   or number out and the chevron in, in the same slot, together with its hover
   square (see 6 for the checkbox and keyless blocks). Exception: a
   _collapsed_ block keeps its chevron visible (the key stays hidden for the
   duration), so hidden content is never a secret. Without a hovering pointer
   (touch) the chevron simply stands in for a parent's key.
3. **Selection has its own color, and is drawn as a ring.** Hover is a neutral
   **fill**; selection is an accent **ring**. The two differ in _kind_, not in
   weight, and the difference says something true: a ring draws a boundary,
   and a boundary claims an extent — a selection has one (it can run over
   several blocks), the pointer does not. A block line hovers at a whisper
   (`--neutral-a2`, editable editors only — never read-only views, the row
   being edited, or a selected row) and selects with the **block selection
   tokens** (`--color-border-selected` / `--color-bg-selected-faint` /
   `--color-text-selected`, `src/styles/variables.css`): a 1px inset ring of
   the accent over a faint wash. The ring, not a painted slab, is what keeps
   the block a line of a document rather than a row of a nav list — the app
   draws structure with 1px borders and small brightness steps everywhere
   else (cards, inputs, the indent guides). Light scheme: the ring is
   `color-mix(in srgb, var(--accent-9) 45%, <wash>)` over a 7% accent-9 wash.
   Dark scheme: pastel — the ring is 55% accent-11 (the dark scheme's light
   step; a dark ground eats a thin line) over a 12% accent-11 wash laid on a
   14% white lift, so the tint stays airy where accent-9 went muddy, and the
   lift keeps it a clear step above the page without the old wash's 18%
   slab. The Neutral accent's light ring deepens to 60%, as its wash does, so
   an accent-9 that _is_ the gray ramp still outranks the inactive
   selection's neutral ring. A highlighted block must read as "selected", not
   "hovered", and selection always wins visually.
   The ring is four inset box-shadows, one per edge, so a multi-select run
   drops the edges that sit mid-run (`.block-run-top` / `.block-run-bottom`,
   from the run-edge pairs in `block-item.tsx`) and reads as one outlined
   surface. Ring and wash are `color-mix` of opaque inputs — the ring is mixed
   over the wash it sits on — so both are **computed-solid**: no alpha
   muddying over the warm sand background, and where adjacent selected lines
   overlap on their run sides neither the fill nor the side lines double up.
   **The row's ink leans toward the accent** (the Notion-overlay effect): the
   selected line sets an inherited
   `color: color-mix(in srgb, var(--accent-12) 50%, var(--color-text))` (same
   formula in both schemes; accent-12 is the ramp's contrast-safe ink), so
   body text — and anything else that inherits — reads slightly lit by the
   selection, while elements with explicit colors (quote/done-todo secondary
   ink, tertiary markers, code, links) keep theirs.
   The structural class `bg-bg-secondary` stays on the line (tests and tooling
   select on it); `.block-highlight` draws the ring and wash on top.
   **Selection follows the keyboard.** The accent ring is a promise that
   arrows work here, so it only shows while the editor actually owns the
   keyboard: focus inside its container, and the user's last act not a click
   on blank space (the page margin, a gap between rows — `pointerIdle` in
   `block-editor.tsx`; the next key press hands the keyboard back, as
   `:focus-visible` would). Whenever focus is elsewhere — the sidebar, a
   dialog, the `?` reference, the ⌘P palette mid-preview — or blank space
   was just clicked, the
   selection demotes to the same ring language with the accent removed (the
   additive `.block-highlight-inactive` class), Finder/VS Code-style: still
   visibly the selection, no longer claiming the keys. The ring goes neutral
   (light: 22% `--neutral-9` over the fill; dark: a 14% white lift), and
   keeps a faint neutral fill under it (light: 4% `--neutral-9`; dark: 4%
   white). The three states form one ladder, each rung **adding** to the one
   below — hover is a fill alone, inactive that fill plus a neutral ring,
   active that fill plus an accent ring — keeping the order
   active > inactive > hover everywhere. The text tint resets to plain inherited ink, so demotion also
   drains the color from the text. Accent-independent, so all five accents
   share one inactive treatment per scheme. Restoration rides the same 100ms
   fades — perceptually instant.
   Outside the editor "chosen" and "current" are a **wash**: the sidebar's
   active nav row / open note (`.nav-item[aria-current]`, with
   `-hover`/`-active` steps), the notes list keyboard highlight
   (`.list-highlight`), the calendar's current day and week, and the settings
   pickers (`<Button selected>`) all use `--color-bg-selected` /
   `--color-text-selected` verbatim. Every one of
   these tokens is mixed from the same `--accent-9`, so one color always means
   "you are here / keys act here", and changing the selection color is a
   one-place edit in `variables.css`.
   **A ring only where focus doesn't already own it.** `focus-ring` is a 2px
   inset ring in `--color-border-focus`, so on anything focusable an accent
   ring already means "focused" — a second accent ring meaning "chosen" is
   unreadable, whatever its width. Block rows are the one row type that is
   never focusable (the editor container holds the keyboard, `tabIndex={-1}`),
   which is exactly why the ring is free there. Everywhere else "chosen" is a
   fill. Two deliberate exceptions, both surfaces a fill would destroy: a
   note card in grid view and a scope pill take `--color-border-selected` (never
   `--color-border-focus`, so highlight and focus stay tellable apart), and
   the accent swatch takes an INK ring, since an accent ring on an accent
   swatch would vanish.
   **A fill can never be its own hover.** `--color-bg-secondary` and
   `--color-bg-hover` are the same value by design (hovering a ghost control
   makes it look like a filled one), so a chosen/toggled surface must sit
   clear of them: the selected wash, or a step further up the neutral ladder
   (`--color-bg-secondary-hover`, with `-active` and `--neutral-a6` above it).
   **Accent is for the app's own surfaces.** Two controls take that neutral
   ladder rather than the wash, because accent would be wrong there, not
   merely loud: the sidebar's toggled panel (`.nav-item[aria-pressed]`), since
   a panel you opened is a state and not a place; and the image toolbar's
   alignment, since it floats over a picture, so an accent tint would land on
   whatever colour the picture happens to be, and an alignment is a tool's
   state rather than something the app remembers about you.
   **Controls over a picture carry their own contrast.** The toolbar and the
   resize handles float over an image of unknown colour, so neither may rely
   on it: the toolbar is a blurred card with a hairline, and each handle is an
   opaque white pill with a dark hairline and a soft shadow (`image-figure.tsx`)
   — on a dark picture the white core carries it, on a pale one the hairline
   and shadow do.
4. **View and edit are pixel-identical.** Every typographic property (size,
   weight, line-height, tracking) lives in `typographyFor` and is applied to both
   the rendered body _and_ the textarea. Nothing may style one branch only.
5. **Generous reading rhythm.** Body line-height is 1.65 (`leading-relaxed` —
   defined for real in `tailwind.config.cjs`; it was previously a silent no-op).
   Headings tighten as they grow (1.25 at the top of the scale).
6. **The key is the toggle; the guide hangs from it.** There is no collapse
   gutter. Every block type owns the 15px marker slot, and a parent's chevron
   lives in that slot: it swaps in for the key on hover (2) — a bullet dot, a
   heading `#`, a number, a quote `>` — or simply appears in a paragraph's
   empty slot. The indent guide is a 1px rule under the slot's centre — the
   slot starts 4px into the content column (the surface's reach), so its
   centre is 11.5px in and the rule sits at 11px — with children starting
   24px in (`ml-[11px]` + rule + `pl-3`), so a guide never hangs from
   anything but a slot and the markers never sit off the lines. A checkbox is
   a control in its own right (a swap would leave a parent todo un-tickable),
   so a parent todo's chevron sits _beside_ the slot, hugging the highlight
   surface's left edge from outside (its ink ~3px off the edge, clear of the
   parent's guide line 11px out when nested) — same reveal (hover its own
   square, or the checkbox), same pin while collapsed — and that square is a
   hit area only,
   with no hover surface, so it never clashes with the box or the highlight
   it straddles. The chevron's hover square is 20px,
   with the small (4px) radius: inside the 27px-tall surface that is an even
   ~3.5px inset on every side, because the slot's centre sits 13.5px in from
   the surface's edge — the same as the surface's vertical centre. The
   chevron itself is a filled triangle with softened corners. Affordances
   float out of the flow (absolute/negative margin) so hover never moves
   text.
7. **One marker slot.** Every block marker — bullet dot, checkbox, ordered
   number, heading `#`, quote `>` — occupies the same 15px slot (the
   checkbox's width): dots centre in it; text glyphs right-align to its edge;
   a paragraph leaves it empty. Body text therefore starts at one column
   across all block types (dots, the checkbox and the quote's `>` centre in
   the slot; `#` and numbers right-align). A quote's bar stands at the text
   column, in the glyph ink with rounded ends, and pushes the quote's text
   10px in — the one block whose text is set in from the column.
   The grey `#` is one component (`Hash`) everywhere it appears — note title,
   focus title, section headings — with no typography of its own: it inherits
   its parent's scale (the titles' 3xl, each heading's depth size and bold),
   so the hash is always the same size as the text beside it, only recolored
   to tertiary. A large heading's hash outgrows the slot and overflows left,
   past the surface's edge — the text column never moves. At the three
   larger heading scales the surface itself reaches further left
   (`[data-heading-scale]`, block-editor.css), by exactly the amount that
   makes the chevron's square as far from the left edge as from the top and
   bottom of the taller line; still a negative-margin + padding pair, so the
   text column is untouched. Selected, every typographic marker — the hash, the
   dot, the number, the quote's `>` and bar — takes the quiet chrome tint
   (`--color-text-selected-chrome`, via `.block-glyph` / `.block-glyph-fill`):
   the selection's text tint never reaches an element with explicit ink.
   Controls (checkbox, chevron) keep their own. The note title's
   hash sits in the same slot, so the title is set exactly as the outline's
   top heading — but the title is not a row. On a wide page the whole header
   (title, focus breadcrumb, focus title) hangs into the page gutter by the
   marker-slot offset (`.note-header` + `--note-header-pull`,
   block-editor.css; the page sets it with its padding), so the header's
   text sits at the content column's edge, the hash in the gutter beside it,
   and the outline reads as indented beneath the title rather than the title
   as one more row. The pull is the page's to grant: it needs the 40px
   gutter, so a narrow page (16–20px) leaves the header at the text column.
   The rows never take it — the text column does not move. Unlike the bullet
   and number the hash is NOT a focus target — it reads as typography, and
   focus stays on F / Cmd+. and the bullet/number clicks (on leaves; a
   parent's key is its collapse toggle).

## Type scale

Body is 14px (`--font-size-base`), iA Writer Quattro. Headings are sized by
outline depth, not by `#` count:

| Role               | Size            | Weight | Line-height | Tracking |
| ------------------ | --------------- | ------ | ----------- | -------- |
| Note title         | 3xl (36px)      | bold   | 1.25        | −0.02em  |
| Heading, depth 0   | 2xl (30px)      | bold   | 1.25        | −0.015em |
| Heading, depth 1   | xl (24px)       | bold   | 1.25        | −0.01em  |
| Heading, depth 2   | lg (18px)       | bold   | 1.4         | —        |
| Heading, deeper    | base, underline | bold   | 1.65        | —        |
| Body / list / todo | base (14px)     | normal | 1.65        | —        |
| Quote              | base, secondary | normal | 1.65        | —        |
| Breadcrumb         | sm (12px)       | normal | —           | —        |

The deepest heading keeps a soft underline (`--neutral-a6`, offset 4px) so it
still reads as a heading at body size without shouting. The floor is
deliberately **uniform**: every heading at depth 3+ renders identically, and
the 24px indent (plus breadcrumbs when focused) carries the hierarchy from
there — piling on case/color/weight steps at the bottom of the outline would
promote chrome over content.

Focusing re-derives depth: the focused block's children start again at depth 0,
so a level-4 heading reads as a top-level section inside its own focused view.

**Only a heading becomes the view's title** (`titlesFocus`, `src/blocks/markers.ts`).
A heading already names what hangs beneath it, so the focus title _is_ the note
title: the editor draws it with the same `NoteTitle` component the page draws
the note's title with — 3xl, the hanging `#`, the same highlight and the same
keys — fed the block's text instead of the note's. It is not a row: the rows
are the block's children, from depth 0, and ↑ from the first hands the
keyboard up to the title as it would to the note title (`exitTop`), Enter on
the title makes the block's first child, and renaming it is a text edit of the
block. Only its text reads as the title — the heading `#` belongs to its row
in the outline — and a heading whose text is more than one plain line reads as
the title but is edited in its own row, outside focus. It hangs into the gutter
with the breadcrumb above it (`.note-header`), so its children read as
indented beneath it.

**Every other type leads the view as its own first row.** A to-do, a picture,
a quote, a code block, a paragraph: these are content, not names. Stripped of
their marker and set in title type they say something they do not mean — a
to-do stops looking done-able, a picture becomes its caption — and a code
block has nothing a one-line field could edit. So the view draws no title at
all: the focused block is the first row, at depth 0, exactly as it is drawn
anywhere else, with its subtree indented beneath it. The breadcrumb alone says
where you are, and everything below the leading row reads as it does outside focus.

## Spacing

- **Block rhythm:** 2px gap between rows (`space-y-0.5`) + 2px vertical padding
  per line. Line-height carries the rest of the air.
- **Headings breathe above:** top margin scales with the heading — 20 / 16 / 10 /
  6px by depth. Space belongs _above_ a heading (it opens a section), never
  below.
- **Indent unit:** 24px per level (`ml-[11px]` + 1px rule + `pl-3`), guide
  line under the key at 11px — every block type has one.
- **Highlight inset:** highlighted line surfaces give the text 6px of
  horizontal breathing room (symmetric — 6px inner padding each side, the
  surface extending 2px past the text column on both, via `-mx-0.5 px-1.5`;
  the note title's `-mx-0.5 pl-[29px] pr-0.5` extends the same 2px left) so
  the **text never moves** — only the background extends outward, into the
  indent and the inter-row space. The 2px reach is what puts the key slot's
  centre on the surface's vertical centre line, so the collapse chevron's
  square sits evenly inside. Block
  rhythm is untouched: the surface borrows the space between rows, it never
  adds any. The text column is sacred; surfaces flex around it.
- **Header pull:** the note title, the focus breadcrumb and the focus title
  hang into the page gutter by `--note-header-pull` (`.note-header`,
  block-editor.css): 27px — the marker-slot offset — once the page's gutter
  is 40px (`@[640px]`), else 0. A plain negative margin on the header alone,
  so the header's text moves to the column's edge and nothing in the rows
  does. The breadcrumb hangs by the same amount, so its first crumb's text
  keeps starting where the marker slot does — the focus title's `#`.
- **Vertical extension is conditional, per side.** The inter-row gap is 4px
  between nested rows and 6px between roots, so surfaces may only grow as far
  as their neighbour's paint allows. By default each side extends 2px
  (`-mt-0.5 pt-0.5` / `-mb-0.5 pb-0.5`) — exactly the midpoint of the nested
  gap — so two adjacent surfaces painted in **different** colors (a hovered
  row beside a selected one, the reported collision) can at most abut
  edge-to-edge, never overlap. A side that sits **mid-run** in a multi-select
  (this row and the adjacent visible row are both selected and their surfaces
  touch) gets the full 4px (`-mt-1 pt-1` / `-mb-1 pb-1`), deliberately
  overlapping the neighbour's identical computed-solid wash and ring side
  lines (`color-mix` of opaque inputs is opaque, so the overlap can't double
  up), and drops its own ring edge on that side so the run is outlined only
  around its outside. Every pair keeps
  negative margin equal to padding, on both the view and edit branches, so
  baselines are identical in every state (the pixel-parity e2e enforces it).
- **Multi-select reads as one surface.** The full 4px growth on run sides
  makes consecutive selected lines overlap (4+4 into a 4px nested gap, or a
  6px root gap), so a Shift+Arrow run merges into a single continuous
  surface (the wash is computed-solid, so the overlap is seamless): corners where two selected surfaces meet go straight (the same
  `selectionRunEdges` map in `block-editor.tsx` drives both the extension and
  the squared corners), rounded only at the run's top and bottom. A heading's
  top margin (or the focus title's bottom margin) keeps a real gap, so those
  boundaries stay rounded — and those sides fall back to the 2px extension.

## Radius family

One token family, sized by surface, never per-element drift:

| Token                  | Value | Used for                                                               |
| ---------------------- | ----- | ---------------------------------------------------------------------- |
| `--border-radius-sm`   | 4px   | inline chips: inline code, transclusions, keys                         |
| `--border-radius-base` | 8px   | line surfaces (block/title highlight, a code block's panel) & controls |
| `--border-radius-lg`   | 12px  | block panels: cards                                                    |

The rule: the bigger the surface, the bigger the radius. All values derive from
`--border-radius-base`, so a theme that changes the base changes the whole
family with it. (There is no intermediate 6px step any more — line surfaces
share the control radius; the old `--border-radius-md` read as too sharp on a
full-width highlight.)

## Elevation

Everything raised is a `Surface` (src/components/ui/surface.tsx) and says
which of three tiers it is. The tier decides the edge, the fill, the shadow
and the radius, so no component picks a shadow or a radius for itself:

| Tier    | What                                                                               | Fill and shadow                                      | Radius    |
| ------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- | --------- |
| `card`  | part of the page: settings sections, previews                                      | `bg-card`, `--shadow-card`                           | `lg` 12px |
| `popup` | floats over the page: menus, tooltips, hover cards, listboxes, the what's-new card | `bg-overlay-backdrop` blurred, `--shadow-popup`      | `lg` 12px |
| `modal` | floats over everything: dialogs, the palette                                       | `bg-overlay-backdrop` blurred more, `--shadow-modal` | `xl` 16px |

A modal also draws a scrim over the page (`--color-bg-scrim`: a fifth of black
in the light, half in the dark, where a light dim reads as haze), so the page
steps back and the window comes forward; the dialog's fades with it, the
palette's is simply there. A dialog sits centred on the page.

Every tier shares the same hairline ring for an edge (`--neutral-a3`, inset in
the dark), which is what makes them read as one family at three heights. An
in-page card renders `<Surface tier="card">` like the rest; the two elements
that cannot be a `Surface` — a router `Link`, the calendar's own container —
take the recipe, `surface({ tier: "card" })`, so there is still one definition.

**Layers** are named, never numbered (`--z-raised` 10, `--z-popup` 20,
`--z-modal` 30, `--z-tooltip` 40 in variables.css; `z-raised` … `z-tooltip` in
Tailwind), and the layer is named by the element that is _positioned_, not by
the surface: a Base UI `Positioner`, a fixed dialog, a drawer, the what's-new
card's own box. A z-index on a surface inside a positioned, transformed
wrapper orders nothing outside that wrapper — which is why Material UI puts
`zIndex` on the popover and not the paper, and shadcn puts `z-50` on the
positioner. Tooltips take the layer above the modals, because a tooltip
belongs to the control under the pointer wherever that control is.

## Color roles

| Role         | Light / dark token                                              | Used for                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ink          | `--color-text` (sand-12)                                        | body, headings, checked-off text ink                                                                                                                                                                            |
| Muted        | `--color-text-secondary`                                        | quotes, done todos, ordered numbers, crumbs                                                                                                                                                                     |
| Faint        | `--color-text-tertiary`                                         | bullet dots, chevron, placeholders, `#`                                                                                                                                                                         |
| Guide        | `--color-border-secondary`                                      | indent guide lines (rest state)                                                                                                                                                                                 |
| Structure    | `--color-border` (a7)                                           | quote bar, unchecked checkbox border                                                                                                                                                                            |
| Hover        | `--neutral-a2` fill                                             | non-selected block lines under the pointer — a whisper of fill, no ring                                                                                                                                         |
| Selection    | `--color-border-selected` ring over `--color-bg-selected-faint` | selected block(s) — 1px accent ring (45% accent-9 light / 55% accent-11 dark) over a faint wash (7% accent-9 light / 12% accent-11 on a 14% lift dark); the list highlight keeps the `--color-bg-selected` wash |
| Selected ink | `--color-text-selected`                                         | ink on a selected row — 50% toward accent-12                                                                                                                                                                    |
| Inactive sel | neutral ring + fill (see §3)                                    | the selection while the editor lacks focus or blank space was clicked — 22% neutral-9 ring over a 4% fill light / 14% white ring over a 4% lift dark                                                            |
| Current      | `--color-bg-selected`                                           | sidebar active route / open note row (same tokens as Selection)                                                                                                                                                 |
| Accent solid | `--accent-9`                                                    | checked checkbox fill                                                                                                                                                                                           |
| Transclusion | `--accent-a2` tint                                              | `((ref))` embeds — quietly "live" content                                                                                                                                                                       |

All roles are Radix alpha/step tokens, so both color schemes (and print, which
remaps the semantic tokens) resolve automatically. Never hardcode a hex.

**User-selectable accent.** The `--accent-*` family is themable: a
`data-accent` attribute on `<html>` (persisted via `accentAtom`, picked in
Settings → Appearance) remaps the whole family onto another Radix ramp —
neutral (sand), green, violet, or amber — in `src/styles/variables.css`. Cyan
is the default and needs no attribute. Rules for a new accent:

- Remap **only** the accent tokens; every accent role above then follows.
- Both color schemes come free: the ramps themselves flip under
  `:root[data-theme="dark"]` in `radix-colors.css`. The scheme is the app's
  choice (Settings → Appearance: system, light or dark; `themeAtom`), stamped
  on `<html>` by `src/hooks/color-scheme.ts` — "system" resolving through
  `prefers-color-scheme` there and nowhere else, so no stylesheet consults
  the media query itself (Tailwind's `dark:` follows the attribute too).
- Selection must stay distinct from hover. The neutral (grayscale) accent —
  the app's original pre-accent gray — would collide with the neutral hover
  surfaces, so its alpha steps are biased one step darker, and the selection
  wash follows the same bias in the light scheme: neutral's
  `--color-bg-selected` deepens from the 13% to an 18% `--accent-9` (= `sand-9`)
  wash (see `variables.css`), keeping a clear step above the `--neutral-a2`
  line hover. Dark needs no bias — the white lift already guarantees selection
  sits clear of the (darkening) hover wash.
- A light step 9 needs a dark checkmark: amber overrides the checked-checkbox
  glyph and sets `--accent-contrast` to its dark ink.

## Notices

Every non-blocking "something needs your attention" message renders through
**one component** — `Notice` (`src/components/notice.tsx`): a `--border-radius-base`
surface with a subtle border (`--color-border-secondary`) on the card
background, an icon slot on the left, the message in the middle, actions and
an optional standard **Dismiss** on the right. Two tones color the icon rank,
never the prose: `info` (tertiary — the remote-edit notice on a note) and
`warning` (`--color-text-pending` — storage quota, merge notices). Wording
stays terse and factual; the strongest action is never a primary button — a
notice informs, it doesn't nag.

Placement conventions:

- **App-scope** notices (storage quota, merge notices) sit in a full-width
  strip above the layout: a `p-2` container with a `--color-border-secondary`
  bottom border, the Notice card inside.
- **Page-scope** notices (the remote-edit notice) sit inline, directly above
  the content they concern, sharing the page column's width.
- Notices never float, overlay, or animate in — they are part of the page,
  and they leave by re-render (dismiss), not by transition.
- **Toasts** ([sonner](https://sonner.emilkowal.ski), its `Toaster` mounted
  once in `src/routes/_appRoot.tsx`; raise one with `toast.error(message)`)
  are the one exception, for one job: telling the reader that something they
  have _just done_ has failed, or did nothing — a picture that would not
  upload, a paste of a block already under the target. A toast
  floats in the bottom corner (above the phone nav bar), follows the system
  theme, and leaves on its own after a few seconds or on its close button.
  It never carries state the reader must come back to — anything that
  persists is a notice in the page, not a toast — and never a success
  message: the picture landing is its own confirmation.

### Copy

Descriptive copy — the line under a field, the sentence that opens a settings
panel, a notice, a toast — is **one line long**. One clause that says what
the thing is or does; the reader is here to act, not to read. If it needs a
second sentence, the control is unclear or the sentence belongs in the docs.
Labels are nouns (**Email address**), buttons are verbs (**Share**), and the
sentence before a consequential button says exactly what it will do.

## Loading

While the notes are still on their way — the identity resolving at boot, the
signed-in store opening, a new device's first pull — the page and the
sidebar's note rows stand in as **skeletons** (`src/components/skeleton.tsx`,
gated by `isBootingAtom`): pulsing bars at chrome rank
(`--color-bg-tertiary`), sized and placed like the content they wait for, so
the page settles rather than jumping when it lands. They carry no words; one
live region names the state for screen readers. Nothing spins: a spinner
says "wait" without saying for what, and the app's one spinner (the "Saving…"
trace in a note's header) marks an action in flight, not a page. Skeletons
never stand in for an empty corpus that is really empty — that state says
what it is (the offline notice, an empty list).

## Empty-block placeholder

An empty block **being edited** carries a ghost placeholder — “Ruminate…” —
at placeholder rank (`--color-text-tertiary`), as the textarea's native
`placeholder`. It is a quiet brand prompt, not teaching — the turn-into keys
live in the `?` reference — and it appears only there: never in view mode,
never in read-only views, never on the focused title (a page title, not a
block). It must not move layout — the empty row is clamped to one line
(`1lh`), so a placeholder that would wrap on a narrow screen clips instead of
growing the row.

## Motion

Durations and easings (`--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1)`,
`--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)`):

| What                                    | How                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hover affordances                       | opacity 150ms ease-out                                                                                                                           |
| Hover surfaces (crumbs, focus dot)      | background/color 150ms ease                                                                                                                      |
| Block line hover (neutral)              | background-color 100ms ease                                                                                                                      |
| Selection highlight                     | background-color + color + box-shadow 100ms ease                                                                                                 |
| Chevron rotation                        | transform 300ms ease-in-out, in step with the fold                                                                                               |
| Unfold (collapsed → open)               | the subtree's box's bottom edge sweeps down to reveal it, the rows below slide down, all transforms, 300ms ease-in-out, no fade: an accordion    |
| Fold (open → collapsed)                 | the box, out of the flow, its edge sweeping up to cover it as the rows below slide up over it, 300ms ease-in-out; its rows linger inert for it   |
| Todo check → text mutes                 | color 200ms ease                                                                                                                                 |
| Control press (chevron, bullet, number) | scale 0.90–0.95 while `:active`, 150ms                                                                                                           |
| Help panel (wide screen)                | its contents translate in from the page's edge and back out, with a fade, 300ms ease-in-out; the panel's width changes at once, never mid-motion |

Press feedback lives on the **control**, never the content: collapsing a
subtree gives the chevron a pressed scale and hover surface. Pressed scale is
removed under `prefers-reduced-motion`.

**Raised surfaces arrive and leave alike.** Every popup and modal is drawn
on `Surface` (src/components/ui/surface.tsx), and the motion is the surface's:
a fade from a slight scale about the point it is anchored to, and the same
back — a transition rather than an animation, so one dismissed while it is
still opening turns back smoothly instead of jumping. Written once, in both
vocabularies: Base UI marks a popup it holds `data-starting-style` and
`data-ending-style`; a surface nothing holds (the what's-new card) gets the
same two moments from the browser, `@starting-style` for the arrival and a
discrete `display` transition for the departure, with nothing to time in
JavaScript. The fade is unconditional and the scale is `motion-safe`, so
reduced motion keeps the one and is spared the other. Not everything raised
moves: the palette and the slash menu are opened by keys and used constantly,
and ask for `motion={false}`.

**The fold moves, but never lays out.** Rows render as nested subtrees
(`Subtree`, block-editor.tsx), and folding or unfolding is laid over the
state change afterwards (fold-motion.ts, the FLIP technique on the Web
Animations API): the editor is laid out once, in its final shape, then the
rows that moved slide from where they were on a `transform`, and the
parent's children — one box, its rows full size throughout — are revealed
or covered by the box's own bottom edge: the edge alone, no fade, the way
an accordion opens and shuts, at an accordion's pace. The edge is two
transforms under one clip that never animates (the box slides up by the
covered height, its body down by the same, so the rows hold still while
the cut moves), because every moving part must be the same kind of
animation on the same thread: an animated `clip-path` runs on the main
thread in some browsers and falls behind the rows, letting the departing
text show through them. A fold's ghost is a clone of the box's DOM,
outside React, out of the flow in the box's place, inert, and gone when
the fold is over — so a fold costs one render, the same as any click,
never a render of every hidden row into a ghost and out again; and every
measurement comes before every animation starts, so a long note is laid
out once, not once per row. Nothing moves until the change has landed:
the ghost's sweep starts with the slides, after the commit, however long
the store takes to deliver it (a sweep started at the click would be half
done before the rows below so much as moved, then measured mid-sweep and
slid back down over them). `e2e/fold-motion.e2e.mjs` (`npm run test:fold`)
watches all of this frame by frame in a real browser. The rows below — and whatever follows the
editor on the page — are in their final places at once and slide up over
the ghost. Everything is a transform on the compositor, so nothing
jitters, and it never holds the editor up: the state changes at once, so
`Space` on repeat is as quick as ever. Nothing clips at rest, so a to-do's
chevron beside its checkbox and a heading's hash, which reach beyond their
row, always show. Reduced motion swaps the motion for a short fade.

**What never animates:**

- Anything keyboard-initiated that repeats constantly: moving the selection with
  arrows gets only the 100ms color fade (perceptually instant), focus (`F`)
  swaps views instantly, the command palette opens with no entrance
  animation.
- Layout. Only `opacity`, `transform` and colors transition — never
  height, width, margin, padding, or a clip. The fold is the test case: it
  reads as a height change and is built without one.

`prefers-reduced-motion`: color/opacity fades stay (they aid comprehension);
transform-based motion (chevron rotation, expand rise) is removed.

## Things deliberately kept

- Dotted-underline links (app-wide identity; hover turns them solid).
- The e2e/test contract: `.bg-bg-secondary` on the selected line,
  `data-block-line`, `data-block-id`, `data-testid="block-body"`.
- Instant collapse/expand of subtrees (unmount) — the e2e suite asserts removal,
  and Emil's rule agrees: never animate a high-frequency keyboard action.
