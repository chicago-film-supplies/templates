# CLAUDE.md

## Overview

HTML/Eta templates rendered server-side (via `api-cloudrun`) into PDFs using Gotenberg.

**Git-canonical — for PUBLISHED content.** Git is the source of truth for published template *content*; the Firestore family doc + `published` versions are a rebuildable projection of it. This repo is the canonical content store and an ad-hoc local-dev/preview harness; the production editing surface lives in `manager/`.

⚠️ **A `draft` version is NOT a projection, and reading "Firestore is a rebuildable projection" as one rule is what makes the failures below invisible.** A draft's Firestore `content` map is **primary storage for work that exists nowhere else**, and the branch is cut at create and then shadows it. For the lifetime of an uncommitted draft the invariant is inverted: the projection is the only copy. Published content is rebuildable; a draft is not.

⚠️ **"`save` writes Firestore only" — which this paragraph used to say — predates staging and is no longer true.** Every save also commits to a `staging/<uid>` branch first, and a staging failure fails the save. Two consequences worth having: saved work is not actually unbacked (it is on a branch, just not the DRAFT branch), and the draft branch stays free of per-save commit noise.

**That last part is the design intent, not a side effect** (Alex, 2026-08-23): staging is what keeps *involuntary* saves off the draft branch during rapid CSS iteration, so the draft branch's history is the operator's *deliberate* Commit presses. It is also why collapsing save into commit — which looks like a simplification, and would delete `staging/<uid>`, `committed_content_hash`, two dirty predicates and the Commit button — is the wrong trade. **The save/commit split is load-bearing. Do not "simplify" it away.**

**Editing an open draft: MCP tools, not raw git.** The two stores do not sync in *either* direction, so whichever one you write is the only one that moves.

- `templates_propose_edit` writes the Firestore draft, which **never reaches the DRAFT branch** — `commit_draft` / `release_draft` are what do. (It does reach `staging/<uid>`, per the note above; that branch is durability, not publication, and nothing reads it as content.) A draft can accumulate arbitrary work invisible to `git log`. This is not hypothetical: 18 edits (v41 → v66, 2026-08-11/12) were lost that way and had to be reconstructed from a session transcript. **templates#79.**
  - **The system now says so, so believe it rather than tracking it yourself.** `propose_edit` warns on every save that leaves the draft ahead of its branch; `templates_abandon_draft` refuses **422 `DRAFT_HAS_UNCOMMITTED_WORK`** (pass `force` to discard on purpose); and the manager badges the branch row and the editor **"not in git"**. All three read `committed_content_hash`, which is stamped at create as well as commit/release. **A silent abandon is now a bug, not the expected behaviour.**
- A `git commit` on a `draft/*` branch **never reaches Firestore.** The manager preview and `templates_render_preview` go on serving the pre-edit content. Measured 2026-08-14 on `draft/quote/32918fe7`: the Firestore family was last written at 14:38:45 CDT (draft creation) and the git commit landed at 15:06:45 — the draft never moved, and the edit was invisible to every surface except the git working tree and the PR diff.

So while a draft is open, author through `templates_create_draft` → `templates_propose_edit` → `templates_commit_draft` → `templates_release_draft` (which opens the PR — **agents open, humans merge**). That is the one path that leaves both stores in step, and it is what the manager and the golden gate read.

**On a `draft/*` branch, raw git can no longer reach template content at all.** `.claude/hooks/draft-content-guard.sh` is a committed `PreToolUse` hook that denies `Edit`/`Write`/`MultiEdit` on `templates/*.eta`, `templates/*.meta.json`, `styles/*.css`, `partials/**` and `layouts/*.eta` whenever the file's checkout is on a `draft/*` branch, and its refusal carries the MCP call to make instead. It keys off the **branch**, not the repo, so a worktree on `main`, `sandbox` or a `chore/…` branch is untouched; and it is committed, so it reaches every machine and every cloud agent — unlike the workspace `CLAUDE.md`.

⚠️ **The old advice here — *"if you have already edited via git, re-apply the same content through `templates_propose_edit` to resync"* — is now mostly unreachable, and following it for the sidecar is actively wrong.** The hook blocks the edit at source, so the divergence it repaired can now only arise from a checkout that predates the hook, an edit made on a non-draft branch that later became one, or a `git apply`/`sed` that never went through a tool the hook matches. When you do find such a divergence: re-apply through `propose_edit` for `.eta` / `.css` / `partials/**`; for `templates/<gp>.meta.json` do **not** — `propose_edit` refuses it, and the fix is `PATCH /templates/{uid}/metadata` or the fixture verbs (see § The sidecar).

