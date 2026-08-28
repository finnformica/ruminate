# Visual regression testing

Screenshot-diff checks over the key block-editor Storybook stories (light +
dark), run as the `visual-regression` job in CI. If a story's rendering
changes beyond a tiny threshold, CI fails and uploads readable
actual/expected/diff images in the `vr-output` artifact.

## How baselines work

- Baselines live in `e2e/__vr_baselines__/` and are authoritative for **CI's
  platform** (linux-x64). Font rendering differs across OSes, so local
  `npm run test:vr` on a different platform skips instead of false-failing.
- Every CI run — pass or fail — also publishes a `refreshed/` set inside the
  `vr-output` artifact: the current code's rendering, ready to become the new
  baselines.

## Accepting a visual change (or seeding a new platform)

1. Let CI run on your change. If the VR job fails, eyeball the diff images in
   the `vr-output` artifact — confirm the change is intended.
2. Locally: `npm run test:vr:accept` (latest completed main run, or pass a run
   id: `npm run test:vr:accept -- <run-id>`). Requires an authenticated
   GitHub CLI.
3. Review `git diff --stat e2e/__vr_baselines__`, commit, push. The next CI
   run compares against the new baselines.

There is no automation that writes baselines to the repo — a human (or the
orchestrating agent) always reviews and commits them.

## Adding a story

Add it to the `STORIES` table in `e2e/visual-regression.mjs` (story id, a
`waitFor` selector, optional per-story `maxDiffRatio`), then accept baselines
as above.
