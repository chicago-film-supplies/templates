/**
 * Fixture PII scan over GIT HISTORY — the discharge condition for making this
 * repo public.
 *
 * ## Why this is not `lint-fixtures.ts`
 *
 * `lint-fixtures.ts` answers "is the CURRENT tree clean". Publishing exposes
 * every blob that ever existed, so the question is a different one, and the
 * plan that first asked it tried to reuse the wrong tool:
 *
 *     deno run -A scripts/lint-fixtures.ts /tmp/fx.json    # argument IGNORED
 *
 * That script reads no argv, so the loop re-linted the working tree once per
 * blob and printed a clean line 72 times having opened no history at all.
 * `lint-fixtures.ts` now REFUSES arguments so that mistake is loud; this script
 * is the thing it should have been.
 *
 * ## Why the checks are WIDER than the lint's
 *
 * ⚠️ The lint's PII pass sees exactly two things: an email at a foreign domain,
 * and a US phone number. The values that actually needed adjudicating before
 * publishing were **company names and street addresses** — neither is an email
 * or a phone, so the lint was structurally incapable of flagging them. A clean
 * run of it says nothing about that class, and reading it as reassurance is how
 * an irreversible disclosure gets waved through.
 *
 * So this asks the question the mask makes answerable. `fakeForMask`
 * (api-cloudrun `src/services/templates/fixturePiiStrategy.ts`) emits one of
 * seven known shapes, so a value outside all seven was NEVER masked. That is not
 * automatically a finding — most string leaves are product names, statuses and
 * tax labels that carry no `pii:` tag and should not be masked. It is the
 * candidate set a human has to look at, narrowed from ~15,000 leaves to a
 * readable list.
 *
 * ⚠️ **There IS an unmasked write path**, which is why this matters: `applyPii`
 * runs on CAPTURE, but `saveFixture` validates without it, so a fixture pasted
 * into the manager's editor — or committed straight to git — never meets the
 * mask. "Masking is a mechanism, not a habit" is true of capture only.
 *
 * ⚠️ **Point-in-time.** It reads the objects that exist NOW. New captures add
 * blobs; a clean result says nothing about anything committed after it ran.
 *
 * Run: deno task scan:fixture-history
 */

// Mirrored from api-cloudrun/src/services/templates/fixturePiiStrategy.ts.
// A copy, deliberately: this repo does not import that service, and the lists
// are a frozen fact about blobs already written rather than a live contract.
const FAKE_FIRST = new Set([
  "Jordan", "Riley", "Casey", "Morgan", "Avery", "Quinn", "Reese", "Sage",
  "Rowan", "Drew", "Skyler", "Charlie", "Parker", "Hayden", "Logan", "Taylor",
]);
const FAKE_LAST = new Set([
  "Adler", "Bishop", "Carmichael", "Doyle", "Ellsworth", "Fairfax", "Glenn",
  "Holloway", "Ingram", "Jensen", "Knox", "Larkin", "Maddox", "Norris", "Owen", "Pierce",
]);
const FAKE_STREETS = [
  "Maple Ave", "Elm Ln", "Cedar Rd", "Oak St", "Birch Way", "Pine Ct",
  "Walnut Blvd", "Aspen Dr", "Sycamore Pl", "Cypress Ter", "Chestnut St",
  "Spruce Ln", "Magnolia Rd", "Willow Way", "Juniper Ct", "Linden Ave",
];
const FAKE_CITIES = new Set([
  "Lincoln Park", "Forest Glen", "River Bend", "Lakeview", "Hillcrest",
  "Westmont", "Northbrook", "Eastvale", "Southfield", "Glenwood",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}|\b\d{10}\b/g;
const ALLOWED_EMAIL_DOMAIN = "chicagofilmsupplies.com";
const CFS_PHONE_DIGITS = "3128183008";

/** Could `fakeForMask` have produced this? One of its seven output shapes. */
function isMaskShaped(v: string): boolean {
  if (/^masked_[0-9a-f]{4}@chicagofilmsupplies\.com$/.test(v)) return true;
  if (/^\(\d{3}\) 555-01\d{2}$/.test(v)) return true;
  if (/^6\d{4}$/.test(v)) return true;
  if (FAKE_STREETS.some((s) => new RegExp(`^\\d{3,4} ${s}$`).test(v))) return true;
  if (/^Sample text for /.test(v)) return true;
  if (FAKE_CITIES.has(v)) return true;
  const t = v.trim().split(/\s+/);
  if (t.length === 2 && FAKE_FIRST.has(t[0]) && FAKE_LAST.has(t[1])) return true;
  if (t.length === 3 && FAKE_FIRST.has(t[0]) && /^[A-Z]$/.test(t[1]) && FAKE_LAST.has(t[2])) return true;
  return false;
}

/** Hard PII: what the lint checks, PLUS street addresses, which it cannot see. */
function hardPii(v: string): string | null {
  if (v.length > 120) return null;
  if (/^\d+\s+[A-Z]/.test(v) && /\b(St|Ave|Dr|Rd|Blvd|Ln|Ct|Way|Pl|Ter|Pkwy|Hwy|Cir)\b\.?/i.test(v)) {
    return "street-address";
  }
  for (const m of v.matchAll(EMAIL)) {
    if ((m[0].split("@")[1] ?? "").toLowerCase() !== ALLOWED_EMAIL_DOMAIN) return "email";
  }
  for (const m of v.matchAll(PHONE)) {
    const d = m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (d === CFS_PHONE_DIGITS || /^\d{3}55501\d{2}$/.test(d)) continue;
    return "phone";
  }
  return null;
}

function* leaves(v: unknown, path = ""): Generator<[string, string]> {
  if (typeof v === "string") yield [path, v];
  else if (Array.isArray(v)) for (const [i, x] of v.entries()) yield* leaves(x, `${path}[${i}]`);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) yield* leaves(x, path ? `${path}.${k}` : k);
  }
}

