# CLAUDE.md

## Overview

HTML/Eta templates rendered server-side (via `api-cloudrun`) into PDFs using Gotenberg.

**Git-canonical — for PUBLISHED content.** Git is the source of truth for published template *content*; the Firestore family doc + `published` versions are a rebuildable projection of it. This repo is the canonical content store and an ad-hoc local-dev/preview harness; the production editing surface lives in `manager/`.

⚠️ **A `draft` version is NOT a projection, and reading "Firestore is a rebuildable projection" as one rule is what makes the failures below invisible.** A draft's Firestore `content` map is **primary storage for work that exists nowhere else** — `save` writes Firestore only, and the branch is cut at create and then shadows it. For the lifetime of an uncommitted draft the invariant is inverted: the projection is the only copy. Published content is rebuildable; a draft is not.

**Editing an open draft: MCP tools, not raw git.** The two stores do not sync in *either* direction, so whichever one you write is the only one that moves.

- `templates_propose_edit` writes the Firestore draft and **never reaches git** — `commit_draft` / `release_draft` are what do. A draft can accumulate arbitrary work invisible to `git log`. This is not hypothetical: 18 edits (v41 → v66, 2026-08-11/12) were lost that way and had to be reconstructed from a session transcript. **templates#79.**
  - **The system now says so, so believe it rather than tracking it yourself.** `propose_edit` warns on every save that leaves the draft ahead of its branch; `templates_abandon_draft` refuses **422 `DRAFT_HAS_UNCOMMITTED_WORK`** (pass `force` to discard on purpose); and the manager badges the branch row and the editor **"not in git"**. All three read `committed_content_hash`, which is stamped at create as well as commit/release. **A silent abandon is now a bug, not the expected behaviour.**
- A `git commit` on a `draft/*` branch **never reaches Firestore.** The manager preview and `templates_render_preview` go on serving the pre-edit content. Measured 2026-08-14 on `draft/quote/32918fe7`: the Firestore family was last written at 14:38:45 CDT (draft creation) and the git commit landed at 15:06:45 — the draft never moved, and the edit was invisible to every surface except the git working tree and the PR diff.

So while a draft is open, author through `templates_create_draft` → `templates_propose_edit` → `templates_commit_draft` → `templates_release_draft` (which opens the PR — **agents open, humans merge**). That is the one path that leaves both stores in step, and it is what the manager and the golden gate read. If you have already edited via git, re-apply the same content through `templates_propose_edit` to resync rather than leaving the two divergent.

Raw git stays correct for everything that is *not* template content under an open draft: `scripts/`, workflows, fixtures on disk, this file, and reviewing the PR a release opened.

### Who merges: it depends on what the PR CHANGES, not on who opened it

⚠️ **"Agents open, humans merge" is about template CONTENT, and reading it as a blanket rule is what left pin bumps sitting open.** The two kinds of PR that reach this repo are not the same risk:

| PR | merged by | why |
|---|---|---|
| **template content** (anything a `templates_release_draft` opens) | **a human** | it changes what a customer receives, and `visual-diff` green means "rendered without erroring", not "renders correctly" |
| **`@cfs/core` pin bump** — only `deno.json` + `deno.lock`, all six exactly-pinned entries | **agents merge automatically** | mechanical and verifiable: nothing here imports the propagation catalog, `deno check` over the tracked TypeScript either passes or does not, and the alternative is a PR per publish accumulating unmerged while the other three repos have already moved |

**Alex, 2026-08-18: "merge automatically"** — standing, for the pin-bump row only. It does not extend to a PR that touches template content, a fixture, a golden or a workflow, even when an agent opened it and even when CI is green. If a bump PR touches anything beyond `deno.json`/`deno.lock`, it is not this row.