Raw git stays correct for everything that is *not* owned template content: `fixtures/`, `goldens/`, `scripts/`, `.github/`, `*.md`, `deno.json`, `.claude/` — and for **everything** on `main` or `sandbox`.

### Patch mode — why the MCP path stopped being the expensive one

`templates_propose_edit` takes **`edits`** as well as `content`: an array of `{path, old_string, new_string, replace_all?}` with the Edit tool's exact contract — `old_string` matches once unless `replace_all`, ambiguity and misses are 422s naming the count rather than a guessed replacement. `content` merges first, then `edits` apply to that result in array order, so one call can create a file and immediately patch it. The result still goes through `gateDraftContent`, which Eta-compiles every `.eta` value before the save is stored — so a patch that breaks the template is refused at the save, not discovered at render.

**This is the whole reason the deny above is affordable.** `templates/quote.eta` is ~950 lines / 48 KB; a whole-body `content` save re-emitted ~13k tokens for a one-line change and gave the model 949 lines it wasn't trying to touch a chance to drift. That asymmetry is why prose kept losing to `Edit`. Prefer `edits` for an existing file and keep `content` for creating or genuinely rewriting one.

### The sidecar: one writer per section, and none of them is a draft

`templates/<git_path>.meta.json` is the one owned path with **no** authoring surface in a draft:

| section | its one writer |
|---|---|
| `display_name`, `surfaces`, `depends_on` | `PATCH /templates/{uid}/metadata` (manager: the Details form) — commits on its own `meta/*` branch |
| `render` (margins, `base_font_size`, `filename`, `footer`, `header`) | the same route — **new**; the manager's Details form is that block's first editing surface anywhere |
| `fixtures[]` | the fixture verbs (`templates_capture_fixture` / `set` / `describe` / `remove_fixture`) — commit to the draft branch directly |
| `params[]` | the draft's typed `params` (the `params` argument, or the manager's Params tab) — the sidecar copy is **derived from it at commit** |

`templates_propose_edit` **422s on the sidecar** in both `content` and `edits`, and the guard hook denies a file edit of it. What a draft's content map holds is a **render input** — `extractRenderConfig` reads the `render` block out of it at render time, which is the whole reason `ownedContent.ts` keeps it in the map — and a render input is not an authoring surface.

⚠️ **This closed a silent revert, and the revert is the reason the rule is this strict.** `commit_draft` / `release_draft` pushed the draft's whole content map, sidecar included. A dirty draft does not adopt a merged `meta/*` change on rebase (`content_refreshed: false`, § below), so the branch carried an operator's rename while the draft's map did not — and the next commit wrote the old name back over it. Nothing reported it; it appeared only as a line in the release PR's diff, in a file nobody opens that PR to read. Both verbs now resolve the sidecar **off the branch** and overlay the draft's `params`, then refresh the draft's own copy from what they pushed. A stale sidecar in a draft cannot revert anything, because it is never what gets committed.

⚠️ **`serializeSidecarCanonical` used to DELETE every key it did not name, and `render` was not on its list.** Renaming `quote` through `PATCH /metadata` would have dropped its four margins, its base font size, its filename expression and `partials/quote/footer.eta` in the same commit. It is lossless now (`api-cloudrun/src/services/templates/sidecarFormat.ts`), and a `render` change is treated as **visual**: the PR is left open for a human, and the publish cuts a real version rather than a metadata-only projection — because the document renders differently.

### Operator vocabulary — git is the engine, not the interface

⚠️ **Manager users will not all have access to this GitHub org** (stated
2026-08-23). So no repair path in the manager may route through github.com, and
no operator-facing string may assume a reader can open a PR. A PR link may
appear as an *extra*; it is never the repair.

That constrains the words too. Operators see **Draft → Review → Publish**; PR
numbers, branch names, `mergeable_state` and check names stay in the API, the
logs and this repo. Two renames followed from saying what the code actually
does, and they are the vocabulary to use here as well:

| was | is | why |
|---|---|---|
| "Rebase" | **Update from main** | `rebaseDraftVersion` calls `repos.merge` (base → branch). A true rebase would force-push rewritten history, which we deliberately do not do — the old name promised exactly that. |
| "Diff" (two different controls) | **Source diff** / **Visual diff** | one was a git diff of the source against the published version, the other a pixel overlay against the golden, and both could be active at once. |
| "Approve & merge" | **Approve the renders** | merging was never the approval; blessing is. |

