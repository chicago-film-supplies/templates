/**
 * Is `capture-floor.json`'s `min_core` still high enough to cover every PII
 * mask that EXISTS?
 *
 * ## The class this exists for
 *
 * `capture-floor.json` is the floor a fixture capture is allowed to sanitize
 * with. api-cloudrun#838's guard (`api-cloudrun/src/services/templates/captureFloor.ts`)
 * compares the DEPLOYED build's `@cfs/core` against that number and refuses the
 * capture when the build is below it. What no guard could see is the other
 * staleness: **a new `pii: "mask"` tag landing in `@cfs/core` while the number
 * stays put.** Then the deployed build passes the floor, the capture proceeds,
 * and the newly-masked field is written to git verbatim — the original defect,
 * one level up (templates#213).
 *
 * ⚠️ **It fails in the opposite direction to the enum guard next door.** An
 * undeclared enum member 500s the publish webhook loudly; a missing mask
 * **succeeds** and writes the leak into git history, where it cannot be recalled.
 *
 * ⭐ **A declaration needs a population assertion beside it.** `min_core`'s `why`
 * field names the masks it was raised for, which makes the number *answerable*
 * by a later reader — it is not a detector. This is the detector.
 *
 * ## Why this reads the REGISTRY, and why the repo's own pin will not do
 *
 * The question is *"does some published core carry a mask this floor does not
 * require?"*, and that is a fact about `@cfs/core`'s published history — not a
 * fact any file in this repository holds. Same reason `scripts/lint-deployed-enums.ts`
 * reaches out, different oracle.
 *
 * 🔴 **Do NOT later "simplify" this to compare against this repo's own
 * `deno.json` pin.** It reads like the same check and is not: the floor's
 * consumer is *api-cloudrun's deployed build*, so the danger is a mask that
 * exists while the deployed build lacks it. Resolving against templates' pin
 * makes the check blind for exactly as long as that pin lags — and a pin lag is
 * invisible here, because nothing in this repo imports the field that moved.
 *
 * ⚠️ **The registry's `https://jsr.io/@cfs/core/meta.json` endpoint has no usable
 * `latest` field.** Every published version is a
 * prerelease (`10.0.0-beta.N`), so JSR reports `latest: null`; the newest is
 * computed from the version list here. A future non-prerelease release would
 * make `latest` start answering — it is still not read, deliberately, because
 * the beta series is what the consumers pin.
 *
 * ## The walk
 *
 * `TEMPLATE_COLLECTION_SCHEMAS` (the capturable source registry — what
 * `schemaForCollection` resolves through) × `collectLeafPaths(schema,
 * { inherit: ["pii"] })`, keeping every leaf whose merged `pii` tag is neither
 * absent nor `"none"`. Both are imported DYNAMICALLY at an explicit version, so
 * one process holds two builds of core at once and compares them.
 *
 * ⭐ **A STATIC walk is the right tool here, and that is worth stating because
 * the nearest neighbour needs the opposite.** `@cfs/core/utils/fixture-pii`'s
 * mask oracle must resolve discriminated unions against the row in hand —
 * `collectLeafPaths` emits every union member at the same path, which scoped 292
 * product names into a venue vocabulary when it was tried the static way. That
 * lesson is about judging a VALUE. This compares DECLARATIONS, where every arm's
 * tag is exactly what we want in the set: a mask on any arm is a mask that
 * exists.
 *
 * ⚠️ `unhandled` MUST come back empty. A non-empty walk means a subtree was
 * silently skipped, so an absent tag would be indistinguishable from an
 * unreachable one — that is a COULD NOT VERIFY, not a pass.
 *
 * ## 🔴 The floor may legitimately sit ABOVE what the tags require — this lint
 * only fails it LOW, and that asymmetry is deliberate
 *
 * A tag set is a *declaration*; masking correctness also depends on the fake
 * ROUTER, which no tag can express. Measured 2026-09-06, and it is why this
 * paragraph exists: the floor stood at `beta.351` (correct for every tag),
 * `captureFloorVerdict` passed against prod's `beta.353`, and a real capture
 * still produced `Casey Maddox` for an `organization.name` and `6860 Elm Ln`
 * for a destination divider — because `fakeForMask` chose a category from the
 * VALUE's shape until api-cloudrun#837, and the corrected router only reached
 * `@cfs/core` in `beta.355`. **The guard passed and the capture was still
 * wrong.**
 *
 * So the floor is now `beta.355` — above what any tag needs — and this lint
 * reports it CURRENT, correctly. **Do not "repair" a floor down to the tag
 * minimum.** A floor above the newest published version is still refused (that
 * one can never be satisfied); a floor between the tag minimum and the newest
 * is a deliberate statement about the BUILD, and `capture-floor.json`'s `why`
 * is where it says which.
 *
 * ## Three states, and this one fails CLOSED where its neighbour fails OPEN
 *
 * `CURRENT` (exit 0) · `STALE` (exit 1) · `COULD NOT VERIFY` (**exit 1**).
 *
 * 🔴 **The divergence from `scripts/lint-deployed-enums.ts` is deliberate — do
 * not reconcile them.** That check fails open on an unreachable oracle because a
 * blip must not become an unclearable merge blocker on a REQUIRED workflow whose
 * operators do not all have GitHub access. The reasoning does not carry, because
 * the two failures are not comparable:
 *
 * | | missed enum member | missed PII mask |
 * |---|---|---|
 * | how it surfaces | publish webhook 500s, loudly | capture succeeds, quietly |
 * | what it costs | a rolled-back publish, re-runnable | customer data in git history |
 * | reversible | yes | **no** |
 *
 * A blocked PR is cleared by re-running the job. A disclosure into git history is
 * not cleared by anything. templates#213 asks for fail-closed in as many words,
 * and the guard this backs resolves every uncertainty to "refuse" for the same
 * reason.
 *
 * ## Counters
 *
 * ⭐ **The tally is what stops a pass from being vacuous** — same rule as the
 * enum lint's `0 value(s) checked`. The success line names both versions, the
 * collections walked, and the tagged-leaf count on each side. `0 tagged leaf(s)`
 * is a finding, not a pass: it means the walk found nothing to compare and the
 * run is not evidence of anything.
 *
 * ## Measured 2026-09-06, when this landed
 *
 * Floor `10.0.0-beta.328` vs newest `10.0.0-beta.355`: **one** tagged leaf in the
 * newest that the floor lacks — `invoices:notes=mask`, bisected to
 * `10.0.0-beta.351` (absent at `.350`). Two leaves went the other way
 * (`invoices:external_notes`, `invoices:internal_notes`), which is the invoice-notes
 * consolidation and is NOT staleness — reported as a notice so the `why` prose
 * can be corrected rather than silently outlived.
 *
 * Run: deno task lint:capture-floor
 */

