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

Fixtures are **files-authoritative**: the renderer globs `fixtures/<template>/*.json` and the sidecar's `fixtures[]` is a label/description join. An orphaned sidecar entry never breaks a render; zero fixtures yields a `no-fixtures` golden verdict (informational pass).

The sidecar's `render` block (`margin_*`, `base_font_size`, `filename` as an Eta string, `footer`/`header` partial paths) drives Gotenberg PDF generation — full field semantics in the `cfs-template-authoring` skill.

## Template context (summary)

**Always on:** `it.doc` (the **source** document — a template never reads its target, it produces it), `it.version`, `it.params`, `it.now` (frozen render timestamp — never `new Date()`), `it.holidays` (CFS holiday ISO dates `YYYY-MM-DD[]`, live snapshot — feeds the `it.dates.*` holiday helpers, which throw if omitted; absent in layouts), `it.logo`, `it.dateFns` (date-fns v4), `it.tz` (`@date-fns/tz`), `it.currency` (currency.js — **legacy, budgeted; see Money below**), `it.money` (`@cfs/core/utils/money`), `it.dates` (`@cfs/core/utils/dates`).

### Money (`money-lint` enforces this)

**A template must not compute money.** Values arrive already computed by `@cfs/core/utils/*`, which are verified against exact BigInt rational references over 200k–500k inputs. `.github/workflows/money-lint.yml` fails CI on `.divide(` / `.multiply(` / `.distribute(` in any `.eta` — zero sites, permanently, no allowlist. currency.js quantizes every intermediate at its `precision`, so those operations make a rounding decision nothing states: measured, the precomputed-factor form was wrong 199,998 of 200,000 times, worst error $32,031.20.

**`it.currency` is on a per-file budget, not banned** — 19 grandfathered call sites in `templates/quote.eta`, and the budget **ratchets down**: a file whose count drops below its budget fails until the number is lowered. New money display uses `it.money`. It is not withdrawn outright because `it.money.formatCents` takes **cents** while template documents hold **dollars**, so every site would become `it.money.formatCents(it.money.toCents(x))` — worse than what it replaces. It retires when documents are cents-denominated, at which point `it.money.formatCents(doc.total_cents)` is the natural form.

Deep reference: the `cfs-money` skill → *"The ratchets"*.

**Collection-dependent — `it.orders` is NOT guaranteed:** the `@cfs/core/utils` namespaces a template gets are the union of its `collection_source` + `collection_target` namespaces (`orders` → `it.orders`, `invoices` → `it.invoices`; `quotes`/`packing_lists` contribute none). The quote template (orders → quotes) gets `it.orders` and NOT `it.invoices`; an invoices-source template gets the reverse. Resolved by `availableUtilNamespaces` (`@cfs/core/schemas`), which `api-cloudrun/src/lib/templates/eta.ts` (render), `goldenDiff.ts` (golden gate) and `scripts/preview.ts` (this harness) all funnel through, so preview, gate and prod cannot diverge. Calling a namespace your collections don't resolve to throws at render — and fails the golden gate. Full semantics, data shapes, and authoring patterns: `cfs-template-authoring` skill.

## Local preview

`deno task preview [name] [fixture-slug]` renders a template + fixture to `preview.html` with the same overlay the API performs (component styles → template styles → layout), prints the rendered `filename`, and inlines the footer partial below the body to confirm it parses. `deno task preview:watch` re-renders on change.

## Dependencies

`@cfs/core` is **exact-pinned** (`jsr:@cfs/core@10.0.0-beta.N/...`, one entry per subpath), and moves in lockstep with `api-cloudrun/deno.json` + `manager/package.json` on every publish — same day, same version, per `feedback_bump_all_core_consumers_lockstep`.

**It used to be a floating caret range, and the range is exactly what let this repo drift.** The point of floating was that preview would track whatever the API renders with; what it actually did was let `main` sit on `^beta.62` while api-cloudrun was 50+ betas ahead, because nothing re-resolved the lock and nothing failed when it didn't. A pin cannot drift silently — it either matches the other two repos or it is visibly wrong. Bump it by editing the specifiers and running `deno install`.

The `minimumDependencyAge` exclusion for `jsr:@cfs/core` at the top of `deno.json` is load-bearing, not a convenience: Deno 2.9 refuses any package version younger than 24h, so without it `deno install` here fails outright for a full day after every core publish. The exclusion names that one first-party package and leaves the 24h supply-chain delay in force for everything else.

**If a freshly published beta looks missing, suspect the JSR CDN before the publish** — `meta.json` has served stale for 6+ hours (workspace CLAUDE.md §2a).

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.
