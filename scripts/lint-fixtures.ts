/**
 * Fixture lint — the gate that was missing.
 *
 * Fixtures were only ever validated on the WRITE path (`saveFixture` /
 * `captureFixture` in the API). Nothing checked them at rest, so both committed
 * fixtures had been invalid in git for months — they rendered fine and only
 * exploded when an operator tried to save an edit, reporting a wall of failures
 * they had not caused. A fixture hand-committed through git bypassed the only
 * gate that existed.
 *
 * Four checks, and they all scan the WHOLE tree rather than the PR's changed
 * files: a `@cfs/core` bump or a `collection_source` flip changes no fixture
 * file, and that is exactly the drift this exists to catch.
 *
 *   1. SCHEMA — every `fixtures/<git_path>/*.json` parses against
 *      `schemaFor(<collection_source>)`, read from the family's sidecar. This is
 *      the same schema `saveFixture` enforces with, so what passes here can be
 *      saved from the manager.
 *
 *   2. PII — no customer emails or phone numbers in fixture JSON. `saveFixture`
 *      validates but never calls `applyPii`, so the manager's fixture editor is
 *      an unsanitized write path into git; the capture flow sanitizes, a paste
 *      into the textarea does not.
 *
 *   3. REASON — every sidecar `fixtures[]` entry says what its fixture covers
 *      that no other one does. A fixture set is a coverage argument, and the
 *      fixture file is a strict source document with nowhere to write it down,
 *      so the sidecar is the only place it can live.
 *
 *   4. GOLDEN PARITY — on any branch where a family has graduated (its
 *      `goldens/<branch>/<git_path>/` holds at least one PNG), every fixture has
 *      a baseline and every baseline has a fixture. A fixture with no golden
 *      renders and then yields `no-golden`, which is an informational PASS — so
 *      the gate says nothing about exactly the branch the fixture was added to
 *      cover. `billing-foreign-country` landed on `main` in #113 with no
 *      baseline and stayed ungated for two days until #126 blessed it, and
 *      `evening-boundary` sat in the same state inside the draft that became
 *      #126 — nothing but a hand-count stood between it and shipping the same
 *      way. That is the state this makes unrepresentable, because counting PNGs
 *      against `ls fixtures/<git_path>/` is what kept failing.
 *
 * Fails CLOSED: a fixtures dir with no sidecar, a sidecar with no
 * `collection_source`, an unmapped collection, or sidecar/file drift are all
 * errors. Check 4 is the one deliberate exception, and it fails OPEN by design:
 * a family with NO baseline on a branch has not graduated, and saying so on
 * every PR would be noise rather than a finding (`goldens/sandbox/` holds
 * nothing at all — templates#118).
 *
 * An unmapped collection is caught BEFORE the lookup is used — the original
 * shape read `schemas[key]`, got `undefined`, and would otherwise have thrown a
 * bare TypeError on `.safeParse`. ⚠️ **The lookup is `templateSchemaFor`, not
 * the Firestore collection registry**: a template source is a document SHAPE and
 * need not be a collection at all (api-cloudrun#700), and resolving it through
 * `isCollectionName` failed closed on `movement-sessions` — the receipt's
 * source, which the API's own fixture write path validates fine.
 *
 * Run: deno task lint:fixtures
 */
import { templateSchemaFor } from "@cfs/core/schemas";

/**
 * REFUSE arguments rather than ignore them.
 *
 * ⚠️ This script scans `fixtures/` relative to the CWD and has never read argv.
 * That is fine until someone believes otherwise — and someone did. The
 * GitHub-Actions-spend plan gated publishing this repo (an IRREVERSIBLE
 * disclosure) on "point the lint at every historical blob":
 *
 *     git cat-file -p "$o" > /tmp/fx.json
 *     deno run -A scripts/lint-fixtures.ts /tmp/fx.json    # ← argument IGNORED
 *
 * Run as written that loop re-lints the WORKING TREE once per blob and prints
 * `21 fixture(s) … no PII` seventy-two times, never opening a single historical
 * object. A vacuous pass reads exactly like a real one, and it was about to
 * discharge a decision that cannot be undone.
 *
 * Ignoring an argument is the silent failure; refusing it is the loud one. Use
 * `scripts/scan-fixture-history.ts` for the history question.
 */