const FLOOR_FILE = "capture-floor.json";
const JSR_META = "https://jsr.io/@cfs/core/meta.json";

/** Every leaf the walk keeps, as `collection:dotted.path=tag`. */
type TagSet = Set<string>;

// Refuse arguments rather than ignore them — `scripts/lint-fixtures.ts`'s header
// carries the incident behind that rule (an ignored argument made a history scan
// re-lint the working tree 72 times and report clean).
if (Deno.args.length > 0) {
  console.error(
    `lint-capture-floor: takes no arguments, but got ${Deno.args.length} ` +
      `(${Deno.args.map((a) => JSON.stringify(a)).join(", ")}).\n\n` +
      `  It reads ${FLOOR_FILE} relative to the CWD and the published version\n` +
      `  list from ${JSR_META}. There is deliberately no version override: an\n` +
      `  override is the shape that makes the check answer about a core nobody\n` +
      `  will deploy.\n`,
  );
  Deno.exit(2);
}

/**
 * Print the honest state and FAIL.
 *
 * ⚠️ Reserved for "could not obtain the oracle" — see the header's table. Do not
 * widen it to cover a positive finding; the two read differently on purpose.
 */
function couldNotVerify(reason: string): never {
  console.error(
    `\n🔴 lint-capture-floor: COULD NOT VERIFY.\n` +
      `    ${reason}\n\n` +
      `    0 tagged leaf(s) compared — this run is NOT evidence that\n` +
      `    ${FLOOR_FILE}'s min_core covers every PII mask that exists.\n\n` +
      `    Failing CLOSED on purpose: a stale floor lets a capture write real\n` +
      `    customer data into git, which nothing can recall. That is not the\n` +
      `    same trade as lint-deployed-enums.ts, which fails open — see this\n` +
      `    file's header before making them agree.\n\n` +
      `    By hand:\n` +
      `      curl -s ${JSR_META} | jq -r '.versions | keys[]' | sort -V | tail -1\n`,
  );
  Deno.exit(1);
}

