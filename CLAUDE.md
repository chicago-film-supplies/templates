# CLAUDE.md

## Overview

HTML/Eta templates rendered server-side (via `api-cloudrun`) into PDFs using Gotenberg.

**Git-canonical.** Git is the source of truth for template *content*; Firestore is a rebuildable projection (family doc + `templates-versions`). This repo is the canonical content store and an ad-hoc local-dev/preview harness; the production editing surface lives in `manager/`.

**Environments.** Prod publishes from `main`; dev/staging publishes from `sandbox`. **`sandbox` exists to exercise the tooling & publish *workflow*, not to stage content** — it's a *disposable mirror* of `main`, force-resynced to fresh `main` as routine practice. Stage content the same way for both envs: **branch `main`** → draft → PR → merge. **Never author canonical content directly on `sandbox`** — a commit made only there never reaches prod and forks the branches (this caused templates#22).

**Authoring reference:** the `cfs-template-authoring` skill (plugin `cfs-skills@cfs`, auto-installed via `.claude/settings.json`) is the canonical deep reference — render context (`it.*`), sidecar schema, overlay semantics, order data shape, price fields, fixtures/goldens. Consult it before writing template content. The pipeline side (lifecycle, publish invariants, golden gate, RBAC) is `api-cloudrun/.claude/skills/templates/SKILL.md`.

## Repo layout (sidecar + convention)

```
templates/<name>.eta                    document body partial (rendered with `it`)
templates/<name>.meta.json              sidecar: display_name, collection_source/target, surfaces[], depends_on.components[], params[], fixtures[], render{}
layouts/<name>.eta                      component layout skeleton (wraps the body via `it.body`, injects `it.styles`)
styles/<name>.css                       per-template OR per-component stylesheet
partials/<template>/<part>.eta          render-config partials (footer/header), rendered with the same `it` context
template-components/<name>.meta.json    component sidecar: display_name + files[] manifest
fixtures/<template>/<slug>.json         deterministic source docs for golden visual-diff (operator-managed; PII sanitized on capture)
goldens/<branch>/<template>/<slug>.png  branch-keyed golden screenshot, one per fixture
```

Fixtures are **files-authoritative for discovery**: the renderer globs `fixtures/<template>/*.json` and the sidecar's `fixtures[]` supplies each entry's label and reason. An orphaned sidecar entry never breaks a render; zero fixtures yields a `no-fixtures` golden verdict (informational pass).

