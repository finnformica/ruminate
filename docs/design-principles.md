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
   hover surfaces) are invisible until the row is hovered or they hold focus, and
   they appear **without any layout shift** — always reserving their space, only
   fading opacity. Exception: a _collapsed_ block keeps its chevron visible, so
   hidden content is never a secret.
3. **Selection has its own color.** Hover is neutral (`--neutral-a3`); selection
   is accent (`--accent-a3`), matching `::selection`. A highlighted block must
   read as "selected", not "hovered". The structural class `bg-bg-secondary`
   stays on the line (tests and tooling select on it); `.block-highlight`
   layers the accent tint on top.
4. **View and edit are pixel-identical.** Every typographic property (size,
   weight, line-height, tracking) lives in `typographyFor` and is applied to both
   the rendered body _and_ the textarea. Nothing may style one branch only.
5. **Generous reading rhythm.** Body line-height is 1.65 (`leading-relaxed` —
   defined for real in `tailwind.config.cjs`; it was previously a silent no-op).
   Headings tighten as they grow (1.25 at the top of the scale).
6. **Markers align to a fixed gutter.** The collapse gutter is a fixed 24px
   square centered on the first line; the indent unit is 24px with the guide
   line under the gutter's center. Affordances float out of the flow
   (absolute/negative margin) so hover never moves text.
7. **One marker slot.** Every list marker — bullet dot, checkbox, ordered
   number — occupies the same 15px slot (the checkbox's width): dots center in
   it, numbers right-align to its edge. Body text therefore starts at one
   column across all marked block types.

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
the 24px indent (plus breadcrumbs when zoomed) carries the hierarchy from
there — piling on case/color/weight steps at the bottom of the outline would
promote chrome over content.

Zooming re-derives depth: the zoomed block's children start again at depth 0,
so a level-4 heading reads as a top-level section inside its own zoomed view.
The zoom title itself uses the **note-title scale** (3xl) — the zoomed block
_is_ the page — keeping a full step between it and its depth-0 children.

## Spacing

- **Block rhythm:** 2px gap between rows (`space-y-0.5`) + 2px vertical padding
  per line. Line-height carries the rest of the air.
- **Headings breathe above:** top margin scales with the heading — 20 / 16 / 10 /
  6px by depth. Space belongs _above_ a heading (it opens a section), never
  below.
- **Indent unit:** 24px per level (`ml-3` + `pl-3`), guide line at 12px.
- **Highlight inset:** highlighted line surfaces give the text 8px of horizontal
  breathing room, achieved with a negative-margin + padding pair (`-mx-1 px-2`;
  the note title uses `-mx-1 pl-9 pr-1`) so the **text never moves** — only the
  background extends outward, into the 4px gutter gap. The text column is sacred;
  surfaces flex around it.

## Radius family

One token family, sized by surface, never per-element drift:

| Token                  | Value | Used for                                       |
| ---------------------- | ----- | ---------------------------------------------- |
| `--border-radius-sm`   | 4px   | inline chips: inline code, transclusions, keys |
| `--border-radius-md`   | 6px   | line surfaces: block/title selection highlight |
| `--border-radius-base` | 8px   | controls, menu items                           |
| `--border-radius-lg`   | 12px  | block panels: code blocks, cards               |

The rule: the bigger the surface, the bigger the radius. All values derive from
`--border-radius-base`, so a theme that changes the base changes the whole
family with it.

## Color roles

| Role         | Light / dark token         | Used for                                    |
| ------------ | -------------------------- | ------------------------------------------- |
| Ink          | `--color-text` (sand-12)   | body, headings, checked-off text ink        |
| Muted        | `--color-text-secondary`   | quotes, done todos, ordered numbers, crumbs |
| Faint        | `--color-text-tertiary`    | bullet dots, chevron, placeholders, `#`     |
| Guide        | `--color-border-secondary` | indent guide lines (rest state)             |
| Structure    | `--color-border` (a7)      | quote bar, unchecked checkbox border        |
| Selection    | `--accent-a3` tint         | selected block(s), matches `::selection`    |
| Accent solid | `--accent-9`               | checked checkbox fill                       |
| Transclusion | `--accent-a2` tint         | `((ref))` embeds — quietly "live" content   |

All roles are Radix alpha/step tokens, so both color schemes (and print, which
remaps the semantic tokens) resolve automatically. Never hardcode a hex.

**User-selectable accent.** The `--accent-*` family is themable: a
`data-accent` attribute on `<html>` (persisted via `accentAtom`, picked in
Settings → Appearance) remaps the whole family onto another Radix ramp —
neutral (sand), green, violet, or amber — in `src/styles/variables.css`. Cyan
is the default and needs no attribute. Rules for a new accent:

- Remap **only** the accent tokens; every accent role above then follows.
- Both color schemes come free: the ramps themselves flip under
  `prefers-color-scheme` in `radix-colors.css`.
- Selection must stay distinct from hover. The neutral (grayscale) accent —
  the app's original pre-accent gray — would collide with the neutral hover
  surfaces, so its alpha steps are biased one step darker (selection lands on
  `sand-a4`, hover stays `sand-a3`).
- A light step 9 needs a dark checkmark: amber overrides the checked-checkbox
  glyph and sets `--accent-contrast` to its dark ink.

## Motion

Durations and easings (`--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1)`):

| What                                    | How                                    |
| --------------------------------------- | -------------------------------------- |
| Hover affordances                       | opacity 150ms ease-out                 |
| Hover surfaces (crumbs, marker zoom)    | background/color 150ms ease            |
| Selection highlight                     | background-color 100ms ease            |
| Chevron rotation                        | transform 200ms strong ease-out        |
| Expand (collapsed → open)               | children fade/rise in, 160ms ease-out  |
| Todo check → text mutes                 | color 200ms ease                       |
| Control press (chevron, bullet, number) | scale 0.90–0.95 while `:active`, 150ms |

Press feedback lives on the **control**, never the content: collapsing a
subtree gives the chevron a pressed scale and hover surface, but the content
itself unmounts instantly (see below). Pressed scale is removed under
`prefers-reduced-motion`.

**What never animates:**

- Anything keyboard-initiated that repeats constantly: moving the selection with
  arrows gets only the 100ms color fade (perceptually instant), collapse via
  `Space` unmounts instantly, zoom (`F`) swaps views instantly, the command
  palette opens with no entrance animation.
- Layout. Only `opacity`, `transform`, and colors transition — never width,
  height, margin, or padding.

`prefers-reduced-motion`: color/opacity fades stay (they aid comprehension);
transform-based motion (chevron rotation, expand rise) is removed.

## Things deliberately kept

- Dotted-underline links (app-wide identity; hover turns them solid).
- The e2e/test contract: `.bg-bg-secondary` on the selected line,
  `data-block-line`, `data-block-id`, `data-testid="block-body"`.
- Instant collapse/expand of subtrees (unmount) — the e2e suite asserts removal,
  and Emil's rule agrees: never animate a high-frequency keyboard action.