if (Deno.args.length > 0) {
  console.error(
    `lint-fixtures: takes no arguments, but got ${Deno.args.length} ` +
      `(${Deno.args.map((a) => JSON.stringify(a)).join(", ")}).\n\n` +
      `  It scans fixtures/ relative to the CWD. An argument was previously\n` +
      `  IGNORED, so a loop passing one blob at a time silently re-linted the\n` +
      `  working tree and reported clean for history it never read.\n\n` +
      `  For history:  deno task scan:fixture-history\n`,
  );
  Deno.exit(2);
}

const problems: string[] = [];
const note = (file: string, message: string) => problems.push(`${file}\n    ${message}`);

// ── Discover ────────────────────────────────────────────────────────

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

interface Sidecar {
  collection_source?: string;
  fixtures?: { slug: string; label?: string; description?: string }[];
}

/**
 * Minimum length for a fixture's reason.
 *
 * The schema (`@cfs/core`'s `FixtureMeta`) requires a non-empty string, which
 * stops the field being absent but not `"x"`. This is the repo-side policy on
 * top of that: a coverage argument is a sentence. Deliberately a small round
 * number rather than a tuned one — it exists to catch a placeholder, not to
 * grade prose.
 */
const MIN_DESCRIPTION = 40;

let fixtureDirs: string[] = [];
try {
  for await (const entry of Deno.readDir("fixtures")) {
    if (entry.isDirectory) fixtureDirs.push(entry.name);
  }
} catch {
  console.log("lint-fixtures: no fixtures/ directory — nothing to check.");
  Deno.exit(0);
}
fixtureDirs = fixtureDirs.sort();

/**
 * The branch trees under `goldens/`, e.g. `["main", "sandbox"]`.
 *
 * Read once rather than per family, and tolerant on purpose: no `goldens/` tree
 * at all is a repo that has never blessed anything, and a loose file sitting
 * beside the branch dirs — this repo keeps a README there — is not a branch.
 * Neither is a finding.
 */
let goldenBranches: string[] = [];
try {
  for await (const entry of Deno.readDir("goldens")) {
    if (entry.isDirectory) goldenBranches.push(entry.name);
  }
} catch { /* no goldens/ tree — nothing has graduated anywhere */ }
goldenBranches = goldenBranches.sort();

/** `<branch>/<git_path>` for every tree check 4 actually compared. */
const graduated: string[] = [];

// ── 1. Schema ───────────────────────────────────────────────────────

let checked = 0;

