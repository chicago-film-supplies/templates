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
| `render` (margins, `filename`, `footer`, `header`) | the same route — **new**; the manager's Details form is that block's first editing surface anywhere |
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

⚠️ **"MCP writable: yes, but don't" now reads "yes, in the COMPONENT'S draft" — the component-draft path is the EXPECTED route, not a mistake.** `base` owns seven files rather than three: `layouts/base.eta`, `styles/base.css`, and `partials/shared/{footer, letterhead, destinations, items-grid, totals}.eta`. The shared chrome is where the brand lives, so editing it is ordinary work; what stays wrong is editing a *consuming template's frozen copy* of it, which forks the file. The distinction is which family's draft you are in, not whether the file may be touched.

⚠️ **`partials/<gp>/**` was INVISIBLE in the manager until now, and had been all along.** It has been owned, MCP-writable and pushed by every draft commit since the pipeline existed, with no tab — so the quote footer could only be seen by its effect in the PDF preview. The editor now lists any `partials/<gp>/*` key present in the content map (never a bare `Object.keys(content)`, which would expose the shared overlay).

⚠️ **The quote footer is no longer one of them — it is `partials/shared/footer.eta`, a file of the `base` COMPONENT** (templates#140). It is listed in `template-components/base.meta.json`'s `files[]`, and `templates/quote.meta.json`'s `render.footer` points at it. **Edit it in a draft of the base component, not a quote draft** — editing a consuming template's frozen copy forks it, and `rebaseDraftVersion` reconciles that only while the draft is clean. `partials/<gp>/**` remains owned and writable for genuinely per-template partials; there just are not any right now.

⚠️ **And the footer is no longer the only shared partial, nor the only KIND.** `letterhead`, `destinations`, `items-grid` and `totals` are body fragments a template pulls in with `includeAsync` (§ Includes), where the footer is pulled in by the sidecar's `render.footer`. Same directory, same content map, same component — two different mechanisms reach them, and only the footer's renders in an isolated frame.

### ⚠️ Part partials render where CSS cannot reach, and nothing but production renders them

A `render.footer`/`render.header` partial is its OWN document in an isolated Chromium frame that loads no external resources. It therefore sees no stylesheet of its own accord; `api-cloudrun`'s `injectPartDefaults` injects the document's overlay at the START of that frame's head as a DEFAULT the partial may override. Two consequences worth knowing before editing one:

- **Do not restate the document's font size in a part partial.** It inherits the quote's root through the injected overlay, so `body { font-size: 10px }` is at best redundant and at worst silently wrong the day the document's root moves — which is exactly what happened (templates#114). Geometry that is a fact about the PAGE (`padding-top: 12px`) stays absolute on purpose.
- ⚠️ **Never write the literal opening `head` tag in a part partial, even inside a CSS comment.** `injectPartDefaults` finds its insertion point with a regex over the whole string, so prose mentioning the tag is matched as if it were the document's own and the entire overlay is spliced there. Measured while writing templates#140: ~26 KB of CSS landed inside a comment, closed the `<style>` early, and the shipped footer rendered the stylesheet as body text. Anchored in api-cloudrun since, but the partial-side habit is still the cheaper guard.

**Neither gate covers this frame.** The golden gate screenshots the body only (`renderGoldenHtml` takes `{body, layout, styles}`), and `deno task preview` inlines the footer *below* the body inside the same document, where its `<style>` leaks onto the whole preview. **Render a real PDF and look at it when you touch a part partial.** templates#137 tracks closing the gap.

**What templates#126 actually showed.** 187 lines of quote work were authored with raw `Edit`/`Write` on `draft/quote/bd7dfc09`, committed with raw git, released and merged. The **publish was correct** — `publishFromMerge` resolves content from the merged SHA, so git-canonical published the newer content and not the stale Firestore copy. The gap was never publishing: for the whole life of that draft the manager showed pre-edit content, the draft preview could not show the work, and `git log` was the only witness. Patch mode plus the guard hook is the fix for *that*, not for publishing.

**Authoring reference:** the `cfs-template-authoring` skill (plugin `cfs-skills@cfs`, auto-installed via `.claude/settings.json`) is the canonical deep reference — render context (`it.*`), sidecar schema, overlay semantics, order data shape, price fields, fixtures/goldens. Consult it before writing template content. The pipeline side (lifecycle, publish invariants, golden gate, RBAC) is `api-cloudrun/.claude/skills/templates/SKILL.md`.

## Repo layout (sidecar + convention)

```
templates/<name>.eta                    document body partial (rendered with `it`)
templates/<name>.meta.json              sidecar: display_name, collection_source/target, surfaces[], depends_on.components[], params[], fixtures[], render{}
layouts/<name>.eta                      component layout skeleton (wraps the body via `it.body`, injects `it.styles`)
styles/<name>.css                       per-template OR per-component stylesheet
partials/<template>/<part>.eta          includable partial: a render-config part (footer/header) OR a body fragment
partials/shared/<part>.eta              the same, but owned by the `base` COMPONENT and overlaid onto every family
template-components/<name>.meta.json    component sidecar: display_name + files[] manifest
fixtures/<template>/<slug>.json         deterministic source docs for golden visual-diff (operator-managed; PII sanitized on capture)
goldens/<branch>/<template>/<slug>.png  branch-keyed golden screenshot, one per fixture
```

⚠️ **A partial is no longer only a footer/header slot.** Until 2026-08-26 the
only way a `partials/**` file reached a page was a sidecar `render.footer` /
`render.header` naming it, and each of those renders as its own isolated
document. A body may now `includeAsync` one, which is how the two families
share chrome — see § Includes under *Template context*. Both uses live in the
same directories and the same content map; what differs is who pulls the file in.

Fixtures are **files-authoritative for discovery**: the renderer globs `fixtures/<template>/*.json` and the sidecar's `fixtures[]` supplies each entry's label and reason. An orphaned sidecar entry never breaks a render; zero fixtures yields a `no-fixtures` golden verdict (informational pass).

⚠️ **Every sidecar entry must say WHY its fixture exists** — what it covers that no other fixture in the family does. `description` is required (`@cfs/core`'s `FixtureMeta`), the API refuses a write without one, and `deno task lint:fixtures` fails a missing or placeholder reason (minimum 40 characters). This is not bookkeeping: a fixture set *is* a coverage argument, and the fixture file is a `z.strictObject` source document with nowhere to put a comment, so the sidecar is the only place that argument can be written down. A fixture that is synthetic because no real order exercises its shape must say so, or the next person "cleans it up".

**Never hand-write a fixture from real data.** `PUT /templates/{uid}/fixtures/{slug}` (and the manager's JSON textarea) commit exactly what you give them — dev mirrors prod, so a dev order carries real customer names, contacts and addresses. Capture instead: the manager's capture action / MCP `templates_capture_fixture` runs the document through `applyPii` with a deterministic salt first. The PII pass in `lint:fixtures` is the net for when that is skipped.

**A fixture write no longer desyncs the draft** (api-cloudrun#524, fixed). The fixture verbs commit `templates/<gp>.meta.json` straight to the branch; until the fix they did not touch the draft's Firestore `content`, so the next `commit_draft` — **or `release_draft`, which also commits** — wrote the pre-capture sidecar back over the branch, deleting every captured entry while the `fixtures/*.json` files survived. The verbs now mirror the sidecar into the draft, so the old workaround (a hand-written `propose_edit` carrying the branch's sidecar byte-for-byte) is obsolete; **if you find it in an older plan doc, do not re-apply it.** The last uncovered path is now covered too (api-cloudrun#553, fixed): `PATCH /templates/{uid}/metadata` still writes the same sidecar on its own `meta/*` branch, but `rebaseDraftVersion` adopts the merged head wholesale when the draft is **clean**, so a metadata edit reaches an open draft through a rebase. ⚠️ **The condition is load-bearing — a DIRTY draft does not pick it up.** Rebasing one reports `content_refreshed: false` and leaves the content map alone, because adopting the head would discard the uncommitted work. So if a metadata edit seems not to have landed in your draft: commit first, then rebase.

⚠️ **The draft's stale sidecar can no longer REVERT that metadata edit, which is the half that used to hurt.** Not picking a change up is a display problem you notice; writing the old value back over it is a data problem you do not. `commit_draft` / `release_draft` resolve the sidecar off the branch now (§ The sidecar), so committing a dirty draft brings its copy forward instead of pushing it back — and the "commit first, then rebase" advice above now works in one step rather than needing the rebase to un-do a revert.

The sidecar's `render` block (`margin_*`, `filename` as an Eta string, `footer`/`header` partial paths) drives Gotenberg PDF generation — full field semantics in the `cfs-template-authoring` skill.

⚠️ **`base_font_size` is gone, and the thing that replaced it is a CSS rule, not another knob** (templates#114). It was injected by `api-cloudrun` as `<style>body,table,th,td{font-size:Npx}</style>` at the **END** of `<head>`, so it beat the template's own stylesheet by source order — which is how the shipped PDF came to be a 10px document while `deno task preview` and all 14 goldens were 9px. **The font size is now `styles/base.css`'s `html { font-size: 10px }` — a global DEFAULT at the root — and a template opts out with ONE declaration in its own stylesheet** (`styles/quote.css`'s `html { font-size: 9px }` already was that declaration; it stopped being a workaround and became the mechanism). Everything under it is `em`/`rem`, so the override scales the whole document coherently instead of leaving `html` behind at the old root. An operator still changes the global from the manager's base-component editor, which is what the knob was for.

**The organising rule, for the next injection anyone is tempted to add: inject a global DEFAULT at the START of `<head>`, never an OVERRIDE at the end.** `injectPartHorizontalMargins` is the good shape and says so in its own comment (*"User styles declared later in the document still win"*); `injectBaseFontSize` was the same idea placed at the other end of the same element, and that placement was the whole defect. CSS is the authority everywhere it can reach — which is the main document. The header/footer frames are the one place it cannot reach (isolated Chromium documents that load no external resources), so injection is the only channel there, and it stays a start-of-head default.

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

### Includes — how the two families share chrome

⚠️ **Two, not three** — `quote` and `invoice` are every document family that
exists. This section said *three* when it was written (#142, 2026-08-26),
counting a packing-list family that was designed but never registered; Phase 3
is on hold pending a grain decision (templates#150), and a `git_path` is
permanently reserved at create, so nothing is pre-registered against it.

```eta
<%~ await includeAsync("@partials/shared/bill-to.eta", { title: "Quote #123" }) %>
```

Four rules, each of which is a render failure if broken:

- **`includeAsync`, never `include`.** The sync form resolves against a template
  store the pipeline never writes to.
- **The `@` prefix is mandatory, even when the file plainly exists.** Eta routes
  any un-prefixed name to its filesystem resolver, which opens with
  `if (!views) throw` — and the render pipeline has no `views` and never will,
  because template content is git-canonical and arrives as a content map. `@` is
  the branch that reads the in-memory store instead. "But the file is right
  there" is precisely the case that fails.
- **Emit raw (`<%~`).** `<%=` escapes the partial's own markup into text.
- **The name must be a literal.** A computed one cannot be checked before render,
  so the save gate refuses it rather than trusting it.

**The props burden is much smaller than it looks.** Eta's codegen is
`includeAsync = (t, d) => this.renderAsync(t, {...it, ...(d ?? {})})` — the
parent's whole `it` is spread in **first**, so a partial inherits `it.doc`,
`it.money`, `it.dates`, `it.icons`, `it.now`, `it.params`, `it.logo`,
`it.dateFns`, `it.tz` and the resolved util namespaces for free. Only the
caller's top-of-file **locals** need passing.

⚠️ **A shared partial never NAMES a util namespace.** `it.orders` and
`it.invoices` are resolved per family from its collections, so a partial that
writes `it.orders.orderHasTax(…)` can only ever serve orders-source families and
throws for the rest. Take the namespace object as a prop — conventionally `u` —
and call `u.orderHasTax(…)`. Same rule for anything else family-dependent:
**hand it in, don't reach for it.**

⚠️ **The LAYOUT gets no partials, deliberately.** `layouts/base.eta` renders with
`{doc, body, styles}` only, so an include there would compile, render, and see
none of `it`. It is left unregistered rather than half-working — in production,
in the golden gate and in `deno task preview` alike.

**A bad include is refused at SAVE, not discovered at render.** The compile gate
cannot see this class at all: `eta.compile()` builds the template function
without executing it, so a name that resolves to nothing is well-formed JS. A
separate guard (`validateIncludeTargets`, `api-cloudrun/src/lib/templates/eta.ts`)
scans each `.eta` for include call sites and 400s on a missing key, the sync
form, a missing `@`, or a computed name — naming the near match.

### Icons

`it.icons.svg(name, opts)` returns **inline SVG** for any lucide icon; `it.icons.has(name)` gates a data-driven name. Emit raw — `<%~ it.icons.svg("truck") %>`, not `<%= %>`.

Inline is the only shape available, not a preference: both render paths set Gotenberg's `failOnResourceLoadingFailed=true`, and header/footer partials render in an isolated Chromium frame that loads **no** external resources at all. An icon font, a CDN sprite and an `<img src>` each fail the whole document. Never paste raw `<svg>` into an `.eta` instead — besides the duplication, a self-closing `/>` next to a money-named identifier is a plausible false positive for `money-lint.yml`'s Rule 3.

An unknown name **throws** (listing near matches) rather than rendering nothing — a blank icon is invisible in a PDF and would ship.

### Money (`money-lint` enforces this)

**A template must not compute money.** Values arrive already computed by `@cfs/core/utils/*`, which are verified against exact BigInt rational references over 200k–500k inputs. `.github/workflows/money-lint.yml` fails CI on `.divide(` / `.multiply(` / `.distribute(` in any `.eta` — zero sites, permanently, no allowlist. currency.js quantizes every intermediate at its `precision`, so those operations make a rounding decision nothing states: measured, the precomputed-factor form was wrong 199,998 of 200,000 times, worst error $32,031.20.

**`it.currency` is now banned outright, and the budget is ZERO** (verified 2026-08-13: `money-lint.yml`'s budget map is empty and `quote.eta` has 0 call sites). It was a per-file budget of 19 grandfathered sites while `it.money.formatCents` took **cents** and template documents held **dollars** — every replacement would have read `it.money.formatCents(it.money.toCents(x))`, worse than what it replaced. Documents are cents-denominated now, so `it.money.formatCents(doc.total_cents)` is the natural form and the trade flipped exactly as predicted. The injection is gone from the render context too, so a stray reference throws as well as failing CI.

⚠️ **"The budget is ZERO" is true of Rule 1 and FALSE of Rule 3 — there are two budgets.** Rule 1 counts `it.currency` references and its map is empty, so zero everywhere. Rule 3 counts **raw `*`/`/` beside a money-named identifier**, and `RAW_BUDGET` is `{"templates/quote.eta": 2}` — the per-line replacement subtotal and the percent-tax arm, which have no exposed core helper (`computeItemTaxAmountCents` is denylisted as a building block and there is no stored per-line replacement field). Every other file may hold **0**. It **ratchets both ways**: a third site fails, and so does dropping to one while the budget still says two. Both sites live in `replacementLine` — do not move that function into a shared partial.

⚠️ **Rule 3 keys on a NAME beside a slash, so a path is a plausible false positive — the linter handles it now, do not write around it.** `includeAsync("@partials/shared/totals.eta", …)` reads as `/totals`; without care that would mean no shared partial may ever be named for the thing it renders. `money-lint.yml` strips string literals before applying Rule 3 (a `/` inside a string is never arithmetic) and skips whole `<%/* … */%>` blocks for Rules 2 and 3 (prose about the rule is not a violation of it — a docblock explaining "fails CI on `.divide(`" reported three non-closed operations). Arithmetic on a line that merely *contains* a string is still caught; the comment exemption weakens nothing, because a comment cannot compute.

Deep reference: the `cfs-money` skill → *"The ratchets"*.

**Collection-dependent — `it.orders` is NOT guaranteed:** the `@cfs/core/utils` namespaces a template gets are the union of the always-on set (`it.dates`, `it.money`, `it.icons`) plus each of its `collection_source` + `collection_target` namespaces — `orders` → `it.orders`, `invoices` → `it.invoices`, `fulfillments` → `it.fulfillments`; `quotes` and `packing_lists` contribute none, because a template *produces* those rather than computing over them. The quote template (orders → quotes) gets `it.orders` and NOT `it.invoices`; an invoices-source template gets the reverse. Resolved by `availableUtilNamespaces` (`@cfs/core/schemas`), which `api-cloudrun/src/lib/templates/eta.ts` (render), `api-cloudrun/src/services/templates/goldenDiff.ts` (golden gate) and `scripts/preview.ts` (this harness) all funnel through, so preview, gate and prod cannot diverge. Calling a namespace your collections don't resolve to throws at render — and fails the golden gate. Full semantics, data shapes, and authoring patterns: `cfs-template-authoring` skill.

⚠️ **`it.fulfillments` is REAL, and the sentence above used to deny it.** It shipped in `@cfs/core@10.0.0-beta.272`; this paragraph listed `orders` and `invoices` only, and closed with *"calling a namespace your collections don't resolve to throws at render"* — so it told a future packing-list author that the one namespace their family resolves to would throw. Nothing in the repo would have contradicted it: no `fulfillments`-sourced family is registered, so no render exercises the mapping and no golden covers it. **A stale namespace list is a correctness bug, not a count** — check it against `TEMPLATE_COLLECTION_UTILS` (`core/src/schemas/template-context.ts`), which is the whole map in nine lines.

`it.fulfillments` is a **re-export namespace over `utils/orders`**, not a mapping to the string `"orders"`. A fulfillment's items and destinations are the same structural shapes, so the helpers transfer; the document is not an order, so `it.orders` on one would be a lie. It also renders what was **picked** rather than what was ordered — a fulfillment line carries `quantity` beside `quantity_order`, and `path_substituted_for` when a picker swapped an item.

**Three axes, and they are not the same axis.** `collection_source` is what `it.doc` **is** (`orders`, `invoices`, `fulfillments`); `collection_target` is what the render **produces** (`quotes`, `packing_lists`, `invoices`); `surfaces` is where the family is **offered** in the manager (`order`, `fulfillment`, `invoice`) and resolves no namespace at all. The three enums overlap by name and are not interchangeable: `fulfillments` is a source but never a target, `quotes`/`packing_lists` are targets but never sources — so **no template can read a packing list**, only write one — and `invoices` is the only collection on both lists, which is why the invoice family's source and target coincide.

## Local preview

`deno task preview [name] [fixture-slug]` renders a template + fixture to `preview.html` with the same overlay the API performs (component styles → template styles → layout), registers every `partials/shared/**` and `partials/<name>/**` file as an includable partial, prints the rendered `filename` and the partials it registered, and inlines the footer partial below the body to confirm it parses. `deno task preview:watch` re-renders on change — and **watches `partials/` too**, which it did not until 2026-08-26, so editing the shared footer used to trigger no re-render at all.

⚠️ **The harness runs TWO Eta instances, and that is not an accident.** The document surfaces (body, footer, filename) render on the engine that has partials registered; the LAYOUT renders on a partial-free one, because production registers none there. One shared engine would make an include in `layouts/base.eta` work here and throw in prod — the exact direction this harness exists to prevent.

**A util namespace this harness cannot provide is a hard error, deliberately.** `UTIL_MODULES` in `scripts/preview.ts` must mirror the server's (`api-cloudrun/src/lib/templates/eta.ts`); if it doesn't, the resolver throws and names the fix. It used to skip silently, and that is how `money` came to be missing here while the server injected it — and `money` is in core's `ALWAYS_ON_UTIL_NAMESPACES`, so *every* template requests it. The result was that the first `it.money.*` call rendered correctly in production and died here with `Cannot read properties of undefined`, which reads as a template bug rather than a harness one. This repo has no test suite, so the throw is the guarantee (the server side is covered by `renderUtilNamespaces.test.ts`). **Do not re-add a silent skip.**

## Goldens are LIVE on `main` (first blessed 2026-08-16) — and absent on `sandbox`

**Both live families have graduated on `main`**, each at full parity with its
own fixture set: `goldens/main/quote/` holds 14 PNGs and `goldens/main/invoice/`
holds 7. `quote` got there in five blessings — nine by `acaafcd` / #83,
`replacement-only` by `ebbe2f2` / #104 (2026-08-21),
`taxed-zero-priced-component` by `6c37131` / #108 (2026-08-22, which also
re-blessed six of the nine for the non-zero replacement filter), `fee-flat-card`
by `aa495eb` / #113 (2026-08-23), and `billing-foreign-country` +
`evening-boundary` by `ef883c3` / #126 (2026-08-25) — then all 14 together for
the root-sizing of `base.css` (templates#114, 2026-08-26). `invoice` graduated in
**one**, by `9c6e877` / #148 (2026-08-26): the family, its seven captures and its
seven baselines all landed the same day, which is what a family built after the
parity lint existed looks like.

So the `visual-diff` gate on a `main` PR genuinely compares — PR #129's run reads
`✓ quote: match across 14 fixture(s)`, which is the aggregate that would read
`no-golden` if even one fixture lacked a baseline — and it **can fail**. That is a
change of state, not of policy. A golden is a *freeze*, and you freeze a thing
once it has stopped moving.

⚠️ **Graduation is PER FAMILY, and the counts above are a measurement, not the
rule.** `visual-diff` reports one verdict per family and `lint:fixtures` check 4
scopes itself to families that have graduated on the branch, so `quote`
graduating never gated `invoice`, and blessing one family's baselines says
nothing about the other's. This section used to be written around
`goldens/main/quote/` as though one family's count were the state of golden
coverage; with two families that reading is wrong, and with a third it would be
worse. Read the state from `ls goldens/main/<git_path>/` and from the lint —
never from a number in this file.

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

⚠️ **And it is silent about a change SMALLER THAN 0.1% OF THE PAGE, which on a
mostly-white document is a great deal more than it sounds.** `comparePng`'s
`DEFAULT_THRESHOLD` is `0.001` (`api-cloudrun/src/lib/templates/golden.ts`), so a
verdict of `match` means "fewer than one pixel in a thousand moved", not "nothing
moved". Measured 2026-08-26 against `main` at `19d7887`: **four of the fourteen
goldens were STALE** and every one of them still read `match` —
`sale-taxed` (delta 0.000738) and `service-untaxed` (0.000690) carried a whole
`In Store Return` leg — its heading, its two address lines and the duration cell
— that #126 had deliberately stopped rendering (`hasCollection = hasRentals`, so
a sale-only order has no collection leg); `taxed-zero-priced-component` (0.000191)
the same band; `rental-discount-exempt` (0.000673) a column shift in the
replacement-charges table. #126 re-blessed the two fixtures it added and left the
other four behind, and nothing in a green run said so for a day. They are
corrected in the same re-bless as templates#114.

**The lesson is not "lower the threshold"** — it exists to absorb Chromium's
sub-pixel antialiasing noise, measured at up to 0.00074 across this very set when
re-rendering an UNCHANGED tree, which is the same order of magnitude as the four
stale deltas above. Signal and noise genuinely overlap at this scale, so the
threshold cannot separate them. **What distinguishes them is that a real change
is CONTIGUOUS and antialiasing noise is scattered**, which a delta over the whole
page throws away. templates#137.

⚠️ **Everything from here to the end of this section is about the QUOTE fixture
set specifically** — the counts, the coverage table and the branches named as
uncovered. It predates `invoice` and none of it was ever re-measured across both
families. `invoice`'s own coverage argument lives in
`templates/invoice.meta.json`'s `fixtures[]` descriptions, which is where a
family's argument belongs; there is no equivalent prose for it here, and that is
a gap rather than a claim that its set is smaller.

The quote set was widened for exactly that reason — 3 fixtures to 9 on
2026-08-14, to **10** on 2026-08-21 (`replacement-only`, #104), **11** on 2026-08-22
(`taxed-zero-priced-component`, #108), **13** on 2026-08-23
(`billing-foreign-country` and `fee-flat-card`, #113) and **14** on 2026-08-25
(`evening-boundary`, #126) — and the argument still holds at the new size.
**12 of the 14 are captured from real prod orders.** The two hand-built ones are
`multi-dest` and `discounts-and-fee`, and each says in its sidecar why its shape
cannot be captured at all rather than merely has not been.
`taxed-zero-priced-component` used to be named here as the family's only
SYNTHETIC fixture; #113 replaced it with a capture from prod order 1004, so that
is no longer true of it or of anything else in the set.

Measured against the current quote set on 2026-08-25: **131 priced rows** across 174
item entries — the other 43 are destination and group dividers — **11 discounted
lines across 6 fixtures**, **2 fee-bearing fixtures** covering both arms of the
totals fee row (`discounts-and-fee` at `percent`, `fee-flat-card` at `flat`), and
**15 destinations, every one carrying both a delivery and a collection window**.
The items grid is covered at **every column count it can produce, 6 through 9**,
including both 8-column shapes (Duration+Discount and Duration+Tax), which is
what the banner-`colspan` bug needed and did not have.

What still renders in **no quote fixture**, and would therefore survive a green
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

⚠️ **NINE entries, and they are named here rather than counted**: `schemas`, plus `utils/` × `orders`, `invoices`, `fulfillments`, `dates`, `icons`, `money`, `templates`, `citations`. It was six until `templates` joined it, seven until `citations` did (the harness resolves render params through core's own `resolveRenderParams` rather than reimplementing them), and eight until `fulfillments` did. A bump PR that moves eight of nine leaves one subpath stranded on the old version and still looks complete, which is why the list is written out — check the names, not the number.

⚠️ **This line was itself stale, which is the failure it warns about happening to the warning.** It read *EIGHT* and omitted `fulfillments` while `deno.json` had carried `@cfs/core/utils/fulfillments` since `10.0.0-beta.272` — so anyone bumping by this list rather than by pattern would have stranded exactly the subpath the list forgot. **Bump with a `sed` over `jsr:@cfs/core@<old>/`**, which cannot miss one; then read the names back to check nothing new appeared.

**It used to be a floating caret range, and the range is exactly what let this repo drift.** The point of floating was that preview would track whatever the API renders with; what it actually did was let `main` sit on `^beta.62` while api-cloudrun was 50+ betas ahead, because nothing re-resolved the lock and nothing failed when it didn't. A pin cannot drift silently — it either matches the other two repos or it is visibly wrong. Bump it by editing the specifiers and running `deno install`.

The `minimumDependencyAge` exclusion for `jsr:@cfs/core` at the top of `deno.json` is load-bearing, not a convenience: Deno 2.9 refuses any package version younger than 24h, so without it `deno install` here fails outright for a full day after every core publish. The exclusion names that one first-party package and leaves the 24h supply-chain delay in force for everything else.

**If a freshly published beta looks missing, suspect the JSR CDN before the publish** — the registry's `https://jsr.io/@cfs/core/meta.json` endpoint has served stale for 6+ hours (workspace CLAUDE.md §2a). Compare it against a cache-busted `?cb=1` fetch.

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.
