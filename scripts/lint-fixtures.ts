/**
 * Fixture lint — the DISK ADAPTER.
 *
 * ⭐ **The rules are not here any more.** They live in
 * `@cfs/core/utils/template-lint` as a pure fold, so the API and the manager can
 * warn before CI does instead of an author first hearing about a schema break, a
 * PII leak, a missing coverage argument, an orphaned golden or an undeclared
 * param key on a pull request — after the work is committed, released and
 * pushed. templates#195.
 *
 * What is left in this file is I/O and presentation: read the tree, hand the
 * fold a completely-described family list, print what comes back. **Keep it that
 * way.** A rule added here rather than in core is a second implementation of one
 * rule, which is the thing the extraction removed — and the drift would be
 * invisible, because CI runs this copy and the API runs the other.
 *
 * Still `--allow-read` only.
 *
 * ⭐ **Families come from `templates/*.meta.json`, NOT from `fixtures/` dirs.**
 * That is the one behavioural change and it is the point of the extraction. The
 * old shape derived the family list from whatever had a fixture directory, so a
 * registered family with no fixtures was not merely unchecked but inexpressible:
 * `packing-list` registered with zero fixtures and zero goldens while this
 * script's success line read "23 fixture(s) across 2 family(ies)" — four
 * families existing and one of them rendering in production ungated. A family
 * mid-build is still deliberately NOT a finding; it is now reported.
 *
 * ⚠️ **The scan is whole-tree in every mode; `--blame-changed-files` scopes only
 * which findings BLOCK.** #187 is why: `beta.307` deleted
 * `DocumentOrganizationSnapshot.name` and all 23 fixtures stopped satisfying
 * their schemas **while the bump touched zero fixture files**, so a
 * changed-files-scoped SCAN would have passed that PR. See
 * `scripts/affectedFamilies.ts`, whose path table deliberately disagrees with
 * `visual-diff.yml`'s on four rows.
 *
 * Run: deno task lint:fixtures
 */
import {
  type LintFamily,
  type LintFixture,
  lintFixtureSet,
  type LintGoldenTree,
  type LintSidecar,
} from "@cfs/core/utils/template-lint";
import { BLAME_FLAG, readBlameSet } from "./affectedFamilies.ts";

/**
 * REFUSE arguments rather than ignore them.
 *
 * ⚠️ This script has never read a positional argv, and that is fine until
 * someone believes otherwise — and someone did. The GitHub-Actions-spend plan
 * gated publishing this repo (an IRREVERSIBLE disclosure) on "point the lint at
 * every historical blob":
 *
 *     git cat-file -p "$o" > /tmp/fx.json
 *     deno run -A scripts/lint-fixtures.ts /tmp/fx.json    # ← argument IGNORED
 *
 * Run as written that loop re-lints the WORKING TREE once per blob and prints
 * the same clean line seventy-two times, never opening a single historical
 * object. A vacuous pass reads exactly like a real one, and it was about to
 * discharge a decision that cannot be undone.
 *
 * Ignoring an argument is the silent failure; refusing it is the loud one. Use
 * `scripts/scan-fixture-history.ts` for the history question.
 */
const unknownArgs = Deno.args.filter((a) => !a.startsWith(BLAME_FLAG));
if (unknownArgs.length > 0) {
  console.error(
    `lint-fixtures: takes no arguments except ${BLAME_FLAG}<path>, but got ` +
      `${unknownArgs.length} other (${unknownArgs.map((a) => JSON.stringify(a)).join(", ")}).\n\n` +
      `  It scans the tree relative to the CWD. An argument was previously\n` +
      `  IGNORED, so a loop passing one blob at a time silently re-linted the\n` +
      `  working tree and reported clean for history it never read.\n\n` +
      `  For history:  deno task scan:fixture-history\n`,
  );
  Deno.exit(2);
}

/**
 * The families this run may BLOCK on, or `null` for "every family" (unscoped).
 *
 * Unscoped is the default and the safe mode: a local run and the `main` push arm
 * both want every finding to count. Scoping is opt-in, per-PR, and only ever
 * turns a failure into a notice.
 */
const blameSet = await readBlameSet(Deno.args);

// ── Read the tree ───────────────────────────────────────────────────

/** Directory entries of one kind, sorted. A missing directory is not a finding. */
async function entries(path: string, kind: "dir" | "file"): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (kind === "dir" ? entry.isDirectory : entry.isFile) out.push(entry.name);
    }
  } catch { /* absent */ }
  return out.sort();
}

const gitPaths = (await entries("templates", "file"))
  .filter((n) => n.endsWith(".meta.json"))
  .map((n) => n.slice(0, -".meta.json".length));

if (gitPaths.length === 0) {
  console.log("lint-fixtures: no templates/*.meta.json — no families to check.");
  Deno.exit(0);
}

