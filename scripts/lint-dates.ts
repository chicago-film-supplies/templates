/**
 * Every date-fns call in a template must name the CHICAGO timezone.
 *
 * ## The defect this exists for, measured
 *
 * `it.dateFns.format(d, p, { in: CHICAGO })` pins the FORMAT and leaves the
 * PARSE resolving against whatever zone the process happens to be in. That is
 * not a latent risk: the render container sets no `TZ` — neither the
 * `api-cloudrun` Dockerfile nor `infra/cloud-run-api.tf` — so production is UTC,
 * and a date string carrying no offset lands on the PREVIOUS Chicago day.
 *
 * Measured on one string, three container zones:
 *
 *     TZ=UTC              2026-09-01  ->  August 31, 2026
 *     TZ=America/Chicago  2026-09-01  ->  September 1, 2026
 *     TZ=Asia/Tokyo       2026-09-01  ->  August 31, 2026
 *     any of the three    2026-09-07T00:00:00.000-05:00  ->  September 7, 2026
 *
 * A customer statement printed its period start a day early in production for
 * exactly this reason, in two places on the page.
 *
 * ## 🔴 Why a LINT and not a code review
 *
 * **Every local check is green when this is wrong.** `deno task preview` runs on
 * a Chicago laptop, where the unpinned parse is accidentally correct; the golden
 * gate freezes whatever production renders, so once a wrong render is blessed the
 * gate DEFENDS it. The only thing that surfaced the original defect was two
 * environments disagreeing by accident.
 *
 * ⚠️ **The offset-bearing form is immune, which is what makes this so quiet.**
 * Every date that reaches a template from Firestore carries `-05:00`/`-06:00`, so
 * an unpinned call is correct on every document anyone tests with. It only bites
 * on a value that skipped the storage contract — and the reports routes typed
 * their date params as a bare `z.string()`, so one did. A guard that only fires
 * on the rare input is precisely the guard a human review cannot be.
 *
 * ⭐ This is the same argument `money-lint.ts` makes for its own existence, and
 * it is the reason that file's Rule 3 was added after six sites sat green:
 * template content is canonical in THIS repo, so no ratchet in `api-cloudrun` or
 * `core` can see any of it.
 *
 * ## The rule
 *
 * Any `.dateFns.parseISO(` or `.dateFns.format(` call, in any `.eta` under
 * `templates/`, `layouts/`, `partials/` or `template-components/`, must pass a
 * `{ in: … }` context. Comments are exempt (see `commentLines`), which is not a
 * loophole: a comment cannot compute, and the templates that explain this defect
 * necessarily spell it.
 *
 * ⚠️ **Matched on `.dateFns.` specifically**, so `it.money.formatCents(...)`,
 * `it.dates.formatChargeDays(...)` and `formatStatementAddress(...)` are not
 * swept up by a bare `format(`. A lint that cried wolf on the money formatter
 * would be turned off within a week.
 *
 * ## What it deliberately does NOT check
 *
 * That the zone named is Chicago. `{ in: CHICAGO }` is what every call site
 * writes, but the binding is the template's own (`const CHICAGO =
 * it.tz("America/Chicago")`), and chasing an identifier to its declaration is a
 * parser's job, not a scanner's. The failure this guards is an OMISSION, and
 * omission is what it detects; a deliberately wrong zone is a different and much
 * louder mistake.
 *
 * ## ⚠️ The oracle, once every call site has been converted
 *
 * The rule above only ever fires on `it.dateFns.*`, and as of 2026-09-08 the
 * corpus contains **none** — all 21 call sites now go through
 * `it.dates.formatChicago*` (`@cfs/core/utils/dates`), which pins both halves
 * for them. A scanner whose subject has emptied prints `0 … all pinned`, and
 * this repo has a standing rule that reads that as a finding rather than a pass.
 *
 * 🔴 **So the success line counts BOTH populations, and zero of both is a
 * FAILURE.** Every family prints dates, so a run that can see neither the old
 * form nor the new one is not looking at the templates — a moved directory, a
 * renamed namespace, a `walkEta` that stopped matching. Counting only the
 * converted form would be the same trap one step later; counting both is what
 * keeps this reachable in either direction, including a partial revert.
 *
 * Run: deno task lint:dates
 */
import { callArgs, commentLines, etaRoots, walkEta } from "./_etaScan.ts";

