# Making template-branch work visible in the manager, before and after commit

**Date:** 2026-08-25 • **Repo:** templates (+ api-cloudrun, manager, claude-plugins) • **Status:** ⏳ committed on four branches, none pushed or merged — merging waits on the destinations campaign
**Origin:** the ask *"any work Claude Code does on a template branch should be viewable in the manager, before and after commit"*, and the templates#126 episode that showed why it wasn't.
**Related:** api-cloudrun#667 (the queue entry for the landing below) · templates#126 · templates#79 · api-cloudrun#524 / #526 / #530 / #553

## START HERE

The work is **written and green**; what remains is landing it in a specific order and running the half of the verification that needs a deploy. Four branches, one per repo:

| repo | branch | at |
|---|---|---|
| api-cloudrun | `feat/templates-patch-mode` | `7ce51785` |
| templates | `chore/template-authoring-guard` | this doc's commit |
| manager | `feat/template-editor-owned-files` | `5a3b045` |
| claude-plugins | `docs/template-authoring-sidecar-writers` | `52f57f3` |

Each lives in a worktree at **`~/cfs-tmpl/<repo>`**. ⚠️ **That path is load-bearing, not arbitrary.** They were first cut at `~/cfs/<repo>-tmpl` and both citation audits broke: the linters derive the workspace from the script's grandparent directory and the repo identity from the directory NAME, so `api-cloudrun-tmpl` matched no entry in their `REPOS` list — every cross-repo citation went ambiguous, `EXEMPT` keys stopped matching, and `deno task gate` failed on prose nobody had touched. Under `~/cfs-tmpl/api-cloudrun` the audits see a four-repo workspace (the CI shape) and pass. If you re-cut a worktree, name the directory after the repo and put it under a different parent.

## What the problem actually was

Publishing was never broken. `publishFromMerge` resolves content from the merged SHA, so a raw-git-authored branch publishes the *newer* content, not the stale Firestore copy — templates#126 (187 lines authored with raw `Edit`/`Write` on `draft/quote/bd7dfc09`, merged, now `published` / `4.4.0`) came out correct.

**The gap is draft-time visibility.** For the whole life of that draft the manager showed pre-edit content, the draft preview could not show the work, and `git log` was the only witness. And the correct path kept losing on ergonomics: `templates_propose_edit` took whole file bodies, and `templates/quote.eta` is ~950 lines / 48 KB — ~13k tokens re-emitted for a one-line change, plus 949 lines the model wasn't trying to touch that it could silently drift.

So: make the MCP path cheap, then make the invisible path impossible.

## Done

**api-cloudrun `7ce51785`** — full suite green (1812 passed), `deno task gate` green.

- **Patch mode.** `templates_propose_edit` takes `edits` — `{path, old_string, new_string, replace_all?}[]`, the Edit tool's contract exactly. `content` merges first, then `edits` apply to that result in array order. Refusals are 422s naming the path and what was seen (`EDIT_PATH_NOT_FOUND` lists the files that ARE there, `EDIT_AMBIGUOUS` gives the count); nothing is PUT. The result flows through `gateDraftContent`, so a patch that breaks the template is refused at the save. `saveDraftMerged` + `applyContentEdits` in `src/services/mcp/tools/templates.ts`.
- **The sidecar gets one writer per section.** `propose_edit` 422s `SIDECAR_NOT_DRAFT_AUTHORED` on `templates/*.meta.json` (component sidecars deliberately not matched — they have no other writer). `commit_draft` / `release_draft` resolve the sidecar **off the branch** (`resolveCommitContent`, `src/services/templates/drafts.ts`), overlay `version.params`, and persist the result back into the draft map in the same guarded write that stamps `committed_content_hash`.
- **`PATCH /templates/{uid}/metadata` gains `render`** — margins, `base_font_size`, `filename`, `footer`, `header` — validated against the same `RenderConfigSchema` the render lib uses, `.strict()` on the write path. Routed like `depends_on`: visual, PR left open for a human.
- **Two latent defects found and fixed en route.** `serializeSidecarCanonical` deleted every key it did not name, and `render` was not on its list — renaming prod's `quote` would have published margin-less, footer-less PDFs. Both serializers now live in the db-free `src/services/templates/sidecarFormat.ts` and keep unknown keys. And `classifyAffected` reads paths, never blob contents, so a sidecar-only `render` change classified as metadata-only and would have merged without ever reaching a version's content map; `publishResolvedTemplates` re-checks it (`renderBlockUnchanged`) and drops a moved block through to the normal publish path.
- **Tests fail against the pre-fix code, and that was verified**, not asserted: reverting `resolveCommitContent` at both call sites fails 4 of the 6 new sidecar tests, and the 2 that still pass are the ones asserting behaviour that must NOT change.

**templates (this branch)** — `lint:fixtures` and `lint:citations` green.

