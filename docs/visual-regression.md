# Visual regression

Screenshot-diff tests over the block editor's key Storybook stories, in both
light and dark color schemes. A pixel-level change to any covered story fails
the `visual-regression` CI job.

## How it works

- `e2e/visual-regression.mjs` (plain-node Playwright, same style as
  `e2e/block-editor.e2e.mjs`) screenshots each story listed in its `STORIES`
  table against a built Storybook, once per color scheme, with a fixed
  viewport, `deviceScaleFactor: 1`, animations/transitions frozen, and fonts
  loaded — so renders are deterministic on a given platform.
- Baselines are committed in `e2e/__vr_baselines__/`. Comparison uses
  pixelmatch with a 0.1% differing-pixel budget per image (override per story
  via `maxDiffRatio` in the `STORIES` table).
- On failure, `actual` / `expected` / `diff` images land in
  `e2e/__vr_artifacts__/` (gitignored); CI uploads them as the `vr-diffs`
  artifact.

## The platform guard

Font rasterization differs between macOS and Linux, so pixels rendered on one
OS never match baselines from the other. The baselines are therefore
**authoritative for CI's platform only** (`linux-x64`, recorded in
`e2e/__vr_baselines__/baseline-manifest.json`). When `--check` runs on any
other platform — e.g. a developer's Mac — it **skips with exit 0** and a
message, instead of failing falsely. Developers rely on CI for the verdict.

## Commands

- `npm run test:vr` — build Storybook, serve it, compare against baselines
  (what CI runs; skips on a non-baseline platform).
- `npm run test:vr:update` — same, but rewrite the baselines for _your_
  platform. Only useful locally for pipeline debugging; **never commit
  Mac-rendered baselines** — use the workflow below.

## Updating baselines (intentional visual changes)

1. Merge your visual change (the VR job on your PR will be red — that's the
   signal the change is visible; confirm via the `vr-diffs` artifact that the
   diff is exactly what you intended).
2. On GitHub, go to **Actions → Update VR baselines → Run workflow**. It
   re-renders every story on `ubuntu-latest` and opens a PR
   (branch `vr/update-baselines`) containing only the new PNGs + manifest.
3. Review that PR by eyeballing the image diffs in _Files changed_ (GitHub's
   swipe / onion-skin views). Every changed image must correspond to your
   intentional change; anything unexpected is a real regression about to be
   baked into the baselines.
4. Merge it. The VR job is green again.

Note: the repo setting **Settings → Actions → General → "Allow GitHub Actions
to create and approve pull requests"** must be enabled for the update workflow
to open its PR.

## First-time setup

Baselines cannot be seeded from a Mac. Until the update workflow has been
dispatched once, the manifest carries a non-CI platform key (or is absent) and
the CI job **skips** rather than checks. So, once after this suite lands on
`main`: dispatch **Update VR baselines** and merge its PR. From then on the
job enforces.

## Adding or removing covered stories

Edit the `STORIES` table in `e2e/visual-regression.mjs`, then dispatch the
update workflow — it writes baselines for new entries and prunes stale ones.
Until then, a new story fails `--check` in CI with "no baseline".
