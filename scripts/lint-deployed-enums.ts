/**
 * Does prod's DEPLOYED core actually have the enum members our sidecars name?
 *
 * ## The class this exists for
 *
 * The publish webhook validates a merged `templates/<gp>.meta.json` against
 * **the `@cfs/core` running in the deployed api-cloudrun** — not against this
 * repo's pin, and not against api-cloudrun's `main`. So a new
 * `collection_source` / `collection_target` / `surfaces` member is a
 * DEPLOY-ORDERED change: it has to be live in a *released* api-cloudrun before
 * a sidecar naming it reaches `main`. `CLAUDE.md` states that rule; this script
 * is the instrument for it.
 *
 * It has fired twice, a week apart, and the second time is the argument for
 * mechanising it:
 *
 * | | PR | member | this repo pinned | prod served |
 * |---|---|---|---|---|
 * | 2026-08-28 | #155 | `movement-sessions` / `receipts` | `beta.278` | `beta.277` |
 * | 2026-09-04 | #199 | `pick-sheets` | `beta.321` | `beta.319` |
 *
 * Both merged **green on every required check** and 500'd the webhook. The
 * second landed one hour after #157 merged the prose rule into `CLAUDE.md`, and
 * was authored by a session that had that rule on screen. A rule enforced by
 * whoever last remembered it is not enforced.
 *
 * 🔴 **No tree-reading lint can ever close this, however strict it gets.**
 * `templates-lint` resolves sidecars against THIS REPO'S pin, which is correct
 * for what it checks — it must agree with the API's *write* path. But the
 * deployed version is not a fact this repository holds at all: not in
 * `deno.json`, not in the lockfile, not in any file in the tree. That is what
 * makes reading the RUNNING SERVICE the whole design rather than an
 * implementation detail. Do not later "simplify" this into a local resolution
 * against the pin — that reintroduces the class silently, and a green verdict
 * from it is not weak evidence, it is *no* evidence.
 *
 * ## The oracle
 *
 * `GET <origin>/openapi.json` →
 * `components.schemas.Template.properties.<field>.enum`, served unauthenticated
 * by the very deployment that will do the validating. No credential, no new
 * endpoint, one fetch.
 *
 * ⚠️ **The enum FIELD LIST is derived from that response, never hard-coded.**
 * Three fields carry closed vocabularies today (`collection_source`,
 * `collection_target`, `surfaces`); the incidents named only the first two, and
 * `surfaces` is the same failure wearing a different key. Folding over whatever
 * the deployed schema declares as an enum means a fourth is covered on the day
 * it ships, by a script nobody edited.
 *
 * ## ⚠️ The host comes from the PR's BASE BRANCH, and that is load-bearing
 *
 * `main` → prod, `sandbox*` → dev. **A `main` PR checked against dev would pass
 * while the merge it gates fails.** Dev deploys continuously from api-cloudrun
 * `main`, so a dev check is satisfied the moment the core bump lands there — it
 * can never see this class. Measured on the #155 incident: dev registered
 * `receipt` successfully at 01:37Z while prod was still failing at 01:47Z.
 *
 * There is deliberately NO origin override. An override is precisely the shape
 * that makes the check answer about the wrong environment, which is the one way
 * it can report green and mean nothing.
 *
 * ## What blocks, and what only reports
 *
 * ⭐ **Fail OPEN on every inability to obtain the oracle** — network error,
 * non-2xx, unparseable body, no `Template` schema, no enum-bearing field. All
 * print a loud `COULD NOT VERIFY` and exit 0. A blip must not block an
 * unrelated content PR, and this step runs inside a REQUIRED workflow on a
 * product whose operators do not all have GitHub access: a fetch failure that
 * went red would be an unclearable merge blocker whose only repair is a repo
 * edit they cannot make.
 *
 * **Fail CLOSED only on the positive finding** — a real enum list in hand and a
 * sidecar naming a member outside it. That is a fact about the PR's own
 * content, and its author can fix it.
 *
 * ⭐ **The counters are what stop fail-open decaying into vacuity.** The success
 * line names the origin, the revision that answered, and how many values were
 * actually checked. `0 value(s) checked` reads as a finding rather than a pass —
 * which is the property that let check 6 be retired cleanly in #187, and the
 * reason a check that cannot fail is not coverage.
 */

import { allFamilies, BLAME_FLAG, readBlameSet } from "./affectedFamilies.ts";