- `.claude/hooks/draft-content-guard.sh` + its `PreToolUse` wiring in the committed `.claude/settings.json`. Denies `Edit`/`Write`/`MultiEdit` on `templates/*.eta`, `templates/*.meta.json`, `styles/*.css`, `partials/**`, `layouts/*.eta` whenever the FILE's checkout is on a `draft/*` branch. Three refusal messages — content, sidecar, shared overlay — each naming the verb to use instead. Tested by hand across all three kinds plus `fixtures/`, `goldens/`, `scripts/`, `.github/`, `*.md`, `deno.json`, and against `main` / a `chore/…` worktree.
- `CLAUDE.md`: two passages were **false**, not merely incomplete, and are corrected rather than extended — *"raw git stays correct for everything that is not template content under an open draft"* and *"re-apply the same content through `templates_propose_edit` to resync"*. The `templates_render_preview` line (which claimed it could not render a draft) was stale since api-cloudrun `4c866579`, and was the line pushing agents toward `deno task preview` and thence to editing the working tree. Added: the owned-path/visibility table, patch mode, the sidecar's writers, and the templates#126 record.

**manager** — `npm run typecheck` + every lint green.

- `TemplateEditor.tsx` lists `partials/<gp>/*` keys as tabs. That family had been owned, MCP-writable and committed by every draft commit since the pipeline existed, with **no manager surface at all**.
- `TemplateDetail.tsx` grows a **Page setup** form over the sidecar's `render` block — its first editing surface anywhere. Held as strings while editing so an emptied box means "unset" rather than "zero"; reconciles against the active published version's content map, because the block is never projected onto the family doc.

**claude-plugins** — `cfs-template-authoring` gains "How an edit reaches both stores" (patch mode, `uid_version`) and the sidecar's one-writer-per-section table.

## Remaining

1. **Land, in this order** (the guard must not deny agents into a tool that cannot yet take patches; full-body `propose_edit` keeps working throughout, so a slip is expensive, not breaking):
   1. rebase `feat/templates-patch-mode` onto `origin/main`, merge → dev deploy;
   2. release-please PR → prod;
   3. templates PR — **a human authorizes**; after step 2, so the hook's instruction is true when it fires;
   4. claude-plugins — also after step 2: org-shared and auto-installed, so merging early tells every agent about a `propose_edit` argument that is not in prod yet;
   5. manager → `main` → preview deploy;
   6. `git worktree remove` all four, and prune the merged local `draft/quote/bd7dfc09`.
2. **Verification that needs the deploy** (the rest already ran — see below):
   - `templates_propose_edit` with `edits` through the real `cfs-templates` server;
   - against prod: an `edits` change to one line of `styles/quote.css` → manager shows it and badges "not in git" (**visible before commit**); `templates_render_preview` with `uid_version` returns the changed render; `templates_commit_draft` → badge clears, branch head carries it (**visible after commit**). Repeat on `partials/quote/footer.eta` to prove the previously-invisible file round-trips.
   - the manager locally against a dev draft (`deno task dev` + `VITE_API_URL=…npm run dev`): tabs for eta/css/footer, the render block editable in Details, a footer edit round-tripping into the PDF preview. ⚠️ Dev drafts base off `sandbox` and `goldens/sandbox/` is empty (templates#125 / #118) — a green golden verdict there proves nothing visual.
3. **Delete this doc in the commit or PR that lands the last piece.**

## Decisions, including what was rejected

- **`propose_edit` cannot take a `path`.** The templates MCP server is a **remote** HTTP endpoint — `api-cloudrun/src/routes/mcp.ts` builds a fresh server per request on Cloud Run — so a path would name the *container's* filesystem. Patch mode is the answer to the same problem.
- **"The API refuses non-browser writes by design (CSRF)" is overstated.** `api-cloudrun/src/middleware/csrf.ts` rejects state-changing requests whose `Origin` isn't allowlisted, and `Origin` is a header a CLI can set. CSRF guards a *browser* being tricked into spending the user's cookies. The real blocker for a local sync script is holding a credential with `templates.propose`.
- **The 422 alone would not have killed the sidecar revert** — resolving the sidecar off the branch is what does. The 422 stops a draft *authoring* it; only the branch-resolve stops a draft *reverting* it.
- **`params[]` is overlaid at commit rather than left to the branch** because `publishFromMerge` prefers the flipped version's `params` over the sidecar's — the version's list is what actually publishes, so git recording anything else is git recording a lie, and this repo's `deno task preview` reads render params straight out of the sidecar.
- **The shared overlay stays out of the template editor.** Those files belong to the `base` component family; editing a draft's frozen copy forks it, and `rebaseDraftVersion` reconciles that only while the draft is clean.
- **A `render` change cuts a real version rather than a metadata-only projection.** The document renders differently, so a semver bump is the honest answer; the guard is conservative when it cannot compare both blocks, to avoid churning a version on every rename.

## Verified vs assumed

**Verified:** api-cloudrun's full suite and gate; the falsifying direction of the sidecar tests; the guard hook by hand across every path class and three branch kinds; manager typecheck + all seven lints; both citation audits.
**Not yet verified:** anything requiring a deploy — the live MCP round-trip and the prod before/after-commit demonstration (Remaining 3). Do not report this plan as verified on the first half alone.

## Context recommendation

**CLEAR CONTEXT.** What remains is two commits and an ordered landing sequence, all specified above with exact branches, SHAs and file paths; the implementation context was exploration a landing session does not need.
