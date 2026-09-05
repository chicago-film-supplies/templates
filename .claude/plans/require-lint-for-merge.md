# Extract the fixture lint so the manager and the API can warn before CI does

> **Phases 0–2 are DONE (2026-09-04). This doc is now only Phases 3–5**, which are
> tracked as **templates#195**. What landed is recorded at the bottom, short, so
> the reasoning behind the current shape is not lost — but this reads as a plan
> for the work that remains, not as a record of work that finished.

## The state this leaves behind

`templates` `main` now requires **three** checks: `visual-diff`, `templates-lint`
and `money-lint`. ⚠️ **`money-lint-ratchet` is deliberately NOT required** — it
is the advisory arm and it exits 1 (shows red) on purpose. Do not add it.

So an unblessed fixture can no longer reach `main`. What is still missing is
everything *before* CI: the author finds out on a pull request, after the work is
committed, released and pushed.

⚠️ **There are FOUR families now, and the fourth is the one the port has to think
about.** `packing-list` registered 2026-09-05 with **zero fixtures and zero
goldens**. `lint-fixtures.ts` iterates directories under `fixtures/`, so it never
examines that family at all — its success line reads *"23 fixture(s) across 2
family(ies)"* while four families exist and one of them renders in production
ungated. **That behaviour is deliberate and must be preserved in the port**: a
family mid-build is not a finding. But it stopped being hypothetical the moment a
real family shipped in that state, so `lintFixtureSet` must take the family list
and the fixture list as *separate* inputs rather than deriving families from
whatever has a fixture directory — otherwise the fold cannot even express "this
family is ungated", which is the question a caller will eventually want to ask.

⚠️ **Adding a core enum member is DEPLOY-ORDERED, and it bit twice** — see
templates#156 and `CLAUDE.md`. It is not a hazard for Phase 3 (`lintFixtureSet` is
a new *export*, not a new enum member), and Phase 4's `golden_last_attempt` is an
*added optional* field, which is the benign direction: a `z.strictObject` refuses
an undeclared key present in storage but accepts a declared key absent from it.
Know this before you reason about it from scratch — and if either phase does grow
a new enum member, check what **prod's deployed release** accepts, not `main` and
not this repo's pin.

## What is missing

`scripts/lint-fixtures.ts` is the only implementation of the fixture rules and it
runs **only in CI**. The API's `gateDraftContent` does `validateEtaSources` +
`validateIncludeTargets` and nothing else; the fixture verbs schema-parse the
document and bound the description. **No PII scan, no golden parity, no
declared-param check server-side**, and none at all in the manager.

Two of those are defects rather than mere lateness:

- **An undeclared param key (check 5a) is accepted at save**, then throws later
  inside core's `resolveRenderParams` — taking the family's *whole* `visual-diff`
  run with it, not just that fixture.
- **`PUT /fixtures/{slug}` neither sanitizes nor scans PII**, and it is the
  manager's own JSON textarea: an unsanitized write path into git, against a dev
  database that mirrors production.

## The work

- **Phase 3 — extract the lint into `@cfs/core/utils/templates`** as a pure fold
  over what core already types. `scripts/lint-fixtures.ts` becomes a thin disk
  adapter, still `--allow-read` only. The alternative is two implementations of
  one rule drifting.
- **Phase 4 — api-cloudrun runs it** at commit/release and at the fixture verbs,
  returning `lint_warnings`. ⚠️ **Warn, never block** — a save must stay possible
  before a golden exists. Response shapes are declared inline in
  `routes/templates.ts`, so this costs no core publish of its own.
- **Phase 5 — the manager renders the findings**, and stops showing a stale
  golden verdict as current. `mergeAffordance`'s `blocked` arm currently says "a
  required check" because it cannot know *which*; feeding it the findings is what
  lets it name the cause.

## What will cost a publish if missed

⚠️ **Port by reading the script, not this doc — the check set is not fixed.** It
ran six checks until #187 retired the org-derivation one. Do not hard-code a
count; do not type `check` as a closed union a seventh would have to widen.

⭐ **Preserve the per-check EXAMINED tallies.** Check 6 was retired *cleanly* only
because it printed `0 org chain(s) compose to their own name` on the run after the
fixtures were stripped — turning "should this be removed?" into an observation
rather than a judgement call. **A check that cannot fail is not coverage**, and
the success line's counters are what make a vacuous check announce itself.

⚠️ **Bundle `golden_last_attempt` into the same beta.** Phase 4 needs it on
`TemplateVersion`. Today `goldenDiff` skips `persistGoldenResults` entirely when
the aggregate is `renderer-unavailable`, so **one Gotenberg cold start discards
every fixture's result** while the prior array survives with its old `sha` and
`checked_at` — which the manager renders as current. No field can say "ran,
produced nothing". Finding this after the publish costs a second beta and a second
round of pin bumps across three repos.

⚠️ **Coordinate the beta.** Consumers pin exactly, so an interleaved publish costs
every other session a re-bump. Ask on `core/beta` before pushing.

**Behaviours to keep verbatim in the port:** `templateSchemaFor`, deliberately
*not* the collection registry; PII over **string leaves of the parsed JSON**, not
raw text, running whether or not the schema check passed; `MIN_DESCRIPTION = 40`
plus bidirectional sidecar↔file drift; check 4 graduation-scoped and **failing
open**; check 5a **not** graduation-scoped, 5b scoped.

---

## Landed 2026-09-04 — the short record

| | |
|---|---|
| **1a** | a fixture can SAY which param state its golden is frozen at — manager `230a4f3`, closes manager#348 |
| **1b** | a fixture delete takes its golden baselines with it — api-cloudrun `9bf8f391` |
| **1c** | the money ratchet split by direction — templates#194 |
| **1d** | component families got a publish control at all — manager `b1dc758` |
| **1e** | stopped promising a publish that can never happen — manager `b1dc758` (partial; manager#316 open) |
| **2a** | scope the blame, never the detection — templates#194 |
| **2b** | three checks required on `main` — closes templates#175, structurally closes api-cloudrun#688 |

**Why 2b needed 1a–1c first:** each was a lint state with **no control in the
manager**, so requiring the checks would have converted a silent hole into an
unclearable merge blocker — on a product whose operators do not all have GitHub
access. Post-#184 `quote` and `invoice` each satisfied check 5b with *exactly one*
fixture, so a single delete would have reddened the gate with no way back.

**The rule 2a is built on, which must not be undone:** the scan is whole-tree and
only the BLAME is scoped. `beta.307` deleted `DocumentOrganizationSnapshot.name`
and all 23 fixtures stopped satisfying their schemas **while the bump touched zero
fixture files** — a changed-files-scoped scan would have passed it.
`scripts/affectedFamilies.ts`'s path table therefore **disagrees with
`visual-diff.yml`'s on four rows, deliberately.** Do not reconcile them.

## Context recommendation

**CLEAR CONTEXT.** Phases 3–5 are a fresh cross-repo tier; nothing from the
Phase 1–2 execution is needed to carry them out, and this doc plus templates#195
carries what was learned.
