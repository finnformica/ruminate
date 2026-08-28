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
3. **Selection has its own color.** Hover is neutral; selection is accent. A
   block line hovers at a whisper (`--neutral-a2`, editable editors only —
   never read-only views, the row being edited, or a selected row) and selects
   in **solid** accent (`--accent-3` light / `--accent-4` dark). A highlighted
   block must read as "selected", not "hovered", and selection always wins
   visually. The surface is solid rather than an alpha tint: alpha over the
   warm sand background muddies the hue (worst in dark mode), and solid paint
   lets adjacent selected lines merge seamlessly. The structural class
   `bg-bg-secondary` stays on the line (tests and tooling select on it);
   `.block-highlight` paints the accent surface on top.
   **Selection follows the keyboard.** The accent surface is a promise that
   arrows work here, so it only shows while the editor actually owns the
   keyboard (focus inside its container). Whenever focus is elsewhere — the
   sidebar, a dialog, the `?` reference, the ⌘P palette mid-preview — the
   selection demotes to a quiet solid neutral (`--neutral-3`, the additive
   `.block-highlight-inactive` class), Finder/VS Code-style: still visibly the
   selection, no longer claiming the keys. Accent-independent, so all five
   accents and both schemes share one inactive surface; for the Neutral accent
   it sits one step above the `--neutral-a2` hover and one below its sand-4
   active selection. Restoration rides the same 100ms background fade —
   perceptually instant.
   The same accent family marks "current" outside the editor: the sidebar's
   active nav row / open note (`--accent-a3` tint, accent-12 ink) and the
   notes/tags list keyboard highlight (`.list-highlight`, the selection
   surface verbatim) — one color always means "you are here / keys act here".
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
  (symmetric — 8px inner padding each side, the surface extending 4px past the
  text column on both) and 4px of vertical breathing room, achieved with
  negative-margin + padding pairs (`-my-1 py-1` plus `-mx-1 px-2`; the note
  title's `-mx-1 pl-9 pr-1` extends the same 4px left) so the **text never
  moves** — only the background extends outward, into the gutter gap and the
  inter-row space. Block rhythm is untouched: the surface borrows the space
  between rows, it never adds any. The text column is sacred; surfaces flex
  around it.
- **Multi-select reads as one surface.** The vertical growth makes consecutive
  selected lines touch, so a Shift+Arrow run merges into a single continuous
  solid surface: corners where two selected surfaces meet go straight
  (`selectionRunEdges` in `block-editor.tsx`), rounded only at the run's top
  and bottom. A heading's top margin (or the zoom title's bottom margin) keeps
  a real gap, so those boundaries stay rounded.

## Radius family

One token family, sized by surface, never per-element drift:

| Token                  | Value | Used for                                         |
| ---------------------- | ----- | ------------------------------------------------ |
| `--border-radius-sm`   | 4px   | inline chips: inline code, transclusions, keys   |
| `--border-radius-base` | 8px   | line surfaces (block/title highlight) & controls |
| `--border-radius-lg`   | 12px  | block panels: code blocks, cards                 |

The rule: the bigger the surface, the bigger the radius. All values derive from
`--border-radius-base`, so a theme that changes the base changes the whole
family with it. (There is no intermediate 6px step any more — line surfaces
share the control radius; the old `--border-radius-md` read as too sharp on a
full-width highlight.)

## Color roles

| Role         | Light / dark token         | Used for                                    |
| ------------ | -------------------------- | ------------------------------------------- |
| Ink          | `--color-text` (sand-12)   | body, headings, checked-off text ink        |
| Muted        | `--color-text-secondary`   | quotes, done todos, ordered numbers, crumbs |
| Faint        | `--color-text-tertiary`    | bullet dots, chevron, placeholders, `#`     |
| Guide        | `--color-border-secondary` | indent guide lines (rest state)             |
| Structure    | `--color-border` (a7)      | quote bar, unchecked checkbox border        |
| Hover        | `--neutral-a2` tint        | non-selected block lines under the pointer  |
| Selection    | `--accent-3` / `-4` solid  | selected block(s) — light step 3, dark 4    |
| Inactive sel | `--neutral-3` solid        | the selection while the editor lacks focus  |
| Current      | `--accent-a3` tint         | sidebar active route / open note row        |
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
  surfaces, so its alpha steps are biased one step darker, and the solid
  block-selection surface follows the same bias (`.block-highlight` lands on
  `--accent-4` = `sand-4` for neutral, in both schemes — see
  `block-editor.css`), keeping a clear step above the `--neutral-a2` line
  hover.
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

## Empty-block teaching

An empty block **being edited** carries a ghost placeholder —
“Type, or press `#` heading · `-` list · `[` todo” — at placeholder rank
(`--color-text-tertiary`), as the textarea's native `placeholder`. It teaches
the turn-into keys exactly where they apply, and only there: never in view
mode, never in read-only views, never on the zoomed title (a page title, not a
block). It must not move layout — the empty row is clamped to one line
(`1lh`), so a placeholder that would wrap on a narrow screen clips instead of
growing the row.

## Motion

Durations and easings (`--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1)`):

| What                                    | How                                    |
| --------------------------------------- | -------------------------------------- |
| Hover affordances                       | opacity 150ms ease-out                 |
| Hover surfaces (crumbs, marker zoom)    | background/color 150ms ease            |
| Block line hover (neutral)              | background-color 100ms ease            |
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
