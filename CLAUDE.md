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

`it.doc`, `it.version`, `it.params`, `it.now` (frozen render timestamp — never `new Date()`), `it.holidays` (CFS holiday ISO dates `YYYY-MM-DD[]`, live snapshot — feeds the `it.dates.*` holiday helpers, which throw if omitted; absent in layouts), `it.logo`, `it.dateFns` (date-fns v4), `it.tz` (`@date-fns/tz`), `it.currency` (currency.js), `it.orders` (`@cfs/core/utils/orders`), `it.dates` (`@cfs/core/utils/dates`). Injected by `api-cloudrun/src/lib/templates/eta.ts`; `scripts/preview.ts` mirrors it. Full semantics, data shapes, and authoring patterns: `cfs-template-authoring` skill.

## Local preview

`deno task preview [name] [fixture-slug]` renders a template + fixture to `preview.html` with the same overlay the API performs (component styles → template styles → layout), prints the rendered `filename`, and inlines the footer partial below the body to confirm it parses. `deno task preview:watch` re-renders on change.

## Dependencies

`@cfs/core` uses a **floating caret range** (`^10.0.0-beta.N`) so the preview harness tracks the latest published beta — the same package line `api-cloudrun` renders with. After a `@cfs/core` publish, refresh the lock: `deno outdated --update` (or `rm deno.lock && deno install`). A new major (e.g. `11.0.0-beta.1`) requires editing the range. Never hard-pin to an old beta — preview output silently diverges from server renders.

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.