/** The two date-fns entry points that resolve a zone. */
const ZONE_SENSITIVE = /\.dateFns\.(parseISO|format)\s*\(/g;

/**
 * The converted form — `it.dates.formatChicagoDate` and its three siblings.
 *
 * ⚠️ **Matched on `formatChicago` rather than on the whole namespace.**
 * `it.dates` also carries `formatChargeDays`, which resolves no zone and is no
 * evidence of anything this lint is about; a bare `.dates.format` would count it
 * and make the oracle look reachable on a page with no date on it.
 */
const CHICAGO_HELPER = /\.dates\.formatChicago[A-Za-z]*\s*\(/g;

/**
 * How many converted call sites a source holds, comments excluded.
 *
 * Exported for the test, which must not touch the disk — the same contract
 * {@link scanSource} has, and for the same reason.
 */
export function countHelperCalls(src: string): number {
  const comments = commentLines(src);
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  let n = 0;
  CHICAGO_HELPER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHICAGO_HELPER.exec(src)) !== null) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= m.index) lo = mid;
      else hi = mid - 1;
    }
    if (!comments.has(lo)) n++;
  }
  return n;
}

interface Finding {
  file: string;
  line: number;
  fn: string;
  text: string;
}

/** Scan one source. Exported for the test, which must not touch the disk. */
export function scanSource(file: string, src: string): Finding[] {
  const comments = commentLines(src);
  // Precomputed so a match offset maps to a line without rescanning the string
  // for every hit — the corpus is small, but a lint that is slow gets run less.
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const out: Finding[] = [];
  ZONE_SENSITIVE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ZONE_SENSITIVE.exec(src)) !== null) {
    const line = lineOf(m.index);
    if (comments.has(line)) continue;
    const open = m.index + m[0].length - 1;
    const args = callArgs(src, open);
    // `null` is an unbalanced call, which cannot compile — the Eta save gate
    // refuses it long before this lint runs, so treating it as a finding would
    // report a file that can never reach `main`.
    if (args === null) continue;
    if (/\{\s*in\s*:/.test(args)) continue;
    out.push({
      file,
      line: line + 1,
      fn: m[1],
      text: src.slice(lineStarts[line], lineStarts[line + 1] ?? src.length).trim(),
    });
  }
  return out;
}

if (import.meta.main) {
  if (Deno.args.length > 0) {
    console.error(
      `lint-dates: takes no arguments, got ${Deno.args.map((a) => JSON.stringify(a)).join(", ")}.\n` +
        `  It scans the whole tree, always — see lint-fixtures.ts on why a\n` +
        `  changed-files-scoped SCAN is the wrong shape for a guard like this.`,
    );
    Deno.exit(2);
  }

  const findings: Finding[] = [];
  let files = 0;
  let calls = 0;
  let helpers = 0;
  for (const root of await etaRoots()) {
    for await (const file of walkEta(root)) {
      files++;
      const src = await Deno.readTextFile(file);
      calls += (src.match(ZONE_SENSITIVE) ?? []).length;
      helpers += countHelperCalls(src);
      findings.push(...scanSource(file, src));
    }
  }

  if (findings.length > 0) {
    console.error(
      `lint-dates: ${findings.length} date-fns call(s) do not name a timezone.\n\n` +
        `  Pass \`{ in: CHICAGO }\` to the PARSE as well as the FORMAT. Pinning only\n` +
        `  the format leaves the parse resolving against the container zone, which\n` +
        `  in production is UTC — a date with no offset then prints the PREVIOUS\n` +
        `  Chicago day, and every local check stays green because a Chicago laptop\n` +
        `  gets the right answer by accident.\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  unpinned ${f.fn}(`);
      console.error(`     ${f.text}`);
    }
    Deno.exit(1);
  }

  // ⭐ The COUNTS are load-bearing, not decoration. A scan that silently
  // matched nothing — a moved directory, a renamed namespace — would print the
  // same success line as a clean corpus, and "0 checked" is a finding rather
  // than a pass. Same rule `lint:deployed-enums` is read by.
  //
  // 🔴 Which is why zero of BOTH forms is an error rather than a quiet zero.
  // The `it.dateFns` form is now legitimately 0 — every call site goes through
  // `it.dates.formatChicago*` — so `calls` alone can no longer tell a clean
  // corpus from an unread one. Every family prints dates; a run that sees
  // neither form is not looking at the templates.
  if (calls === 0 && helpers === 0) {
    console.error(
      `lint-dates: read ${files} .eta file(s) and found NO date formatting of either form.\n\n` +
        `  That is not a clean corpus, it is an unreachable oracle: every family\n` +
        `  prints dates. Check that etaRoots() still names the template directories\n` +
        `  and that the helper namespace is still it.dates.\n`,
    );
    Deno.exit(1);
  }

  console.log(
    `lint-dates: ${calls} zone-sensitive call(s) and ${helpers} it.dates.formatChicago* ` +
      `call(s) across ${files} .eta file(s), all pinned.`,
  );
}