for (const gitPath of fixtureDirs) {
  const sidecarPath = `templates/${gitPath}.meta.json`;

  let sidecar: Sidecar;
  try {
    sidecar = JSON.parse(await Deno.readTextFile(sidecarPath)) as Sidecar;
  } catch {
    note(
      `fixtures/${gitPath}/`,
      `no sidecar at ${sidecarPath} — a fixtures dir must belong to a template family`,
    );
    continue;
  }

  const collection = sidecar.collection_source;
  if (!collection) {
    note(sidecarPath, "sidecar has no `collection_source` — cannot resolve a schema for its fixtures");
    continue;
  }

  // 🔴 `templateSchemaFor`, NOT the Firestore collection registry
  // (api-cloudrun#700). A template SOURCE names a document SHAPE, and it is not
  // always a collection: `movement-sessions` is the fold of
  // `transactions where uuid_session == …` that a receipt renders, and nothing
  // is stored at that path. Under the old `isCollectionName` guard the receipt
  // family's very first fixture would have been reported here as an unmapped
  // collection — failing CLOSED on a source the API happily validates, since
  // `schemaForCollection` (`api-cloudrun/src/services/templates/fixtureFormat.ts`)
  // already resolves through this same map. This check exists to agree with the
  // write path, so it must resolve a source the same way the write path does.
  //
  // The truthiness test is back deliberately, and it does NOT undo
  // api-cloudrun#444's narrowing: `TEMPLATE_COLLECTION_SCHEMAS` is `Partial`, so
  // `templateSchemaFor` returns `z.ZodType | undefined` and `undefined` IS the
  // "no schema for this source" answer rather than a lookup that lost its type.
  // The schema stays the WIDE view — `collection_source` is read out of a
  // sidecar at runtime, so it can only ever be the whole document union, and
  // `safeParse` below wants none of it.
  const schema = templateSchemaFor(collection);
  if (!schema) {
    note(
      sidecarPath,
      `collection_source "${collection}" has no schema in @cfs/core's \`TEMPLATE_COLLECTION_SCHEMAS\``,
    );
    continue;
  }

  const files: string[] = [];
  for await (const file of walk(`fixtures/${gitPath}`)) {
    if (file.endsWith(".json")) files.push(file);
  }
  files.sort();

  const slugsOnDisk = new Set<string>();

  for (const file of files) {
    const slug = file.slice(`fixtures/${gitPath}/`.length, -".json".length);
    if (slug.includes("/")) continue; // nested dirs are not fixtures
    slugsOnDisk.add(slug);
    checked++;

    let doc: unknown;
    try {
      doc = JSON.parse(await Deno.readTextFile(file));
    } catch (err) {
      note(file, `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const parsed = schema.safeParse(doc);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `      ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n");
      note(file, `does not satisfy the \`${collection}\` schema:\n${issues}`);
    }
  }

  // Sidecar <-> file drift, in both directions. `listFixtures` is
  // files-authoritative, but the sidecar's `fixtures[]` is what gets projected
  // onto the family doc at publish — so an entry with no file publishes a
  // fixture that never lists, and a file with no entry loses its label.
  const slugsInSidecar = new Set((sidecar.fixtures ?? []).map((f) => f.slug));
  for (const slug of slugsInSidecar) {
    if (!slugsOnDisk.has(slug)) {
      note(sidecarPath, `\`fixtures[]\` lists "${slug}" but fixtures/${gitPath}/${slug}.json does not exist`);
    }
  }
  for (const slug of slugsOnDisk) {
    if (!slugsInSidecar.has(slug)) {
      note(sidecarPath, `fixtures/${gitPath}/${slug}.json exists but is not listed in \`fixtures[]\``);
    }
  }

  // Every entry states WHY the fixture exists. The API enforces this on writes,
  // but a fixture hand-committed through git bypasses the API entirely — which
  // is the same hole that let both fixtures sit schema-invalid in `main` for
  // months, and the reason this script exists at all.
  for (const entry of sidecar.fixtures ?? []) {
    const description = entry.description?.trim() ?? "";
    if (!description) {
      note(
        sidecarPath,
        `"${entry.slug}" has no \`description\` — a fixture must record what it ` +
          `covers that no other fixture does. The fixture file is a strict source ` +
          `document with nowhere to put a comment, so this is the only place it can be said.`,
      );
    } else if (description.length < MIN_DESCRIPTION) {
      note(
        sidecarPath,
        `"${entry.slug}" has a ${description.length}-character description — too short ` +
          `to be a coverage argument (minimum ${MIN_DESCRIPTION}). Say what this fixture ` +
          `exercises that its siblings do not: ${JSON.stringify(description)}`,
      );
    }
  }

  // Golden parity, in both directions, per branch that has graduated.
  //
  // A fixture with no baseline is not a failure anywhere — `goldenDiff` renders
  // it and returns `no-golden`, an informational PASS — so the one thing the
  // fixture was added to gate is the one thing the gate stays silent about.
  // Both misses this catches were exactly that shape, and neither was visible
  // in a green CI run.
  //
  // The `>= 1 PNG` condition is what scopes it: a family with no baseline on a
  // branch has not graduated there, and reporting every fixture on an empty
  // tree would bury the real finding. That is also what keeps the empty
  // `goldens/sandbox/` silent (templates#118) without this check having to know
  // anything about which branch is which.
  for (const branch of goldenBranches) {
    const goldenDir = `goldens/${branch}/${gitPath}`;

    const pngs = new Set<string>();
    try {
      for await (const entry of Deno.readDir(goldenDir)) {
        if (entry.isFile && entry.name.endsWith(".png")) {
          pngs.add(entry.name.slice(0, -".png".length));
        }
      }
    } catch {
      continue; // no tree for this family on this branch — not graduated
    }
    if (pngs.size === 0) continue; // ditto: an empty tree is not a graduation

    graduated.push(`${branch}/${gitPath}`);

    for (const slug of [...slugsOnDisk].sort()) {
      if (pngs.has(slug)) continue;
      note(
        `${goldenDir}/${slug}.png`,
        `missing — \`${gitPath}\` has graduated on \`${branch}\` (${pngs.size} baseline(s)) ` +
          `but fixtures/${gitPath}/${slug}.json has none, so the visual diff renders it ` +
          `and then returns \`no-golden\`: an informational PASS. Whatever this fixture ` +
          `was added to cover is still ungated. Clear it by APPROVING THE RENDERS — the ` +
          `visual-diff job runs regardless and has already uploaded the candidate, so the ` +
          `baseline is one press away and it is the same press that clears a \`no-golden\` ` +
          `verdict.`,
      );
    }
    for (const slug of [...pngs].sort()) {
      if (slugsOnDisk.has(slug)) continue;
      note(
        `${goldenDir}/${slug}.png`,
        `orphaned — no fixtures/${gitPath}/${slug}.json renders it, so nothing will ever ` +
          `compare against it. Usually a renamed or removed fixture: delete the baseline, ` +
          `or restore the fixture if the rename was the mistake.`,
      );
    }
  }
}

// ── 2. PII ──────────────────────────────────────────────────────────
//
// Same heuristics as the .eta scan below in the workflow: an email whose domain
// is not ours, or a US phone number. Fixture contacts must be invented.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}|\b\d{10}\b/g;
const ALLOWED_EMAIL_DOMAIN = "chicagofilmsupplies.com";
const CFS_PHONE_DIGITS = new Set(["3128183008"]);

/**
 * 555-0100 through 555-0199 is the block NANP reserves for fiction — the only
 * phone number that belongs in a fixture. Anything else is a real person's line
 * until proven otherwise.
 */
function isFictionalPhone(digits: string): boolean {
  return /^\d{3}55501\d{2}$/.test(digits);
}

/** Item and doc ids are uuids, and a uuid contains digit runs a phone regex bites on. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Walk the parsed JSON's STRING leaves, not the raw file text. A fixture is full
 * of numbers that look like phone numbers to a `\b\d{10}\b` regex — every
 * Firestore `_seconds` epoch is exactly ten digits. Scanning values sidesteps
 * the whole class instead of allowlisting each false positive.
 */
function* stringLeaves(value: unknown, path = ""): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* stringLeaves(v, `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, path ? `${path}.${k}` : k);
  }
}

for (const gitPath of fixtureDirs) {
  for await (const file of walk(`fixtures/${gitPath}`)) {
    if (!file.endsWith(".json")) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(await Deno.readTextFile(file));
    } catch {
      continue; // already reported by the schema pass
    }

    for (const [path, value] of stringLeaves(doc)) {
      if (UUID.test(value)) continue;
      for (const match of value.matchAll(EMAIL)) {
        const domain = match[0].split("@")[1]?.toLowerCase() ?? "";
        if (domain !== ALLOWED_EMAIL_DOMAIN) {
          note(file, `${path}: email address in a fixture — ${match[0]}`);
        }
      }
      for (const match of value.matchAll(PHONE)) {
        const digits = match[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        if (CFS_PHONE_DIGITS.has(digits) || isFictionalPhone(digits)) continue;
        note(
          file,
          `${path}: phone number in a fixture — ${match[0]}. Use the 555-01xx fiction block.`,
        );
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────

if (problems.length) {
  console.error(`lint-fixtures: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error(
    "A fixture must satisfy the same schema the API enforces on save, or an\n" +
      "operator cannot edit it from the manager — they get a 422 listing failures\n" +
      "they did not cause. It must also say why it exists: a fixture set is a\n" +
      "coverage argument, and the sidecar is the only place that can be written.\n" +
      "\n" +
      "And once a family has a baseline on a branch, every fixture needs one:\n" +
      "a fixture with no golden is rendered and then passed informationally, so\n" +
      "it buys no coverage at all. Approving the renders is what clears that.\n",
  );
  Deno.exit(1);
}

const goldenSummary = graduated.length
  ? `goldens at parity (${graduated.join(", ")})`
  : "no graduated golden tree";
console.log(
  `lint-fixtures: ${checked} fixture(s) across ${fixtureDirs.length} family(ies) — ` +
    `schema OK, no PII, ${goldenSummary}.`,
);