### Who merges: it depends on what the PR CHANGES, not on who opened it

⚠️ **"Agents open, humans merge" is about template CONTENT, and reading it as a blanket rule is what left pin bumps sitting open.** The two kinds of PR that reach this repo are not the same risk:

| PR | merged by | why |
|---|---|---|
| **template content** (anything a `templates_release_draft` opens) | **a human authorizes; GitHub lands it** | it changes what a customer receives, and `visual-diff` green means "rendered without erroring", not "renders correctly" |
| **`@cfs/core` pin bump** — only `deno.json` + `deno.lock`, **every** exactly-pinned entry (bump by pattern, never by a remembered count — see § Dependencies) | **agents merge automatically** | mechanical and verifiable: nothing here imports the propagation catalog, `deno check` over the tracked TypeScript either passes or does not, and the alternative is a PR per publish accumulating unmerged while the other three repos have already moved |

⚠️ **"Humans merge" has not described the mechanism since auto-merge was enabled, and the intent it protects is intact — state the intent, not the button.** `releaseDraftVersion` arms auto-merge, so GitHub performs the landing; `README.md`'s lifecycle diagram has documented merge-when-green for as long. What a human actually does is **authorize twice**: at `release`, and again at **approving the renders** when there is a visual change. That bless press *is* the "renders correctly" judgment this rule exists to protect — the human judgment is real, the merge keystroke was never the thing carrying it. Nobody presses "Approve & merge"; no such button exists any more.

**Alex, 2026-08-18: "merge automatically"** — standing, for the pin-bump row only. It does not extend to a PR that touches template content, a fixture, a golden or a workflow, even when an agent opened it and even when CI is green. If a bump PR touches anything beyond `deno.json`/`deno.lock`, it is not this row.