⚠️ **This repo is the durable home for that rule.** It also lives in the workspace `~/cfs/CLAUDE.md`, which is **untracked and machine-local** (api-cloudrun#530) and therefore invisible to every other machine and every cloud agent — so state it here, and do not cite that path.

⚠️ **`templates_render_preview` renders the PUBLISHED version, not your draft.** `POST /templates/render` accepts `uid_version`; the MCP tool does not pass it (**api-cloudrun#526**). Until that lands, `deno task preview` against the git working tree is the only way to see a draft edit rendered — which is itself an argument for keeping the working tree and the draft identical.

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

**A fixture write no longer desyncs the draft** (api-cloudrun#524, fixed). The fixture verbs commit `templates/<gp>.meta.json` straight to the branch; until the fix they did not touch the draft's Firestore `content`, so the next `commit_draft` — **or `release_draft`, which also commits** — wrote the pre-capture sidecar back over the branch, deleting every captured entry while the `fixtures/*.json` files survived. The verbs now mirror the sidecar into the draft, so the old workaround (a hand-written `propose_edit` carrying the branch's sidecar byte-for-byte) is obsolete; **if you find it in an older plan doc, do not re-apply it.** The last uncovered path is now covered too (api-cloudrun#553, fixed): `PATCH /templates/{uid}/metadata` still writes the same sidecar on its own `meta/*` branch, but `rebaseDraftVersion` adopts the merged head wholesale when the draft is **clean**, so a metadata edit reaches an open draft through a rebase. ⚠️ **The condition is load-bearing — a DIRTY draft does not pick it up.** Rebasing one reports `content_refreshed: false` and leaves the content map alone, because adopting the head would discard the uncommitted work. So if a metadata edit seems not to have landed in your draft: commit first, then rebase.

The sidecar's `render` block (`margin_*`, `base_font_size`, `filename` as an Eta string, `footer`/`header` partial paths) drives Gotenberg PDF generation — full field semantics in the `cfs-template-authoring` skill.

## Template context (summary)

**Always on:** `it.doc` (the **source** document — a template never reads its target, it produces it), `it.version`, `it.params` (the sidecar's declared `params[]`, resolved through core's `resolveRenderParams`; preview a non-default state with `deno task preview <name> <fixture> --param <key>=true`), `it.now` (frozen render timestamp — never `new Date()`), `it.holidays` (CFS holiday ISO dates `YYYY-MM-DD[]`, live snapshot — feeds the `it.dates.*` holiday helpers, which throw if omitted; absent in layouts), `it.logo`, `it.dateFns` (date-fns v4), `it.tz` (`@date-fns/tz`), `it.money` (`@cfs/core/utils/money`), `it.dates` (`@cfs/core/utils/dates`), `it.icons` (`@cfs/core/utils/icons`).

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

## Goldens are LIVE on `main` (blessed 2026-08-17) — and absent on `sandbox`

`goldens/main/quote/` holds **all 11 PNGs**, one per fixture (blessed `acaafcd`,
extended to 10 by `ebbe2f2` / #104, 6 of them re-blessed by #108 for the
non-zero replacement filter, and an 11th added by #108 for the flat-tax
component), so the
`visual-diff` gate on a `main` PR now genuinely compares and **can fail**. That
is a change of state, not of policy: `quote` graduated. A golden is a *freeze*,
and you freeze a thing once it has stopped moving.

⚠️ **`goldens/sandbox/` is still empty**, so a dev PR (base `sandbox`) still
yields `no-golden` → PASS on every fixture. **Dev is not gated.** Do not read a
green dev run as evidence a rendering change is safe — only the `main` PR's run
is comparing anything. Re-bless both trees from
`api-cloudrun/scripts/rebless-goldens.ts`.

This supersedes the old "goldens are DEFERRED, not missing" note, which said
`goldens/` held zero PNGs and that `visual-diff` *cannot* fail. That was true
until 2026-08-17 and is now the opposite of the truth — a meaningful visual
change is expected to fail the check, and the fix is to review the diff in the
manager and approve, or re-bless, **not** to assume CI is green because it
always was.

The blessing convention is the one `manager` documents for its Playwright
screenshots (*"convergence, not freeze… a surface gets a `toHaveScreenshot`
pixel lock only once it reaches the design-system standard"*, via its
`GRADUATED` list).

⚠️ **What a golden does NOT catch, so do not reach for one as the answer.** A
golden compares what was rendered; it is silent about a branch that never ran.
Fixture *coverage* and golden *stability* are different problems, and blessing
the baseline closed only the second one.

The set was widened for exactly that reason — 3 fixtures to 9 on 2026-08-14, to
**10** on 2026-08-21 (`replacement-only`) and to **11** the same day
(`taxed-zero-priced-component`, the family's only SYNTHETIC fixture and its only
`flat` tax), eight of them captured from real prod orders — and the argument
still holds at the new size. Measured against the current set: 124 line items,
10 of them discounted across 5 fixtures, and 1 transaction fee in 1 fixture.
The items grid is now covered at **every column count it can produce, 6 through
9**, including both 8-column shapes (Duration+Discount and Duration+Tax), which
is what the banner-`colspan` bug needed and did not have.

What still renders in **no** fixture, and would therefore survive a green
golden run untouched:

| branch | why nothing covers it |
|---|---|
| the foreign-country line in `#bill-to` | all 10 `billing_address.country_name` are `United States` |
| an absent `billing_address` | the field is `.optional()` and `Address` is `.nullable()`, but no fixture omits it |
| a destination with no delivery/collection window | every boundary is nullable; all 10 fixtures set them |
| a `flat` (per-unit) **FEE** | `transaction_fee` is legitimate at a flat amount (`calculateTransactionFeeAmount` prices one) but the only fee in the set is `discounts-and-fee`'s 2.9% card fee, so the fee row's non-percent arm is still unrendered. Its colon was fixed blind, alongside the tax row's |

Those are guards, not layout, so a golden was never going to speak to them —
which is the point of keeping this note rather than replacing it with a
screenshot. The `flat` TAX row that used to head this table is **gone from it**:
`taxed-zero-priced-component` renders that arm now, and finding it immediately
put a bare "Water Bottle Tax" beside "Subtotal:" and "Total:" because the row's
colon had been living inside the `percent` branch. An uncovered branch is not
dormant — it is wrong in a way nobody has looked at yet.

## Dependencies

`@cfs/core` is **exact-pinned** (`jsr:@cfs/core@10.0.0-beta.N/...`, one entry per subpath), and moves in lockstep with `api-cloudrun/deno.json` + `manager/package.json` on every publish — same day, same version, per `feedback_bump_all_core_consumers_lockstep`.

⚠️ **SEVEN entries, and they are named here rather than counted**: `schemas`, plus `utils/` × `orders`, `invoices`, `dates`, `icons`, `money`, `templates`. It was six until `templates` joined it (the harness resolves render params through core's own `resolveRenderParams` rather than reimplementing them). A bump PR that moves six of seven leaves one subpath stranded on the old version and still looks complete, which is why the list is written out — check the names, not the number.

**It used to be a floating caret range, and the range is exactly what let this repo drift.** The point of floating was that preview would track whatever the API renders with; what it actually did was let `main` sit on `^beta.62` while api-cloudrun was 50+ betas ahead, because nothing re-resolved the lock and nothing failed when it didn't. A pin cannot drift silently — it either matches the other two repos or it is visibly wrong. Bump it by editing the specifiers and running `deno install`.

The `minimumDependencyAge` exclusion for `jsr:@cfs/core` at the top of `deno.json` is load-bearing, not a convenience: Deno 2.9 refuses any package version younger than 24h, so without it `deno install` here fails outright for a full day after every core publish. The exclusion names that one first-party package and leaves the 24h supply-chain delay in force for everything else.

**If a freshly published beta looks missing, suspect the JSR CDN before the publish** — `meta.json` has served stale for 6+ hours (workspace CLAUDE.md §2a).

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.
