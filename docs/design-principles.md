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
   zoom magnifier) are invisible until the row is hovered or they hold focus, and
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
still reads as a heading at body size without shouting.

## Spacing

- **Block rhythm:** 2px gap between rows (`space-y-0.5`) + 2px vertical padding
  per line. Line-height carries the rest of the air.
- **Headings breathe above:** top margin scales with the heading — 20 / 16 / 10 /
  6px by depth. Space belongs _above_ a heading (it opens a section), never
  below.
- **Indent unit:** 24px per level (`ml-3` + `pl-3`), guide line at 12px.
- **Highlight inset:** the selection/hover pill hugs the line with 4px horizontal
  padding and a 4px radius — soft, but clearly a rectangle of text, not a chip.

## Color roles

| Role         | Light / dark token         | Used for                                  |
| ------------ | -------------------------- | ----------------------------------------- |
| Ink          | `--color-text` (sand-12)   | body, headings, checked-off text ink      |
| Muted        | `--color-text-secondary`   | quotes, done todos, list markers, crumbs  |
| Faint        | `--color-text-tertiary`    | chevron, magnifier, placeholders, `#`     |
| Guide        | `--color-border-secondary` | indent guide lines (rest state)           |
| Structure    | `--color-border` (a7)      | quote bar, unchecked checkbox border      |
| Selection    | `--accent-a3` tint         | selected block(s), matches `::selection`  |
| Accent solid | `--accent-9`               | checked checkbox fill                     |
| Transclusion | `--accent-a2` tint         | `((ref))` embeds — quietly "live" content |

All roles are Radix alpha/step tokens, so both themes (and e-paper / print,
which remap the semantic tokens) resolve automatically. Never hardcode a hex.

## Motion

Durations and easings (`--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1)`):

| What                                   | How                                   |
| -------------------------------------- | ------------------------------------- |
| Hover affordances (chevron, magnifier) | opacity 150ms ease-out                |
| Hover surfaces (crumbs, marker zoom)   | background/color 150ms ease           |
| Selection highlight                    | background-color 100ms ease           |
| Chevron rotation                       | transform 200ms strong ease-out       |
| Expand (collapsed → open)              | children fade/rise in, 160ms ease-out |
| Todo check → text mutes                | color 200ms ease                      |

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
