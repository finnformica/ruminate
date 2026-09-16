Folded automatically by `.github/workflows/changelog.yml`. It could not be
pushed to `main` directly, because `main` is protected and requires changes to
go through a pull request.

Nothing here was written by hand: `npm run changelog:collate` merged the
pending `changelog.d/` fragments into this week's release, in the canonical
category order. It refuses to write anything at all if the changelog or any
fragment has a fault, so this only exists because everything parsed.

**This pull request was opened by `github-actions`, so GitHub will not start
the required checks on it.** Close and reopen it, or push any commit to it, to
run them.

To have future folds land on `main` without a pull request, either allow
`github-actions[bot]` to bypass the pull-request requirement in the branch
protection rule, or add a `CHANGELOG_TOKEN` secret holding a personal access
token that may push to `main`.