const BASE_FLAG = "--base=";

/**
 * Base branch → the deployment whose core validates that merge.
 *
 * `sandbox` and `sandbox/e2e-*` are both dev; `main` is prod. Anything
 * unrecognised falls to prod, which is the fail-SAFE direction: prod is the
 * stricter oracle (dev is always at or ahead of it), so a wrong guess here can
 * only produce a finding to investigate, never a false pass.
 */
function originFor(base: string): { origin: string; env: string } {
  return base === "main"
    ? { origin: "https://api.chicagofilmsupplies.com", env: "prod" }
    : base.startsWith("sandbox")
    ? { origin: "https://dev-api.chicagofilmsupplies.com", env: "dev" }
    : { origin: "https://api.chicagofilmsupplies.com", env: "prod" };
}

// Refuse unknown arguments rather than ignore them — `lint-fixtures.ts`'s
// header carries the incident behind that rule (an ignored argument made a
// history scan re-lint the working tree 72 times and report clean).
const unknownArgs = Deno.args.filter(
  (a) => !a.startsWith(BLAME_FLAG) && !a.startsWith(BASE_FLAG),
);
if (unknownArgs.length > 0) {
  console.error(
    `lint-deployed-enums: takes only ${BASE_FLAG}<branch> and ${BLAME_FLAG}<path>, ` +
      `but got ${unknownArgs.length} other ` +
      `(${unknownArgs.map((a) => JSON.stringify(a)).join(", ")}).\n`,
  );
  Deno.exit(2);
}

const baseArg = Deno.args.find((a) => a.startsWith(BASE_FLAG));
// Default `main`: a local run is almost always work heading for `main`, and
// prod is the stricter oracle either way.
const base = baseArg ? baseArg.slice(BASE_FLAG.length) : "main";
const { origin, env } = originFor(base);
const blameSet = await readBlameSet(Deno.args);

/** Print the honest state and pass. Reserved for "could not obtain the oracle". */
function couldNotVerify(reason: string): never {
  console.log(
    `\n⚠️  lint-deployed-enums: COULD NOT VERIFY against ${origin} (${env}).\n` +
      `    ${reason}\n\n` +
      `    0 value(s) checked — this run is NOT evidence that the sidecars'\n` +
      `    enum members exist in the deployed core. Passing so a blip cannot\n` +
      `    block an unrelated content PR; check by hand before merging a PR\n` +
      `    that adds a collection_source, collection_target or surfaces member:\n\n` +
      `      curl -s ${origin}/openapi.json |\n` +
      `        jq '.components.schemas.Template.properties\n` +
      `            | with_entries(select(.value.enum or .value.items.enum))'\n`,
  );
  Deno.exit(0);
}

