# Goldens

Branch-keyed reference PNGs for the visual-diff CI. **One golden per fixture**:
each file is a screenshot of one template family's **overlay render** against
one operator-managed fixture (`fixtures/<git_path>/<slug>.json`) — the document
body rendered into the component layout with the concatenated stylesheet (the
same overlay `scripts/preview.ts` and the api-cloudrun render pipeline perform),
rasterized HTML→PNG via Gotenberg's Chromium screenshot route with a **frozen**
render timestamp so output is byte-deterministic.

```
goldens/<branch>/<git_path>/<slug>.png
```

- `<branch>` is the PR's **base** branch: `main` (prod-tracking) or `sandbox`
  (dev-tracking). A PR is compared against the goldens for the branch it targets.
- `<git_path>` is the template family's immutable slug (e.g. `quote`).
- `<slug>` matches a fixture file at `fixtures/<git_path>/<slug>.json`. Fixtures
  are operator-managed in the manager (capture from a live Typesense doc, edit
  inline, sanitized for PII on capture). The sidecar's `fixtures: [{slug, label,
  description?}]` enriches the manager list — files in `fixtures/<git_path>/`
  remain authoritative.

## How it's used

`.github/workflows/visual-diff.yml` runs on every PR. For each changed template
`git_path` (a shared-asset change fans out to all families), it calls the API's
`POST /templates/golden-diff`, which renders the PR's content at `GITHUB_SHA`
against every fixture in `fixtures/<git_path>/`, screenshots each, and
pixel-compares against `goldens/<base-branch>/<git_path>/<slug>.png` — one
verdict per fixture. The CI aggregate is:

- **match** — every fixture is within the per-image pixel threshold → PASS.
- **no-golden** — at least one fixture has no committed golden yet → PASS; the
  candidate(s) are uploaded for a reviewer to bless.
- **diff** — any fixture differs from its golden → FAIL (each affected fixture's
  candidate + diff image URLs are printed).
- **renderer-unavailable** — Gotenberg was unreachable for at least one fixture
  (cold start / outage) → retried with backoff; a persistent outage FAILs with
  a message clearly distinct from a pixel diff (not a regression — retry).
- **no-fixtures** — the family has no fixtures in git → PASS, no render attempted.
  Capture a source doc in the manager to enable golden review.

## Regenerating (the re-bless ritual)

Goldens change only by a **deliberate re-bless** — after an intentional visual
change, or after a Gotenberg/Chromium upgrade that legitimately shifts
rendering. Regenerate from the api-cloudrun repo:

```bash
# dry-run (shows which goldens would change + pixel delta), against dev Gotenberg:
cd ../api-cloudrun
GOTENBERG_URL_DEV=<gotenberg-url> deno run \
  --allow-env --allow-net --allow-read --allow-write \
  scripts/rebless-goldens.ts --branch=main --env=dev

# write them:
GOTENBERG_URL_DEV=<gotenberg-url> deno run -A scripts/rebless-goldens.ts \
  --branch=main --env=dev --write
```

Then commit the updated PNGs in the same PR as the visual change. The script
reads templates from this repo (`TEMPLATES_REPO_DIR`, default `../templates`),
assembles each overlay locally, and uses the same frozen render timestamp as CI.