/**
 * The branch trees under `goldens/`, e.g. `["main", "sandbox"]`.
 *
 * Read once rather than per family, and tolerant on purpose: no `goldens/` tree
 * at all is a repo that has never blessed anything, and a loose file sitting
 * beside the branch dirs — this repo keeps a README there — is not a branch.
 * Neither is a finding.
 */
const goldenBranches = await entries("goldens", "dir");

const families: LintFamily[] = [];
for (const gitPath of gitPaths) {
  let sidecar: LintSidecar | null = null;
  try {
    sidecar = JSON.parse(await Deno.readTextFile(`templates/${gitPath}.meta.json`)) as LintSidecar;
  } catch { /* `null` is itself the finding the fold reports */ }

  // A parse failure is a FINDING, not an exception — so it is handed to the
  // fold rather than thrown here.
  const fixtures: LintFixture[] = [];
  for (const name of await entries(`fixtures/${gitPath}`, "file")) {
    if (!name.endsWith(".json")) continue;
    const slug = name.slice(0, -".json".length);
    const file = `fixtures/${gitPath}/${name}`;
    try {
      fixtures.push({ slug, ok: true, doc: JSON.parse(await Deno.readTextFile(file)) });
    } catch (err) {
      fixtures.push({
        slug,
        ok: false,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const goldens: LintGoldenTree[] = [];
  for (const branch of goldenBranches) {
    const slugs = (await entries(`goldens/${branch}/${gitPath}`, "file"))
      .filter((n) => n.endsWith(".png"))
      .map((n) => n.slice(0, -".png".length));
    if (slugs.length > 0) goldens.push({ branch, slugs });
  }

  families.push({ gitPath, sidecar, fixtures, goldens });
}

// ── Fold ────────────────────────────────────────────────────────────

const { findings, tally, ungatedFamilies } = lintFixtureSet({ families });

// ── Report ──────────────────────────────────────────────────────────
//
// The scan was whole-tree in every mode. What `--blame-changed-files` changes is
// only the PARTITION below: a finding in a family this diff touches BLOCKS, one
// outside it is a notice.

const blocking = blameSet === null ? findings : findings.filter((f) => blameSet.has(f.gitPath));
const notices = blameSet === null ? [] : findings.filter((f) => !blameSet.has(f.gitPath));

const scopeLine = blameSet === null
  ? "unscoped"
  : `blame-scoped to ${blameSet.size === 0 ? "(no family)" : [...blameSet].sort().join(", ")}`;

/**
 * ⭐ The EXAMINED counts, which are what make a vacuous run visible.
 *
 * Check 6 was retired *cleanly* only because it printed the number it had
 * compared, so the run after the fixtures were stripped read `0 org chain(s)`. A
 * check that cannot fail is not coverage, and a counter is what makes one
 * announce itself.
 */
const goldenSummary = tally.goldenTrees.length > 0
  ? `goldens at parity (${tally.goldenTrees.join(", ")})`
  : "no graduated golden tree";
const examined = `${tally.fixtures} fixture(s) across ${tally.families} family(ies), ` +
  `${tally.descriptions} coverage argument(s), ${goldenSummary}, ` +
  `${tally.paramStates} param state(s) asked`;

// Reported, never a finding: a family mid-build is legitimate, and reddening it
// on registration would block the very PR that creates it. Printing it is what
// the old shape could not do at all.
if (ungatedFamilies.length > 0) {
  console.log(
    `\nⓘ ${ungatedFamilies.length} registered family(ies) have NO fixture, so nothing ` +
      `golden-gates them: ${ungatedFamilies.join(", ")}.\n` +
      `  Not a finding — a family mid-build is expected — but they render in ` +
      `production ungated.\n`,
  );
}

for (const finding of notices) {
  console.log(`  ⓘ [${finding.gitPath}] ${finding.check}  ${finding.file}\n     ${finding.message}\n`);
}

if (blocking.length > 0) {
  console.error(`\nlint-fixtures: ${blocking.length} finding(s).\n`);
  for (const finding of blocking) {
    console.error(`  [${finding.gitPath}] ${finding.check}  ${finding.file}\n     ${finding.message}\n`);
  }
  console.error(`Examined ${examined} (${scopeLine}).`);
  Deno.exit(1);
}

// ⚠️ The green line must not assert what the notices above contradict. With an
// out-of-scope finding outstanding the tree is NOT clean — this run simply did
// not hold the author of it accountable — and printing a clean summary over a
// real failure is the vacuous pass this script's own argv refusal exists to
// prevent one flavour of.
if (notices.length > 0) {
  console.log(
    `lint-fixtures: ${examined} — NOT clean: ${notices.length} finding(s) above, all ` +
      `outside this change's blame scope (${scopeLine}), so this run passes. The ` +
      `\`main\` push arm runs unscoped and will be red until they are fixed.`,
  );
} else {
  console.log(`lint-fixtures: ${examined} — clean. (${scopeLine})`);
}