// ── Fetch the oracle ────────────────────────────────────────────────
let payload: unknown;
let revision = "unknown";
try {
  const res = await fetch(`${origin}/openapi.json`, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    // Drain the body so the connection can close cleanly before we exit.
    await res.body?.cancel();
    couldNotVerify(`GET ${origin}/openapi.json returned HTTP ${res.status}.`);
  }
  payload = await res.json();
} catch (err) {
  couldNotVerify(
    `GET ${origin}/openapi.json failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const doc = payload as Record<string, any>;
revision = typeof doc?.info?.version === "string" ? doc.info.version : "unknown";
const properties = doc?.components?.schemas?.Template?.properties;
if (!properties || typeof properties !== "object") {
  couldNotVerify(
    "the response carried no components.schemas.Template.properties — the " +
      "oracle has moved, and this check needs rewriting against wherever it went.",
  );
}

/**
 * field → the members the DEPLOYED core accepts.
 *
 * A string property contributes its own `enum`; an array property contributes
 * its `items.enum`, which is how `surfaces` is reached.
 */
const deployedEnums = new Map<string, string[]>();
for (const [field, spec] of Object.entries(properties as Record<string, any>)) {
  const members = spec?.enum ?? spec?.items?.enum;
  if (Array.isArray(members) && members.length > 0) {
    deployedEnums.set(field, members.map(String));
  }
}
if (deployedEnums.size === 0) {
  couldNotVerify(
    "components.schemas.Template declares no enum-bearing property at all — " +
      "either the schema changed shape or the response is not what it looks like.",
  );
}

// ── Fold over the sidecars ──────────────────────────────────────────
interface Finding {
  gitPath: string;
  text: string;
}
const findings: Finding[] = [];

const families = await allFamilies();
let valuesChecked = 0;
const fieldsSeen = new Set<string>();

for (const gitPath of families) {
  const file = `templates/${gitPath}.meta.json`;
  let sidecar: Record<string, unknown>;
  try {
    sidecar = JSON.parse(await Deno.readTextFile(file));
  } catch (err) {
    // A malformed sidecar is `lint-fixtures`' finding, not this one — but say
    // so rather than counting the family as checked.
    findings.push({
      gitPath,
      text: `${file}\n    could not be read as JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    });
    continue;
  }

  for (const [field, allowed] of deployedEnums) {
    if (!(field in sidecar)) continue;
    const raw = sidecar[field];
    const values = Array.isArray(raw) ? raw : [raw];
    fieldsSeen.add(field);
    for (const value of values) {
      valuesChecked++;
      if (typeof value !== "string" || allowed.includes(value)) continue;
      findings.push({
        gitPath,
        text: `${file}\n` +
          `    ${field}: ${JSON.stringify(value)} is NOT deployed.\n` +
          `    ${env} (${origin}, revision ${revision}) accepts: ` +
          `${allowed.map((m) => JSON.stringify(m)).join(" | ")}\n\n` +
          `    Merging this would 500 the publish webhook and roll back the\n` +
          `    WHOLE publish — every family the merge affects, not just this\n` +
          `    one — and nothing self-heals it. Release api-cloudrun with a\n` +
          `    core that has this member FIRST, then merge:\n` +
          `      gh release view --json tagName -q .tagName -R chicago-film-supplies/api-cloudrun`,
      });
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────
// Scope the BLAME, never the scan — the fold above walked every family in
// every mode. See `scripts/affectedFamilies.ts`.
const blocking = blameSet === null
  ? findings
  : findings.filter((f) => blameSet.has(f.gitPath));
const notices = blameSet === null
  ? []
  : findings.filter((f) => !blameSet.has(f.gitPath));

const scopeLine = blameSet === null
  ? "unscoped — every finding blocks"
  : `blame-scoped to ${
    blameSet.size === 0 ? "(no family)" : [...blameSet].sort().join(", ")
  }`;

const tally = `${valuesChecked} value(s) across ${families.length} family(ies) ` +
  `× ${fieldsSeen.size} enum field(s) [${[...fieldsSeen].sort().join(", ")}], ` +
  `against ${origin} (${env}, revision ${revision})`;

for (const finding of notices) {
  console.log(`  ⓘ [${finding.gitPath}] ${finding.text}\n`);
}

if (blocking.length > 0) {
  console.error(
    `\nlint-deployed-enums: ${blocking.length} sidecar value(s) name an enum ` +
      `member the deployed core does not have.\n`,
  );
  for (const finding of blocking) console.error(`  [${finding.gitPath}] ${finding.text}\n`);
  console.error(`Checked ${tally}.`);
  Deno.exit(1);
}

if (valuesChecked === 0) {
  // Not a pass. Every family read cleanly and NOTHING was compared — either no
  // sidecar carries an enum field or there are no families, and both mean this
  // run is not coverage.
  console.log(
    `\n⚠️  lint-deployed-enums: 0 value(s) checked across ${families.length} ` +
      `family(ies). The oracle answered (${origin}, revision ${revision}, ` +
      `${deployedEnums.size} enum field(s)) but no sidecar carried one of them.\n` +
      `    This run is not coverage. Passing, loudly.\n`,
  );
  Deno.exit(0);
}

// ⚠️ The green line must not assert what the notices above contradict. With an
// out-of-scope finding outstanding a sidecar DOES name an undeployed member —
// this run simply did not hold the author of it accountable — and "all
// deployed" printed over that is the stale-verdict-as-current defect.
if (notices.length) {
  console.log(
    `lint-deployed-enums: checked ${tally} — NOT clean: ${notices.length} ` +
      `finding(s) above, all outside this change's blame scope (${scopeLine}), ` +
      `so this run passes. The \`main\` push arm runs unscoped and will be red ` +
      `until they are fixed — and merging any PR while they stand rolls back ` +
      `the whole publish.`,
  );
} else {
  console.log(`lint-deployed-enums: ${tally} — all deployed. (${scopeLine})`);
}