// ── Version ordering ────────────────────────────────────────────────
//
// The published series is `10.0.0-beta.N` throughout (315 versions, N 39..355,
// measured 2026-09-06 — with 162 and 163 missing, which is why every ordering
// below walks the PUBLISHED LIST rather than counting integers).
interface Parsed {
  release: [number, number, number];
  beta: number | null;
}

function parseVersion(v: string): Parsed | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!m) return null;
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    beta: m[4] === undefined ? null : Number(m[4]),
  };
}

/** −1 / 0 / 1. A release sorts ABOVE every prerelease of the same version. */
function compareVersions(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (a.beta === b.beta) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta < b.beta ? -1 : 1;
}

// ── The floor ───────────────────────────────────────────────────────
let floorDoc: { min_core?: unknown; why?: unknown };
try {
  floorDoc = JSON.parse(await Deno.readTextFile(FLOOR_FILE));
} catch (err) {
  couldNotVerify(
    `could not read ${FLOOR_FILE}: ${err instanceof Error ? err.message : String(err)}`,
  );
}
const floorVersion = floorDoc.min_core;
if (typeof floorVersion !== "string" || parseVersion(floorVersion) === null) {
  couldNotVerify(
    `${FLOOR_FILE} min_core is ${JSON.stringify(floorVersion)}, which is not a ` +
      `version this script can order (expected \`X.Y.Z\` or \`X.Y.Z-beta.N\`).`,
  );
}
if (typeof floorDoc.why !== "string" || floorDoc.why.trim() === "") {
  // Not a version question, but it is the half that makes the number
  // answerable, and nothing else asserts it exists.
  couldNotVerify(
    `${FLOOR_FILE} carries no \`why\` — the floor must name the masks it was ` +
      `raised for, or the next reader has a bare number and no way to check it.`,
  );
}

