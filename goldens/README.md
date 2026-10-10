# Goldens

Branch-keyed reference PNGs for the visual-diff CI. **One golden per fixture**:
each file is a screenshot of one template family's **overlay render** against
one operator-managed fixture (`fixtures/<git_path>/<slug>.json`) — the document
body rendered into the component layout with the concatenated stylesheet (the
same overlay `scripts/preview.ts` and the api-cloudrun render pipeline perform),
rasterized HTML→PNG via Gotenberg's Chromium screenshot route with a **frozen**
render timestamp so output is byte-deterministic.

⚠️ **"One per fixture" is enforced, not just documented.** Once a family has at
least one PNG on a branch it has GRADUATED there, and `deno task lint:fixtures`
then fails on any fixture without a baseline, or any baseline without a fixture.
A family with no PNG on a branch has not graduated and is skipped, which is what
keeps the empty `sandbox` tree silent. The rule exists because a fixture with no
golden is not a gap the CI reports — it renders and returns `no-golden`, an
informational PASS — so the branch it was added to cover stays ungated while
every check is green. Clear the failure by **approving the renders**.

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

## Re-blessing after a renderer upgrade

Goldens change only by a **deliberate bless** — after an intentional visual
change (approve the renders on the draft that made it), or after a
Gotenberg/Chromium upgrade that legitimately shifts rendering.

After a renderer upgrade, no laptop or checkout is needed. In the manager, use
**Check renders** on a template (or **Check all renders** on the templates
list); over MCP, `templates_check_renders`; over HTTP,
`POST /templates/{uid}/check-renders` or `POST /templates/check-renders`. The
check renders every fixture with that environment's renderer, at the head of the
family's open draft (it opens one if there is none), compares each against this
branch's golden, and saves the verdicts onto the draft. Then review the diffs in
the draft's visual-diff panel, **Approve the renders** you accept, and release
and merge the draft as usual.

- **It never blesses.** A renderer upgrade is when a real regression can arrive
  looking like noise, so the diffs are reviewed first.
- **If every render still matches**, a draft the check opened is abandoned and
  nothing is left behind. A draft it reused is always kept.
- **Each environment checks its own namespace.** Prod compares against
  `goldens/main/`, dev against `goldens/sandbox/`, because CI compares a PR
  against the API of the branch it targets. Run the check in both
  environments. A bless writes its own namespace and seeds another only where a
  baseline is missing; it never overwrites one.

`scripts/rebless-goldens.ts` in api-cloudrun is still there as engineering
tooling (a local dry run, or a bless without the API). Its operator recipe,
including the impersonated Gotenberg token it needs, is in api-cloudrun's
`gotenberg` skill.