⚠️ **Every sidecar entry must say WHY its fixture exists** — what it covers that no other fixture in the family does. `description` is required (`@cfs/core`'s `FixtureMeta`), the API refuses a write without one, and `deno task lint:fixtures` fails a missing or placeholder reason (minimum 40 characters). This is not bookkeeping: a fixture set *is* a coverage argument, and the fixture file is a `z.strictObject` source document with nowhere to put a comment, so the sidecar is the only place that argument can be written down. A fixture that is synthetic because no real order exercises its shape must say so, or the next person "cleans it up".

**Never hand-write a fixture from real data.** `PUT /templates/{uid}/fixtures/{slug}` (and the manager's JSON textarea) commit exactly what you give them — dev mirrors prod, so a dev order carries real customer names, contacts and addresses. Capture instead: the manager's capture action / MCP `templates_capture_fixture` runs the document through `applyPii` with a deterministic salt first. The PII pass in `lint:fixtures` is the net for when that is skipped.

The sidecar's `render` block (`margin_*`, `base_font_size`, `filename` as an Eta string, `footer`/`header` partial paths) drives Gotenberg PDF generation — full field semantics in the `cfs-template-authoring` skill.

## Template context (summary)

**Always on:** `it.doc` (the **source** document — a template never reads its target, it produces it), `it.version`, `it.params`, `it.now` (frozen render timestamp — never `new Date()`), `it.holidays` (CFS holiday ISO dates `YYYY-MM-DD[]`, live snapshot — feeds the `it.dates.*` holiday helpers, which throw if omitted; absent in layouts), `it.logo`, `it.dateFns` (date-fns v4), `it.tz` (`@date-fns/tz`), `it.money` (`@cfs/core/utils/money`), `it.dates` (`@cfs/core/utils/dates`), `it.icons` (`@cfs/core/utils/icons`).

⚠️ **`it.currency` is gone.** Phase 11 Phase E withdrew currency.js from the render context entirely, `money-lint.yml`'s budget is **zero**, and `quote.eta` has no remaining call sites — so any `it.currency` reference now fails CI *and* would throw at render. Use `it.money.formatCents(doc.total_cents)`.

### Icons

`it.icons.svg(name, opts)` returns **inline SVG** for any lucide icon; `it.icons.has(name)` gates a data-driven name. Emit raw — `<%~ it.icons.svg("truck") %>`, not `<%= %>`.

Inline is the only shape available, not a preference: both render paths set Gotenberg's `failOnResourceLoadingFailed=true`, and header/footer partials render in an isolated Chromium frame that loads **no** external resources at all. An icon font, a CDN sprite and an `<img src>` each fail the whole document. Never paste raw `<svg>` into an `.eta` instead — besides the duplication, a self-closing `/>` next to a money-named identifier is a plausible false positive for `money-lint.yml`'s Rule 3.

An unknown name **throws** (listing near matches) rather than rendering nothing — a blank icon is invisible in a PDF and would ship.

### Money (`money-lint` enforces this)

**A template must not compute money.** Values arrive already computed by `@cfs/core/utils/*`, which are verified against exact BigInt rational references over 200k–500k inputs. `.github/workflows/money-lint.yml` fails CI on `.divide(` / `.multiply(` / `.distribute(` in any `.eta` — zero sites, permanently, no allowlist. currency.js quantizes every intermediate at its `precision`, so those operations make a rounding decision nothing states: measured, the precomputed-factor form was wrong 199,998 of 200,000 times, worst error $32,031.20.

**`it.currency` is now banned outright, and the budget is ZERO** (verified 2026-08-13: `money-lint.yml`'s budget map is empty and `quote.eta` has 0 call sites). It was a per-file budget of 19 grandfathered sites while `it.money.formatCents` took **cents** and template documents held **dollars** — every replacement would have read `it.money.formatCents(it.money.toCents(x))`, worse than what it replaced. Documents are cents-denominated now, so `it.money.formatCents(doc.total_cents)` is the natural form and the trade flipped exactly as predicted. The injection is gone from the render context too, so a stray reference throws as well as failing CI.

Deep reference: the `cfs-money` skill → *"The ratchets"*.

**Collection-dependent — `it.orders` is NOT guaranteed:** the `@cfs/core/utils` namespaces a template gets are the union of its `collection_source` + `collection_target` namespaces (`orders` → `it.orders`, `invoices` → `it.invoices`; `quotes`/`packing_lists` contribute none). The quote template (orders → quotes) gets `it.orders` and NOT `it.invoices`; an invoices-source template gets the reverse. Resolved by `availableUtilNamespaces` (`@cfs/core/schemas`), which `api-cloudrun/src/lib/templates/eta.ts` (render), `goldenDiff.ts` (golden gate) and `scripts/preview.ts` (this harness) all funnel through, so preview, gate and prod cannot diverge. Calling a namespace your collections don't resolve to throws at render — and fails the golden gate. Full semantics, data shapes, and authoring patterns: `cfs-template-authoring` skill.

## Local preview

`deno task preview [name] [fixture-slug]` renders a template + fixture to `preview.html` with the same overlay the API performs (component styles → template styles → layout), prints the rendered `filename`, and inlines the footer partial below the body to confirm it parses. `deno task preview:watch` re-renders on change.

**A util namespace this harness cannot provide is a hard error, deliberately.** `UTIL_MODULES` in `scripts/preview.ts` must mirror the server's (`api-cloudrun/src/lib/templates/eta.ts`); if it doesn't, the resolver throws and names the fix. It used to skip silently, and that is how `money` came to be missing here while the server injected it — and `money` is in core's `ALWAYS_ON_UTIL_NAMESPACES`, so *every* template requests it. The result was that the first `it.money.*` call rendered correctly in production and died here with `Cannot read properties of undefined`, which reads as a template bug rather than a harness one. This repo has no test suite, so the throw is the guarantee (the server side is covered by `renderUtilNamespaces.test.ts`). **Do not re-add a silent skip.**

## Goldens are DEFERRED, not missing

`goldens/` holds a README and two `.gitkeep` and **zero PNGs**, so every fixture
yields verdict `no-golden` → **PASS** and `visual-diff` cannot fail. That is the
intended state, not a gap to close.

**There is no live template yet.** `quote` is the only one and it is still WIP,
so a golden would lock a design that is still moving — every iteration would
need re-blessing, which is churn, not signal. A golden is a *freeze*, and you
freeze a thing once it has stopped moving.

This is the same convention `manager` already documents for its Playwright
screenshots (*"convergence, not freeze… a surface gets a `toHaveScreenshot`
pixel lock only once it reaches the design-system standard"*, via its
`GRADUATED` list). Bless `goldens/main/<template>/*` and
`goldens/sandbox/<template>/*` from `api-cloudrun/scripts/rebless-goldens.ts`
when a template **graduates** — not before.

⚠️ **What a golden would NOT have caught, so do not reach for one as the
answer.** Neither fixture exercises a discount or a transaction fee — measured
2026-08-07: 0 discounts and 0 `transaction_fees` across 18 line items in the two
fixtures — so **5 of `quote.eta`'s 19 `it.currency` sites sit in branches
nothing renders** (`:215`, `:220`, `:254`, `:258`, `:273`). A golden compares
what was rendered; it is silent about a branch that never ran. Fixture
*coverage* and golden *stability* are different problems, and only the first one
is live today.

## Dependencies

`@cfs/core` is **exact-pinned** (`jsr:@cfs/core@10.0.0-beta.N/...`, one entry per subpath), and moves in lockstep with `api-cloudrun/deno.json` + `manager/package.json` on every publish — same day, same version, per `feedback_bump_all_core_consumers_lockstep`.

**It used to be a floating caret range, and the range is exactly what let this repo drift.** The point of floating was that preview would track whatever the API renders with; what it actually did was let `main` sit on `^beta.62` while api-cloudrun was 50+ betas ahead, because nothing re-resolved the lock and nothing failed when it didn't. A pin cannot drift silently — it either matches the other two repos or it is visibly wrong. Bump it by editing the specifiers and running `deno install`.

The `minimumDependencyAge` exclusion for `jsr:@cfs/core` at the top of `deno.json` is load-bearing, not a convenience: Deno 2.9 refuses any package version younger than 24h, so without it `deno install` here fails outright for a full day after every core publish. The exclusion names that one first-party package and leaves the 24h supply-chain delay in force for everything else.

**If a freshly published beta looks missing, suspect the JSR CDN before the publish** — `meta.json` has served stale for 6+ hours (workspace CLAUDE.md §2a).

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.