// ── The oracle: what has been published ─────────────────────────────
let published: string[];
try {
  const res = await fetch(JSR_META, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    await res.body?.cancel();
    couldNotVerify(`GET ${JSR_META} returned HTTP ${res.status}.`);
  }
  const meta = await res.json();
  const versions = meta?.versions;
  if (!versions || typeof versions !== "object") {
    couldNotVerify(
      `the response carried no \`versions\` map — the registry has moved, and ` +
        `this check needs rewriting against wherever it went.`,
    );
  }
  // A yanked version is one nobody should be deployed on, so it cannot be the
  // oracle for "what masks exist".
  published = Object.entries(versions as Record<string, { yanked?: boolean }>)
    .filter(([v, m]) => !m?.yanked && parseVersion(v) !== null)
    .map(([v]) => v)
    .sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!));
} catch (err) {
  couldNotVerify(
    `GET ${JSR_META} failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}
if (published.length === 0) {
  couldNotVerify(`${JSR_META} listed no orderable, unyanked version of @cfs/core.`);
}
const newest = published[published.length - 1];

// ⚠️ **Ordered BEFORE the walks deliberately.** A floor above everything
// published is by definition an UNPUBLISHED version, so `tagsAt` would fail to
// import it and this would report COULD NOT VERIFY — a true statement that
// names the wrong problem and hides an exact one. Asked here, the arm is
// reachable; asked after the walk, it is dead code.
if (compareVersions(parseVersion(floorVersion)!, parseVersion(newest)!) > 0) {
  console.error(
    `\n🔴 lint-capture-floor: ${FLOOR_FILE} names min_core ${floorVersion}, ` +
      `which is ABOVE the newest published @cfs/core (${newest}).\n\n` +
      `    No build can satisfy it, so captureFloorVerdict refuses EVERY\n` +
      `    capture until a core at or above it is published AND deployed.\n\n` +
      `    ${published.length} version(s) published; newest ${newest}.\n`,
  );
  Deno.exit(1);
}

// ── The walk, at an explicit version ────────────────────────────────

/**
 * The `pii`-tagged leaf set of one published core, or `null` when that version
 * could not be interrogated.
 *
 * ⚠️ Returns `null` rather than an empty set on every failure. An empty set and
 * "the module would not load" are the same value otherwise, and the empty one
 * compares as *covered by everything* — a silent pass. Same shape as
 * `resolvedCoreVersion`'s deliberate `null`.
 *
 * ⚠️ Dynamic `import()` with a template literal is what keeps the version a
 * RUNTIME choice: a static specifier would be resolved through this repo's
 * import map and lockfile, which pins one version and is the thing being
 * compared against.
 */
async function tagsAt(version: string): Promise<{ tags: TagSet; collections: number } | null> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(`jsr:@cfs/core@${version}/schemas`);
  } catch {
    return null;
  }
  const registry = mod.TEMPLATE_COLLECTION_SCHEMAS as Record<string, unknown> | undefined;
  const collect = mod.collectLeafPaths as
    | ((s: unknown, o: { inherit: string[] }) => {
      leaves: Array<{ path: string; meta?: Record<string, unknown> }>;
      unhandled: unknown[];
    })
    | undefined;
  if (!registry || typeof registry !== "object" || typeof collect !== "function") return null;

  const entries = Object.entries(registry);
  if (entries.length === 0) return null;

  const tags: TagSet = new Set();
  for (const [collection, schema] of entries) {
    const walked = collect(schema, { inherit: ["pii"] });
    // Fails closed: a skipped subtree makes an absent tag and an unreachable
    // one the same observation.
    if (walked.unhandled.length > 0) return null;
    for (const leaf of walked.leaves) {
      const tag = leaf.meta?.pii;
      if (tag === undefined || tag === "none") continue;
      tags.add(`${collection}:${leaf.path}=${String(tag)}`);
    }
  }
  return { tags, collections: entries.length };
}

const floorWalk = await tagsAt(floorVersion);
if (!floorWalk) {
  couldNotVerify(
    `could not read the pii tag set of @cfs/core@${floorVersion} (the floor). ` +
      `Either the version is unpublished, or its schemas module no longer ` +
      `exports TEMPLATE_COLLECTION_SCHEMAS / collectLeafPaths, or the walk hit ` +
      `a node it could not interpret.\n\n` +
      `    ⚠️  Deno refuses any JSR version younger than 24h unless it is\n` +
      `        excluded — deno.json excludes jsr:@cfs/core for exactly that\n` +
      `        reason, and the error it raises otherwise reads "Could not find\n` +
      `        version", not "too new". Run this as \`deno task\`, never bare.`,
  );
}
const newestWalk = await tagsAt(newest);
if (!newestWalk) {
  couldNotVerify(
    `could not read the pii tag set of the newest published @cfs/core@${newest}.`,
  );
}
if (floorWalk.tags.size === 0 || newestWalk.tags.size === 0) {
  couldNotVerify(
    `the walk produced 0 tagged leaf(s) (floor ${floorWalk.tags.size}, ` +
      `newest ${newestWalk.tags.size}). A corpus with no PII tags at all means ` +
      `the tags moved somewhere this walk does not reach, not that there are none.`,
  );
}

// Bound once so the closure below can narrow — `newestWalk` is a `let`-scoped
// nullable from TS's point of view inside a function body.
const newestTags = newestWalk.tags;

// ── Compare ─────────────────────────────────────────────────────────
const missing = [...newestWalk.tags].filter((t) => !floorWalk.tags.has(t)).sort();
const dropped = [...floorWalk.tags].filter((t) => !newestWalk.tags.has(t)).sort();

const tally = `floor @${floorVersion}: ${floorWalk.tags.size} tagged leaf(s) across ` +
  `${floorWalk.collections} collection(s) · newest @${newest}: ` +
  `${newestWalk.tags.size} across ${newestWalk.collections} · ` +
  `${published.length} version(s) published`;

