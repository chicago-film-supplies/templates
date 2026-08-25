#!/usr/bin/env bash
# Refuse raw-git edits to template CONTENT while a draft branch is checked out.
#
# WHY THIS IS A HARD DENY AND NOT A NOTE IN CLAUDE.md
#
# The two stores do not sync in either direction, so whichever one you write is
# the only one that moves. A `git commit` on a `draft/*` branch never reaches
# Firestore: the manager preview, `templates_render_preview` and the golden gate
# all go on serving the pre-edit content, and the operator watching the editor
# sees nothing. Measured on `draft/quote/32918fe7` (2026-08-14) the Firestore
# family was last written at draft creation, 28 minutes before the git commit
# landed — the draft never moved, and the edit was invisible to every surface
# except the working tree and the PR diff. templates#126 then did 187 lines of
# it. Prose telling an agent to use MCP kept losing to ergonomics, because
# `propose_edit` took whole file bodies and `templates/quote.eta` is ~950 lines.
# It takes `edits` now, so the cheap path and the visible path are the same
# path, and this makes the invisible one unreachable.
#
# ⚠️ Keyed off the BRANCH, never the repo. A worktree sitting on `main`,
# `sandbox` or a `chore/…` branch is untouched — pin bumps, workflows, scripts,
# fixtures and docs are all correctly raw-git work.
#
# Wired as a PreToolUse hook on Edit|Write|MultiEdit in the COMMITTED
# .claude/settings.json, so it reaches every machine and every cloud agent —
# unlike the workspace CLAUDE.md, which is untracked and machine-local
# (api-cloudrun#530).
set -uo pipefail

INPUT="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0   # can't parse → allow

FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$FILE" ] || exit 0

# A Write can name a file — or a whole directory chain — that does not exist
# yet, so walk up to the first directory that does before asking git anything,
# CARRYING the segments walked past. Dropping them silently reclassified
# `partials/shared/x.eta` as `partials/x.eta` when `shared/` had not been
# created, which is the shared overlay reading as ordinary content.
DIR="$(dirname "$FILE")"
SUFFIX="$(basename "$FILE")"
while [ ! -d "$DIR" ] && [ "$DIR" != "/" ] && [ "$DIR" != "." ]; do
  SUFFIX="$(basename "$DIR")/$SUFFIX"
  DIR="$(dirname "$DIR")"
done
[ -d "$DIR" ] || exit 0

BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
case "$BRANCH" in
  draft/*) ;;
  *) exit 0 ;;      # main / sandbox / chore-… → raw git is correct
esac

ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)" || exit 0
# `pwd -P` and `--show-toplevel` are both physical, so the prefix strip below
# survives a symlinked checkout (/tmp -> /private/tmp on macOS).
ABS="$(cd "$DIR" && pwd -P)/$SUFFIX"
REL="${ABS#"$ROOT"/}"
[ "$REL" != "$ABS" ] || exit 0   # outside the repo → not ours

# Mirrors `ownsTemplatePath` (api-cloudrun src/services/templates/ownedContent.ts).
# Everything NOT here stays editable: fixtures/, goldens/, scripts/, .github/,
# *.md, deno.json, .claude/.
case "$REL" in
  templates/*.eta|templates/*.meta.json|styles/*.css|partials/*|layouts/*.eta) ;;
  *) exit 0 ;;
esac

# The draft's env is readable off the branch name: `createDraftVersion` gives a
# dev draft a `dev/` segment so both envs can share one templates repo.
case "$BRANCH" in
  draft/dev/*) SERVER="cfs-templates (dev)"; DB="mcp__cfs-api__db_templates_versions_query" ;;
  *)           SERVER="cfs-templates-prod"; DB="mcp__cfs-api-prod__db_templates_versions_query" ;;
esac

# Three kinds of owned path, three different answers. The shared overlay is
# checked FIRST because `styles/base.css` also matches `styles/*.css`.
case "$REL" in
  layouts/*.eta|styles/base.css|partials/shared/*) KIND=overlay ;;
  templates/*.meta.json)                           KIND=sidecar ;;
  *)                                               KIND=content ;;
esac

if [ "$KIND" = "overlay" ]; then
  REASON="$(cat <<EOF
$REL belongs to a template COMPONENT family (the shared overlay), not to the
draft on $BRANCH. Every template draft carries a FROZEN COPY of it so the draft
renders standalone, and editing that copy — here or through
\`templates_propose_edit\` — forks it from the component: \`rebaseDraftVersion\`
reconciles the divergence only while the draft is CLEAN, so a dirty draft keeps
the fork and its commit writes it onto the branch.

Change it where it is authored: open a draft on the COMPONENT family
(\`templates_list\` shows them; the base overlay is \`base\`), edit it there, and
release that. Consuming templates pick it up on their next publish.
EOF
)"
elif [ "$KIND" = "sidecar" ]; then
  REASON="$(cat <<EOF
$REL is the family SIDECAR, and it has one writer per section — none of them is
a file edit, and \`templates_propose_edit\` refuses it too:

  • display_name / surfaces / depends_on / render (margins, base_font_size,
    filename, footer, header)  ->  PATCH /templates/{uid}/metadata
  • fixtures[]  ->  templates_capture_fixture / templates_set_fixture /
    templates_describe_fixture / templates_remove_fixture
  • params[]  ->  templates_propose_edit's \`params\` argument

A draft's own sidecar copy is a RENDER INPUT, not an authoring surface: a commit
resolves it off the branch, so an edit made here is overwritten by the very
commit meant to publish it.
EOF
)"
else
  REASON="$(cat <<EOF
$REL is template CONTENT and this checkout is on $BRANCH. A git commit on a
draft branch never reaches Firestore, so the manager, the draft preview and the
golden gate would all go on showing the pre-edit content for the whole life of
this draft — the edit is invisible everywhere except the working tree and the
PR diff (templates#126).

Edit it through MCP instead, which writes both stores:

  1. Find the draft uid:
       $DB with filters [["git_branch","==","$BRANCH"]]
     (or templates_read on the family and take the draft version).
  2. Patch it — send the HUNK, not the file:
       templates_propose_edit { uid: <draft uid>, version: <the version you
         just read>, edits: [{ path: "$REL", old_string: …, new_string: … }] }
     \`old_string\` must match exactly once (or pass replace_all). Server-side
     $SERVER.
  3. See it: templates_render_preview { uid, uid_version: <draft uid>, data }.
     Without uid_version you render the PUBLISHED version, not your edit.
  4. Land it: templates_commit_draft, then templates_release_draft (which opens
     the PR — agents open, a human authorizes).

Raw git is still correct here for fixtures/, goldens/, scripts/, .github/,
*.md, deno.json and .claude/ — and for everything, on main or sandbox.
EOF
)"
fi

jq -n --arg r "$REASON" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
exit 0
