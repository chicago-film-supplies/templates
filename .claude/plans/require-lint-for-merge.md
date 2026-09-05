# Require the template lints for merge — and close the paths that make it a trap

> **STATUS 2026-09-04 — Phases 0, 1 and 2a are LANDED. What remains is one `gh api`
> call (Phase 2b) and the cross-repo extraction (Phases 3–5).**
>
> Phase 2b is **blocked on nothing but the merge of templates#194**, which is green
> and mergeable. It is deliberately not flipped by an agent: #194 touches
> workflows, which is outside the pin-only auto-merge exception, and flipping
> protection is an outward-facing change to how every future PR merges.

## Why this exists

`templates` runs four CI checks and **only `visual-diff` is required** on `main`
(re-measured 2026-09-04: `contexts: ["visual-diff"]`, `strict: false`,
`enforce_admins: false`, no required reviews).

The checks divided the job so the case fell between them: **the check that can
detect an unblessed fixture could not block, and the check that blocked could not
detect it** — `visual-diff` returns `no-golden`, an informational PASS, by design,
so a fresh capture is not a deadlock.

**Eight consecutive PRs merged with `templates-lint` red** — every pin bump from
`beta.297` (2026-08-30) through `beta.305` (2026-09-02). Each one followed the
documented rule exactly as written, because that rule said the checks must have
*CONCLUDED* on the head sha. **A failed run has concluded.** Fixed in
`templates/CLAUDE.md` and in the workspace copy; Phase 2b makes the wording moot.

**Intended outcome:** an unblessed fixture cannot reach `main`; the author learns
at save time; and every red check has an in-app path to green.

---

## ✅ Landed

| phase | what | where |
|---|---|---|
| **0** | bless the two missing goldens | templates#184 |
| **1a** | a fixture can SAY which param state its golden is frozen at | manager `230a4f3` — **closes manager#348** |
| **1b** | a fixture delete takes its golden baselines with it | api-cloudrun `9bf8f391` |
| **1c** | the money ratchet split by direction | templates#194 |
| **1d** | component families get a publish control at all | manager `b1dc758` |
| **1e** | stop promising a publish that can never happen | manager `b1dc758` (partial — see below) |
| **2a** | scope the blame, never the detection | templates#194 |

### What each one actually was

**1a** — the value was readable everywhere and settable nowhere. `saveFixture`
echoed `params` straight back, `updateFixtureMeta`'s `params` argument had no
caller, and the client's `CaptureFixtureInput` omitted the field while the server
accepted it. **A golden freezes ONE rendering per fixture**, so an undeclared
state is rendered by nothing and reachable by no threshold, no re-bless and no
number of extra fixtures. Post-#184 `quote` and `invoice` each satisfied check 5b
with **exactly one** fixture, so a single delete from the Fixtures tab would have
reddened the gate with no way back.

**1b** — `deleteFixture` never touched `goldens/`, and `goldens/` is on no editor
surface, so check 4's repair ("delete the baseline") named a control that does not
exist. Keyed on the tree, not a branch name: a draft branch carries every golden
tree, and composing `goldenPath(base, …)` would miss a `sandbox` baseline — the
exact orphan, reintroduced as a special case.

**1c** — the ratchet fails in both directions on purpose, and only one direction is
clearable by the person it blocks. `count > budget` is a `.eta` edit; `count <
budget` is an edit to `scripts/money-lint.ts`, which the manager's editor cannot
open. So `money-lint` (required) takes regressions and `money-lint-ratchet`
(advisory) takes cleanups. ⚠️ **The advisory arm still exits 1 and shows red** —
*advisory* is a property of `required_status_checks`, not of the exit code.

**2a** — the scan stays whole-tree; only the BLAME is scoped. #187 is why:
`beta.307` deleted `DocumentOrganizationSnapshot.name` and all 23 fixtures stopped
satisfying their schemas **while touching zero fixture files**. Scoped on PRs,
**unscoped on the `main` push arm** (new — `templates-lint` had none), so `main`
cannot drift red with nobody accountable.

⚠️ **`scripts/affectedFamilies.ts`'s path table deliberately disagrees with
`visual-diff.yml`'s on four rows.** Do not reconcile them — that is how #187 gets
reintroduced. The table and reasons are in that file and in `CLAUDE.md`.

### 1e is PARTIAL, deliberately