if (missing.length === 0) {
  const droppedLine = dropped.length === 0 ? "" : `\n\n` +
    `    ℹ️  ${dropped.length} tagged leaf(s) present at the floor are GONE from\n` +
    `        ${newest}. That is a rename or a removal, not staleness — but the\n` +
    `        floor's \`why\` may now name a field that no longer exists:\n` +
    dropped.map((t) => `          - ${t}`).join("\n");
  console.log(
    `\n✅ lint-capture-floor: min_core ${floorVersion} covers every pii tag in ` +
      `the newest published core.\n    ${tally}${droppedLine}\n`,
  );
  Deno.exit(0);
}

// ── STALE — name the minimal correct floor ──────────────────────────
//
// ⭐ The useful output is the number to write, not "go and find it". Bisect the
// published list between the floor and the newest for the earliest version that
// carries every tag the newest does.
//
// ⚠️ The bisect assumes the predicate is MONOTONE (a mask, once landed, stays).
// That is not guaranteed by anything, so the boundary is verified rather than
// trusted: the version below the answer must NOT cover. If it does, say so and
// fall back to the newest, which is always correct and merely over-strict.
async function covers(version: string): Promise<boolean | null> {
  const walk = await tagsAt(version);
  if (!walk || walk.tags.size === 0) return null;
  return [...newestTags].every((t) => walk.tags.has(t));
}

let suggestion = newest;
let suggestionNote =
  `the newest published version — a bisect for the exact introducing version ` +
  `could not complete, so this is the safe over-strict answer`;

const floorIdx = published.indexOf(floorVersion);
if (floorIdx !== -1) {
  let lo = floorIdx + 1;
  let hi = published.length - 1;
  let bisectOk = true;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const verdict = await covers(published[mid]);
    if (verdict === null) {
      bisectOk = false;
      break;
    }
    if (verdict) hi = mid;
    else lo = mid + 1;
  }
  if (bisectOk) {
    const below = lo - 1 >= 0 ? await covers(published[lo - 1]) : false;
    if (below === false) {
      suggestion = published[lo];
      suggestionNote = `the earliest published version carrying every tag the ` +
        `newest does (verified: ${published[lo - 1]} does not)`;
    } else {
      suggestionNote = `the newest published version — the tag set is NOT ` +
        `monotone across the range (${published[lo - 1]} also covers), so the ` +
        `bisect's answer would not be safe`;
    }
  }
}

console.error(
  `\n🔴 lint-capture-floor: ${FLOOR_FILE}'s min_core is STALE.\n\n` +
    `    ${missing.length} pii tag(s) exist in @cfs/core@${newest} that ` +
    `@cfs/core@${floorVersion} does not have:\n` +
    missing.map((t) => `      + ${t}`).join("\n") +
    `\n\n` +
    `    A build at the floor passes captureFloorVerdict and writes ` +
    `those\n    field(s) to git UNMASKED. Raise the floor:\n\n` +
    `      ${FLOOR_FILE}  min_core: "${suggestion}"\n` +
    `      (${suggestionNote})\n\n` +
    `    …and update its \`why\` to name the new mask(s).\n\n` +
    `    🔴 Then check what api-cloudrun actually has DEPLOYED before merging.\n` +
    `       A floor above the deployed core refuses every capture, including\n` +
    `       the ones the raise was meant to make safe. The deployed core is not\n` +
    `       a fact any repo holds — read it off the running revision:\n` +
    `         curl -s https://api.chicagofilmsupplies.com/openapi.json | jq -r .info.version\n` +
    `         gh release list -R chicago-film-supplies/api-cloudrun --limit 5\n` +
    `         git -C ../api-cloudrun show <tag>:deno.json | grep -o '@cfs/core@[0-9a-z.-]*' | sort -u\n\n` +
    (dropped.length === 0 ? "" : `    ℹ️  ${dropped.length} tag(s) went the other way (a rename or removal, ` +
      `not staleness):\n` + dropped.map((t) => `          - ${t}`).join("\n") + `\n\n`) +
    `    ${tally}\n`,
);
Deno.exit(1);