async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

const listing = await git("rev-list", "--objects", "--all", "--", "fixtures/");
const shas = [
  ...new Set(
    listing.split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length > 1 && p[1].endsWith(".json"))
      .map((p) => p[0]),
  ),
].sort();

// Non-vacuity. An empty object list is a broken scan, not a clean repo — the
// exact failure this script exists because of.
if (shas.length === 0) {
  console.error("scan-fixture-history: found NO fixture blobs in history — the scan is broken, not clean.");
  Deno.exit(1);
}

interface Hit { kind: string; paths: Set<string>; blobs: Set<string> }
const hard = new Map<string, Hit>();
const candidates = new Map<string, Set<string>>();
let parsed = 0, unparseable = 0, leafCount = 0;

for (const sha of shas) {
  let doc: unknown;
  try {
    doc = JSON.parse(await git("cat-file", "-p", sha));
    parsed++;
  } catch {
    unparseable++;
    continue;
  }
  for (const [path, value] of leaves(doc)) {
    leafCount++;
    if (UUID.test(value)) continue;
    const kind = hardPii(value);
    if (kind && !isMaskShaped(value)) {
      const e = hard.get(value) ?? { kind, paths: new Set(), blobs: new Set() };
      e.paths.add(path);
      e.blobs.add(sha.slice(0, 8));
      hard.set(value, e);
    }
    // Identity-shaped free text on a field whose NAME suggests a person or an
    // organization. Narrower than "every Title Case string" on purpose: without
    // the path filter this drowns in product names ("Apple Box Set").
    if (
      !isMaskShaped(value) &&
      /\b(name|contact|company|organization|customer|attention)\b/i.test(path) &&
      /^[A-Z][a-z]+(?: [A-Z][a-z']+){1,3}$/.test(value)
    ) {
      const s = candidates.get(value) ?? new Set();
      s.add(path);
      candidates.set(value, s);
    }
  }
}

console.log(
  `scan-fixture-history: ${parsed} blob(s) parsed` +
    `${unparseable ? `, ${unparseable} unparseable` : ""}, ${leafCount} string leaves.\n`,
);

console.log(`── Hard PII not produced by the mask: ${hard.size} ──`);
for (const [v, e] of [...hard].sort()) {
  console.log(`  [${e.kind}] ${JSON.stringify(v)}`);
  console.log(`      ${[...e.paths].slice(0, 3).join(", ")}${e.paths.size > 3 ? ` (+${e.paths.size - 3} more)` : ""}`);
  console.log(`      ${e.blobs.size} blob(s): ${[...e.blobs].slice(0, 5).join(", ")}${e.blobs.size > 5 ? " …" : ""}`);
}
if (!hard.size) console.log("  (none)");

console.log(`\n── Identity-shaped values on name/contact fields, not mask output: ${candidates.size} ──`);
for (const [v, paths] of [...candidates].sort()) {
  console.log(`  ${JSON.stringify(v)}  ←  ${[...paths].slice(0, 3).join(", ")}${paths.size > 3 ? ` (+${paths.size - 3})` : ""}`);
}
if (!candidates.size) console.log("  (none)");

console.log(
  `\n⚠️  Neither list is automatically a finding, and neither is automatically clean.\n` +
    `   A real value here may be CFS's own address, a public venue, or an invented\n` +
    `   fixture — check each against the live corpus before treating it as a leak,\n` +
    `   and before treating it as safe. This scan NARROWS the question; it does not\n` +
    `   answer it, and it deliberately exits 0 either way so nobody reads a green\n` +
    `   exit code as permission to publish.`,
);
