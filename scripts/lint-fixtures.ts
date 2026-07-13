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
 * Two checks, and both scan the WHOLE tree rather than the PR's changed files:
 * a `@cfs/core` bump or a `collection_source` flip changes no fixture file, and
 * that is exactly the drift this exists to catch.
 *
 *   1. SCHEMA — every `fixtures/<git_path>/*.json` parses against
 *      `schemas[<collection_source>]`, read from the family's sidecar. This is
 *      the same schema `saveFixture` enforces with, so what passes here can be
 *      saved from the manager.
 *
 *   2. PII — no customer emails or phone numbers in fixture JSON. `saveFixture`
 *      validates but never calls `applyPii`, so the manager's fixture editor is
 *      an unsanitized write path into git; the capture flow sanitizes, a paste
 *      into the textarea does not.
 *
 * Fails CLOSED: a fixtures dir with no sidecar, a sidecar with no
 * `collection_source`, an unmapped collection, or sidecar/file drift are all
 * errors. An unknown key in `schemas` yields `undefined` and would otherwise
 * throw a bare TypeError on `.safeParse`.
 *
 * Run: deno task lint:fixtures
 */
import { schemas } from "@cfs/core/schemas";

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

  const schema = schemas[collection];
  if (!schema) {
    note(
      sidecarPath,
      `collection_source "${collection}" has no entry in @cfs/core's \`schemas\` registry`,
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
      "they did not cause.\n",
  );
  Deno.exit(1);
}

console.log(`lint-fixtures: ${checked} fixture(s) across ${fixtureDirs.length} family(ies) — schema OK, no PII.`);