⚠️ **This repo is the durable home for that rule.** It also lives in the workspace `~/cfs/CLAUDE.md`, which is **untracked and machine-local** (api-cloudrun#530) and therefore invisible to every other machine and every cloud agent — so state it here, and do not cite that path.

⚠️ **`templates_render_preview` DEFAULTS to the published version — pass `uid_version` to see your own edit.** This used to say the tool could not render a draft at all (api-cloudrun#526); that was true until `4c866579` (2026-08-19) and is now wrong in the direction that matters, because it pushed agents to `deno task preview` on the working tree and from there to editing the working tree. The tool declares `uid_version`, forwards it, and the route threads it: hand it the draft uid you just `propose_edit`ed and you get that draft rendered. `deno task preview` is still the right tool for iterating against the files on disk on `main` — it is not the way to see a draft.

**Environments.** Prod publishes from `main`; dev/staging publishes from `sandbox`. **`sandbox` exists to exercise the tooling & publish *workflow*, not to stage content** — it's a *disposable mirror* of `main`, force-resynced to fresh `main` as routine practice. Stage content the same way for both envs: **branch `main`** → draft → PR → merge. **Never author canonical content directly on `sandbox`** — a commit made only there never reaches prod and forks the branches (this caused templates#22).

### The owned-path surface — who may write what, and where you see it

Source of truth for the set: `ownsTemplatePath` (`api-cloudrun/src/services/templates/ownedContent.ts`).

| path | in the draft map | MCP writable | raw git on `draft/*` | manager |
|---|---|---|---|---|
| `templates/<gp>.eta` | yes | yes — `content` + `edits` | **denied** | tab |
| `styles/<gp>.css` | yes | yes — `content` + `edits` | **denied** | tab |
| `partials/<gp>/**` | yes | yes — `content` + `edits` | **denied** | tab |
| `templates/<gp>.meta.json` | yes (render input) | **no — 422** | **denied** | Details form (identity + `render`), Params tab, Fixtures tab |
| `layouts/base.eta`, `styles/base.css`, `partials/shared/**` | yes (frozen copy) | yes, but don't | **denied** | via the **base component** editor |
| `fixtures/<gp>/*.json` | no (branch only) | the fixture verbs | allowed | Fixtures tab |
| `goldens/**` | no | no | allowed | visual diff + approve the renders |

The shared overlay is excluded from the template editor on purpose: those files belong to the `base` COMPONENT family, and editing a draft's frozen copy forks it — `rebaseDraftVersion` reconciles that divergence only while the draft is clean, so a dirty draft keeps the fork and its commit writes it onto the branch. Change them in a draft of the component family instead; consuming templates pick them up on their next publish.

⚠️ **`partials/<gp>/**` was INVISIBLE in the manager until now, and had been all along.** It has been owned, MCP-writable and pushed by every draft commit since the pipeline existed, with no tab — so `partials/quote/footer.eta` could only be seen by its effect in the PDF preview. The editor now lists any `partials/<gp>/*` key present in the content map (never a bare `Object.keys(content)`, which would expose the shared overlay).

**What templates#126 actually showed.** 187 lines of quote work were authored with raw `Edit`/`Write` on `draft/quote/bd7dfc09`, committed with raw git, released and merged. The **publish was correct** — `publishFromMerge` resolves content from the merged SHA, so git-canonical published the newer content and not the stale Firestore copy. The gap was never publishing: for the whole life of that draft the manager showed pre-edit content, the draft preview could not show the work, and `git log` was the only witness. Patch mode plus the guard hook is the fix for *that*, not for publishing.

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

⚠️ **The draft's stale sidecar can no longer REVERT that metadata edit, which is the half that used to hurt.** Not picking a change up is a display problem you notice; writing the old value back over it is a data problem you do not. `commit_draft` / `release_draft` resolve the sidecar off the branch now (§ The sidecar), so committing a dirty draft brings its copy forward instead of pushing it back — and the "commit first, then rebase" advice above now works in one step rather than needing the rebase to un-do a revert.

The sidecar's `render` block (`margin_*`, `base_font_size`, `filename` as an Eta string, `footer`/`header` partial paths) drives Gotenberg PDF generation — full field semantics in the `cfs-template-authoring` skill.

## Template context (summary)

**Always on:** `it.doc` (the **source** document — a template never reads its target, it produces it), `it.version`, `it.params` (the sidecar's declared `params[]`, resolved through core's `resolveRenderParams`; preview a non-default state with `deno task preview <name> <fixture> --param <key>=true`), `it.now` (frozen render timestamp — never `new Date()`), `it.holidays` (CFS holiday ISO dates `YYYY-MM-DD[]`, live snapshot — feeds the `it.dates.*` holiday helpers, which throw if omitted; absent in layouts), `it.logo`, `it.dateFns` (date-fns v4), `it.tz` (`@date-fns/tz`), `it.money` (`@cfs/core/utils/money`), `it.dates` (`@cfs/core/utils/dates`), `it.icons` (`@cfs/core/utils/icons`).

⚠️ **`it.currency` is gone.** Phase 11 Phase E withdrew currency.js from the render context entirely, `money-lint.yml`'s budget is **zero**, and `quote.eta` has no remaining call sites — so any `it.currency` reference now fails CI *and* would throw at render. Use `it.money.formatCents(doc.total_cents)`.

### Dates: EVERY `format` needs `{ in: … }` — the default is the wrong timezone

⚠️ **`it.dateFns.format(d, pattern)` renders in the LOCAL timezone of whatever machine is rendering, and that machine is UTC.** Nothing sets `TZ` on the render container (see `api-cloudrun`'s Dockerfile, and no `TZ` env in its `infra/cloud-run-api.tf`), while every stored business datetime is a **Chicago-offset instant**. So an unpinned format prints the UTC calendar day, and any boundary at or after 19:00 CDT / 18:00 CST is *the next day*.

```eta
<%# WRONG — prints the UTC day %>
<%= it.dateFns.format(it.dateFns.parseISO(d.delivery_start), 'EEE M/d/yy') %>
<%# RIGHT %>
<% const CHICAGO = it.tz("America/Chicago"); %>
<%= it.dateFns.format(it.dateFns.parseISO(d.delivery_start), 'EEE M/d/yy', { in: CHICAGO }) %>
```

This is not a hypothetical. Measured 2026-08-24 across **all 996 prod orders**: **56** carry a `delivery_start` or `collection_start` that rendered one day late — 58 including the charge window, 121 field renders. `it.now` is `chicagoNowIso()` and sits on the same footing, so unpinned it dated **every** quote rendered after 19:00 Chicago as tomorrow.

**Both of the things that should have caught it are blind to it by construction, which is why the rule is written here rather than left to review.** Local `deno task preview` runs on a laptop in Chicago, where the unpinned form is accidentally correct. And the golden gate is deterministic *by freezing the clock*, not by fixing the zone — `FROZEN_NOW` is midday, and until `evening-boundary` (prod order 872, 19:00 CDT = 00:00 UTC exactly) no fixture crossed the boundary, so all 12 goldens compared the defect to itself and passed. Reproduce either way with `TZ=UTC deno task preview quote evening-boundary`.

### Icons

`it.icons.svg(name, opts)` returns **inline SVG** for any lucide icon; `it.icons.has(name)` gates a data-driven name. Emit raw — `<%~ it.icons.svg("truck") %>`, not `<%= %>`.

Inline is the only shape available, not a preference: both render paths set Gotenberg's `failOnResourceLoadingFailed=true`, and header/footer partials render in an isolated Chromium frame that loads **no** external resources at all. An icon font, a CDN sprite and an `<img src>` each fail the whole document. Never paste raw `<svg>` into an `.eta` instead — besides the duplication, a self-closing `/>` next to a money-named identifier is a plausible false positive for `money-lint.yml`'s Rule 3.

An unknown name **throws** (listing near matches) rather than rendering nothing — a blank icon is invisible in a PDF and would ship.

### Money (`money-lint` enforces this)

**A template must not compute money.** Values arrive already computed by `@cfs/core/utils/*`, which are verified against exact BigInt rational references over 200k–500k inputs. `.github/workflows/money-lint.yml` fails CI on `.divide(` / `.multiply(` / `.distribute(` in any `.eta` — zero sites, permanently, no allowlist. currency.js quantizes every intermediate at its `precision`, so those operations make a rounding decision nothing states: measured, the precomputed-factor form was wrong 199,998 of 200,000 times, worst error $32,031.20.

**`it.currency` is now banned outright, and the budget is ZERO** (verified 2026-08-13: `money-lint.yml`'s budget map is empty and `quote.eta` has 0 call sites). It was a per-file budget of 19 grandfathered sites while `it.money.formatCents` took **cents** and template documents held **dollars** — every replacement would have read `it.money.formatCents(it.money.toCents(x))`, worse than what it replaced. Documents are cents-denominated now, so `it.money.formatCents(doc.total_cents)` is the natural form and the trade flipped exactly as predicted. The injection is gone from the render context too, so a stray reference throws as well as failing CI.

Deep reference: the `cfs-money` skill → *"The ratchets"*.

**Collection-dependent — `it.orders` is NOT guaranteed:** the `@cfs/core/utils` namespaces a template gets are the union of its `collection_source` + `collection_target` namespaces (`orders` → `it.orders`, `invoices` → `it.invoices`; `quotes`/`packing_lists` contribute none). The quote template (orders → quotes) gets `it.orders` and NOT `it.invoices`; an invoices-source template gets the reverse. Resolved by `availableUtilNamespaces` (`@cfs/core/schemas`), which `api-cloudrun/src/lib/templates/eta.ts` (render), `api-cloudrun/src/services/templates/goldenDiff.ts` (golden gate) and `scripts/preview.ts` (this harness) all funnel through, so preview, gate and prod cannot diverge. Calling a namespace your collections don't resolve to throws at render — and fails the golden gate. Full semantics, data shapes, and authoring patterns: `cfs-template-authoring` skill.

## Local preview

`deno task preview [name] [fixture-slug]` renders a template + fixture to `preview.html` with the same overlay the API performs (component styles → template styles → layout), prints the rendered `filename`, and inlines the footer partial below the body to confirm it parses. `deno task preview:watch` re-renders on change.

**A util namespace this harness cannot provide is a hard error, deliberately.** `UTIL_MODULES` in `scripts/preview.ts` must mirror the server's (`api-cloudrun/src/lib/templates/eta.ts`); if it doesn't, the resolver throws and names the fix. It used to skip silently, and that is how `money` came to be missing here while the server injected it — and `money` is in core's `ALWAYS_ON_UTIL_NAMESPACES`, so *every* template requests it. The result was that the first `it.money.*` call rendered correctly in production and died here with `Cannot read properties of undefined`, which reads as a template bug rather than a harness one. This repo has no test suite, so the throw is the guarantee (the server side is covered by `renderUtilNamespaces.test.ts`). **Do not re-add a silent skip.**

## Goldens are LIVE on `main` (first blessed 2026-08-16) — and absent on `sandbox`

`goldens/main/quote/` holds **14 PNGs against 14 fixtures** — full parity,
reached in five blessings: nine by `acaafcd` / #83, `replacement-only` by
`ebbe2f2` / #104 (2026-08-21), `taxed-zero-priced-component` by `6c37131` / #108
(2026-08-22, which also re-blessed six of the nine for the non-zero replacement
filter), `fee-flat-card` by `aa495eb` / #113 (2026-08-23), and
`billing-foreign-country` + `evening-boundary` by `ef883c3` / #126 (2026-08-25).
So the `visual-diff` gate on a `main` PR genuinely compares — PR #129's run reads
`✓ quote: match across 14 fixture(s)`, which is the aggregate that would read
`no-golden` if even one fixture lacked a baseline — and it **can fail**. That is a
change of state, not of policy: `quote` graduated. A golden is a *freeze*, and
you freeze a thing once it has stopped moving.

⚠️ **Parity is LINT-ENFORCED now, so stop counting PNGs by hand — but know what
the check does and does not claim.** `scripts/lint-fixtures.ts` check 4 fails when
a family that has GRADUATED on a branch (≥ 1 PNG in `goldens/<branch>/<git_path>/`)
has a fixture with no baseline, or a baseline with no fixture. It exists because
the paragraph that stood here — *"`billing-foreign-country` and `evening-boundary`
have no PNG"* — was true of two fixtures at once: a fixture with no golden yields
`no-golden`, an informational **PASS**, so the gate renders it and then says
nothing about the one branch it was added to cover. `billing-foreign-country`
landed on `main` in #113 in that state and stayed ungated for two days; nothing
in a green CI run mentioned it. `evening-boundary` was in the same state inside
the draft that became #126 and was blessed in the same commit only because
someone counted. **templates#125.**

**A capture now turns `templates-lint` red until its golden is blessed, and that
sequence is intended rather than a deadlock.** `visual-diff` is a separate job:
it still runs, still renders the new fixture, still uploads the candidate. So the
bless that clears the red is available immediately, and it is the same press that
already clears a `no-golden` verdict.

⚠️ **`goldens/sandbox/` is still empty**, so a dev PR (base `sandbox`) still
yields `no-golden` → PASS on every fixture. **Dev is not gated.** Do not read a
green dev run as evidence a rendering change is safe — only the `main` PR's run
is comparing anything. Re-bless both trees from
`api-cloudrun/scripts/rebless-goldens.ts`.

This supersedes the old "goldens are DEFERRED, not missing" note, which said
`goldens/` held zero PNGs and that `visual-diff` *cannot* fail. That was true
until `acaafcd` and is now the opposite of the truth — a meaningful visual
change is **expected** to fail the check.

**The clearing path is one path, not two.** Review the per-fixture diffs in the
manager, then **approve the renders**: that commits the new baseline PNGs onto
the draft branch, `visual-diff` re-runs against them at the PR head, and the
auto-merge release already armed lands it. There is no merge to press, and
"approve the diff **or** re-bless" described two paths where there is one — they
are the same act.

⚠️ **`visual-diff` now runs with `cancel-in-progress`**, so an in-flight run is
superseded by the next push and **the newest run is the only verdict**. That
matters beyond CI minutes: the manager derives the operator's next action from
"the latest golden verdict", and racing runs writing back to the same document
made that phrase ambiguous.

The blessing convention is the one `manager` documents for its Playwright
screenshots (*"convergence, not freeze… a surface gets a `toHaveScreenshot`
pixel lock only once it reaches the design-system standard"*, via its
`GRADUATED` list).

⚠️ **What a golden does NOT catch, so do not reach for one as the answer.** A
golden compares what was rendered; it is silent about a branch that never ran.
Fixture *coverage* and golden *stability* are different problems, and blessing
the baseline closed only the second one.

The set was widened for exactly that reason — 3 fixtures to 9 on 2026-08-14, to
**10** on 2026-08-21 (`replacement-only`, #104), **11** on 2026-08-22
(`taxed-zero-priced-component`, #108), **13** on 2026-08-23
(`billing-foreign-country` and `fee-flat-card`, #113) and **14** on 2026-08-25
(`evening-boundary`, #126) — and the argument still holds at the new size.
**12 of the 14 are captured from real prod orders.** The two hand-built ones are
`multi-dest` and `discounts-and-fee`, and each says in its sidecar why its shape
cannot be captured at all rather than merely has not been.
`taxed-zero-priced-component` used to be named here as the family's only
SYNTHETIC fixture; #113 replaced it with a capture from prod order 1004, so that
is no longer true of it or of anything else in the set.

Measured against the current set on 2026-08-25: **131 priced rows** across 174
item entries — the other 43 are destination and group dividers — **11 discounted
lines across 6 fixtures**, **2 fee-bearing fixtures** covering both arms of the
totals fee row (`discounts-and-fee` at `percent`, `fee-flat-card` at `flat`), and
**15 destinations, every one carrying both a delivery and a collection window**.
The items grid is covered at **every column count it can produce, 6 through 9**,
including both 8-column shapes (Duration+Discount and Duration+Tax), which is
what the banner-`colspan` bug needed and did not have.

What still renders in **no** fixture, and would therefore survive a green
golden run untouched:

| branch | why nothing covers it |
|---|---|
| an absent `billing_address` | the field is `.optional()` and `Address` is `.nullable()`, but all 14 fixtures set one |
| a destination with no delivery/collection window | every boundary is nullable; all 15 destinations set both |

Those are guards, not layout, so a golden was never going to speak to them —
which is the point of keeping this note rather than replacing it with a
screenshot. **Three rows have left this table, and all three left the same way.**
The `flat` TAX row went when `taxed-zero-priced-component` rendered that arm, and
finding it immediately put a bare "Water Bottle Tax" beside "Subtotal:" and
"Total:" because the row's colon had been living inside the `percent` branch. The
foreign-country line in `#bill-to` went when `billing-foreign-country`'s golden
landed in #126. The `flat` (per-unit) **FEE** went when `fee-flat-card` — prod
order 502, carrying a real $1.15 Card Fee — was blessed in #113. An uncovered
branch is not dormant; it is wrong in a way nobody has looked at yet.

⚠️ **Each row left only when a fixture AND its golden had landed, never on one of
the two**, and that is the whole reason parity is a lint rather than a habit. A
fixture without a baseline is rendered and passed informationally, so it buys
nothing: `billing-foreign-country` existed from #113 and its branch stayed
ungated until #126 blessed the PNG two days later, which is why its row stayed in
this table across that gap instead of leaving with the fixture.

⚠️ **`billing-foreign-country`'s blessed golden carries a `Sample t` postcode on
purpose — do not "repair" the baseline.** `applyPii`'s postcode branch is guarded
on US ZIP only, so a Canadian `A1A 1A1` falls through every branch to the generic
filler (api-cloudrun#627, still open). The country line, which is what the fixture
is for, renders correctly. When #627 lands, re-capture the fixture and re-bless
the golden together.

## Dependencies

`@cfs/core` is **exact-pinned** (`jsr:@cfs/core@10.0.0-beta.N/...`, one entry per subpath), and moves in lockstep with `api-cloudrun/deno.json` + `manager/package.json` on every publish — same day, same version, per `feedback_bump_all_core_consumers_lockstep`.

⚠️ **EIGHT entries, and they are named here rather than counted**: `schemas`, plus `utils/` × `orders`, `invoices`, `dates`, `icons`, `money`, `templates`, `citations`. It was six until `templates` joined it, and seven until `citations` did (the harness resolves render params through core's own `resolveRenderParams` rather than reimplementing them). A bump PR that moves six of seven leaves one subpath stranded on the old version and still looks complete, which is why the list is written out — check the names, not the number.

**It used to be a floating caret range, and the range is exactly what let this repo drift.** The point of floating was that preview would track whatever the API renders with; what it actually did was let `main` sit on `^beta.62` while api-cloudrun was 50+ betas ahead, because nothing re-resolved the lock and nothing failed when it didn't. A pin cannot drift silently — it either matches the other two repos or it is visibly wrong. Bump it by editing the specifiers and running `deno install`.

The `minimumDependencyAge` exclusion for `jsr:@cfs/core` at the top of `deno.json` is load-bearing, not a convenience: Deno 2.9 refuses any package version younger than 24h, so without it `deno install` here fails outright for a full day after every core publish. The exclusion names that one first-party package and leaves the 24h supply-chain delay in force for everything else.

**If a freshly published beta looks missing, suspect the JSR CDN before the publish** — the registry's `https://jsr.io/@cfs/core/meta.json` endpoint has served stale for 6+ hours (workspace CLAUDE.md §2a). Compare it against a cache-busted `?cb=1` fetch.

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.
