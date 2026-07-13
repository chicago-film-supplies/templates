# CFS Document Templates

Git-canonical source for CFS's rendered documents (quotes, packing lists,
invoices). **Git is the source of truth for template _content_;** Firestore is a
rebuildable projection the API renders from. You almost never edit this repo by
hand — the **manager** app drives the whole lifecycle through the API.

> Agent/automation notes live in `CLAUDE.md`. This file is for humans.

## The model

A template is split across three Firestore collections (all projected from this
repo on publish):

| Collection | What it is |
|---|---|
| `templates` | A thin **family** record — identity + rollups (`uid_active`, `active_semver`, `draft_uids`, `version_count`), no content. |
| `templates-versions` | **Status-discriminated** content projections — `draft` \| `published` \| `archived`. The editable content lives here. |
| `template-components` | Shared **component** families (e.g. the `base` layout + stylesheet) that templates overlay via `depends_on.components`. |

A render is `overlay(template content ∪ each depends_on component's active
version)`. The renderer branches on file extension — `.eta` is the body/layout,
`.css` is style — and injects the body into `layouts/base.eta`.

### Repo layout

```
templates/<name>.eta                    template body (Eta)
templates/<name>.meta.json              sidecar: display_name, collection_source/target,
                                        surfaces[], depends_on.components[], params[],
                                        fixtures[{slug, label, description?}], render{}
styles/<name>.css                       per-template stylesheet
partials/<name>/*                       per-template partials
template-components/<name>.meta.json    component sidecar: { display_name, files[] }
layouts/base.eta, styles/base.css       shared component content
fixtures/<name>/<slug>.json             deterministic render fixtures (one per slug;
                                        operator-managed via the manager; PII sanitized on capture)
goldens/<branch>/<name>/<slug>.png      committed golden screenshot, one per fixture per base branch
```

## Authoring (in the manager)

Open a template family → **New branch**. Edit two tabs: the **`.eta`** body and
the **`.css`** styles. The body renders through the API's Eta context:

- `it.doc` — the source document (an Order or Invoice; field paths are in the
  editor's Schema Reference panel).
- `it.params` — strict-validated render params (booleans in v1).
- `it.now` — a frozen Chicago-offset render instant (use instead of `new Date()`).
- `it.holidays` — CFS holiday ISO dates (`YYYY-MM-DD[]`, live snapshot); pass to
  the holiday-aware `it.dates.*` helpers (they throw if omitted). Not available in
  the layout.
- `it.currency`, `it.dateFns`, `it.tz`, `it.logo`, `it.dates.*` — always available.
- `it.orders.*` / `it.invoices.*` — **collection-dependent**, NOT guaranteed. The
  `@cfs/core/utils` namespaces a template gets are the union of its
  `collection_source` + `collection_target` namespaces (`orders` → `it.orders`,
  `invoices` → `it.invoices`; `quotes`/`packing_lists` contribute none), plus the
  always-on set above. So the quote template (orders → quotes) has `it.orders` and
  NOT `it.invoices`; an invoices-source template is the reverse. Resolved by
  `availableUtilNamespaces` in `@cfs/core/schemas` — the editor's Template Helpers
  panel lists exactly the namespaces your template actually gets, with each
  helper's return type.

**Preview** renders the *draft* against a real source document. Save first; the
preview reflects your saved draft (not the published version).

## Lifecycle

```
New branch ──▶ a draft PR opens automatically (golden check runs continuously)
   │  edit ──▶ Save (Firestore) ──▶ Commit (push to the branch)
   ▼
Release ──▶ marks the PR ready + enables auto-merge-when-green
   │
   ├─ golden "match"  ──▶ auto-merges ──▶ publishes (no human step)
   └─ golden "diff"   ──▶ blocked ──▶ in-app review: baseline vs candidate vs
                                      diff ──▶ Approve & merge ──▶ publishes
```

- **Merge is the publish authority.** Squash-merging the PR fires the GitHub
  webhook → the API publishes the new version and advances `uid_active`.
- A **meaningful visual change fails the golden check by design** — review the
  diff in the manager and approve, or re-bless goldens, to merge.
- **Abandon** archives a draft (recoverable) and closes its PR.

## Start from an existing template (fork)

On the create screen, pick **Start from existing**. It copies the source
template's markup into a new family. If you switch the source collection (e.g.
order → invoice), the manager shows a **field map**: fields that exist on both
auto-map; the rest are **conflicts** you remap (with suggestions) or leave to fix
in the editor. The field-map is a best-effort head-start — loop-aliased refs
(`it.doc.items.forEach(i => i.x)`) aren't detected, so review the seeded draft.

## Operations

- **Permissions:** routes require `templates.{read,search,create,propose,release,merge,archive}`. After adding a permission to the catalog, **re-run `seed-rbac.ts --write` on each env** — the route/catalog can pass tests while the Firestore `roles/*` docs are stale (this caused a `templates.propose` 403 in QA).
- **Golden gate:** `visual-diff` is a **required** status check on `main` (prod) and `sandbox` (dev). `enforce_admins=false` lets the App squash past a failing golden after a human approves the diff.
- **Branches per env:** the API publishes from `main` (prod) and `sandbox` (dev) — the in-app base-ref gate decides which env a merge publishes to.
- **Cross-repo bumps:** changing `@cfs/core` → publish its `beta` (semantic-release), then bump the pins in `api-cloudrun` + `manager` (+ this preview harness's caret range) in lockstep.

See `api-cloudrun/.claude/skills/templates/SKILL.md` for the deep data-model /
publish-invariant reference.