Landed: "Publish when ready" is no longer offered where `handleMerge` returns
`{merged:false, queued:true}` on a PR GitHub will never land. **Not landed:** the
one-press control that performs the recovery. That needs the create-draft route to
pass `seedOverride` (the capability exists — it is how fork seeds from arbitrary
content), and **manager#316 asks for the conflict rate to be measured first**:
every `handleRebase` failure is currently labelled "Rebase conflict", so a 500, a
403 and a real 409 are indistinguishable. **manager#316 stays open.**

---

## Phase 2b — make the checks required · REMAINS

```
gh api -X PUT repos/chicago-film-supplies/templates/branches/main/protection/required_status_checks \
  -f 'checks[][context]=visual-diff' \
  -f 'checks[][context]=templates-lint' \
  -f 'checks[][context]=money-lint' \
  -F strict=false
```

⚠️ **`money-lint-ratchet` must NOT be in that list.** It is a fourth check name as
of #194 and it is advisory by design.

Keep `strict: false` — `mergeAffordance.ts` already reasons from it.

**Prerequisites, all met except the last:** 1a ✅, 1b ✅, 1c ✅ (in #194) —
**#194 must be merged first**, or the ratchet split is not deployed and the flip
traps the very case it was built to release.

⭐ **This closes api-cloudrun#688 with no code.** "A family's first fixture PR
auto-merges before it can be blessed" is worked around by remembering
`--disable-auto`. Once `templates-lint` is required, a fixture-adding PR is red
until blessed, so auto-merge *cannot* land it. The guard replaces the habit.

**Verify:** `gh api …/protection --jq '.required_status_checks.contexts'` returns
three. Then open a throwaway draft that captures a fixture, release it, confirm it
does **not** auto-merge and reports `templates-lint` red; bless and confirm it
lands. That one test exercises templates#175 and api-cloudrun#688.

⚠️ **The first PR to meet the new gate will probably be a pin bump, not content.**
`templates` is on `beta.315` while `api-cloudrun` is on `beta.321` — the widest the
three-way skew has been. Whoever bumps discovers what 316→321 does to the stored
fixtures, with three checks newly blocking. **That is the intended behaviour**: a
red check 1 on a bump means core deleted or tightened a field the fixtures still
carry. Fix the fixtures in the same PR — which makes it not pin-only, and so
correctly outside the agent auto-merge exception, exactly as #187 was.

---

## Phases 3–5 — the cross-repo tier · DEFERRED

Tracked as a `kind:gap` issue in `templates`. Summary, so the issue can cite this:

- **Phase 3** — extract the fixture lint into `@cfs/core/utils/templates` as a pure
  fold, so the three surfaces cannot drift. ⚠️ Port by reading
  `scripts/lint-fixtures.ts`, **not this doc** — the check set is not fixed (#187
  retired check 6). ⭐ Preserve the per-check EXAMINED tallies: the org check was
  retired cleanly only because it printed `0 org chain(s) compose to their own
  name`, turning a judgement call into an observation. **A check that cannot fail
  is not coverage.** Bundle `golden_last_attempt` into the same publish or it costs
  a second beta.
- **Phase 4** — api-cloudrun: run the lint at commit/release and at the fixture
  verbs, returning `lint_warnings`. ⚠️ **Warn, never block** — a save must stay
  possible before a golden exists. Closes the two real server gaps: a typo'd param
  key (5a) currently throws later inside `resolveRenderParams` and takes the
  family's whole `visual-diff` run with it, and `set_fixture` neither sanitizes nor
  scans PII while being the manager's own JSON textarea.
- **Phase 5** — manager: render the findings; fix the stale-verdict comparison to
  use `head_sha`; make `blocked.reason` name the actual failing check and be
  permission-aware; surface `content_refreshed: false`.

⭐ **Step 0 before cutting the beta**: survey the closed vocabularies (log event
names in `core/src/schemas/log/template-event.ts`), then **write all three
consumers far enough to exercise every new field** before publishing. The survey
sees a NAME, never a TYPE.

⚠️ **Coordinate the beta.** Three sessions wanted `core/beta` on 2026-09-04 and
sequenced rather than interleaved; consumers pin exactly, so an interleaved publish
costs everyone else a re-bump. Ask before pushing to `beta`.

## Out of scope, and staying that way

`sandbox` is not gated — no required checks, `allow_force_pushes: true`,
`goldens/sandbox/` empty (templates#118, open). **Do not read a green dev run as
evidence a rendering change is safe.**

## Context recommendation

**CLEAR CONTEXT** before Phases 3–5. They are a large cross-repo tier whose
exploration is captured above and in the issue; nothing from the Phase 1–2
execution is needed to carry them out. Phase 2b alone needs no context at all —
it is the command above plus its verification.
