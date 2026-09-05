/**
 * The templates arm of the cross-repo money ratchet.
 *
 * Extracted from `.github/workflows/money-lint.yml`'s heredoc so the two
 * DIRECTIONS of the ratchet can be separate jobs without a second copy of the
 * scanner. See "Two jobs, one scanner" at the bottom of this docblock.
 *
 * `it.currency` was the raw currency.js library, injected into every render
 * context. That made a template an **unguarded money surface**:
 * `it.currency(x).divide(y)` was a real, working call, it made a silent
 * rounding decision, and no ratchet in api-cloudrun or core could see it —
 * template content is canonical here, in git, not there.
 *
 * ## Rule 1 — the `it.currency` budget is ZERO
 *
 * It used to be a budget rather than a ban because `it.currency` could not be
 * withdrawn: the replacement is `it.money.formatCents`, which takes **cents**,
 * while template documents held **dollars** — so every call site would have read
 * `it.money.formatCents(it.money.toCents(x))`, worse than what it replaced.
 *
 * That dissolved when documents became cents-denominated. All 19 `quote.eta`
 * call sites are `it.money.formatCents` and the budget map is empty, so this is
 * the ban the heading always promised — any `it.currency` reference, anywhere,
 * fails.
 *
 * ## Rule 2 — no non-closed operation, anywhere, ever
 *
 * Money arithmetic is closed or it is not. `.add`/`.subtract` are closed — the
 * result is representable at the quantum, so no rounding decision exists.
 * `.divide` and a fractional `.multiply` are not: currency.js quantizes every
 * intermediate at its `precision` and supplies a rounding policy nothing states.
 * Measured against an exact BigInt reference over 200,000 lines, the
 * precomputed-factor form was wrong 199,998 times, worst error $32,031.20.
 *
 * A template must never do that arithmetic at all. Money reaches a template
 * already computed, by `@cfs/core/utils/*`, which are swept against exact
 * rational references. There are ZERO such calls today and there is no
 * legitimate reason for one.
 *
 * ## Rule 3 — no RAW arithmetic on a money value either
 *
 * Rules 1 and 2 both key on currency.js: an `it.currency` reference, or a
 * `.divide(`/`.multiply(` method on one. **Neither can see a bare `*` or `/`,**
 * and `quote.eta` computed its entire replacement-cost table that way since
 * before this guard existed — six sites, green the whole time:
 *
 *     if (t.type === "percent") return sum + (unitCost * t.rate / 100);
 *     rSubtotal += unitCost * qty;
 *
 * That is a percentage applied to money in float and accumulated with `+=`, in
 * the one place the header already says must never happen. The guard was not
 * wrong about the rule; it was matching a *library* when the rule is about an
 * *operation*, so the plainest possible spelling walked straight past it. Same
 * shape as api-cloudrun's Ratchet C-vs-F: a guard that matches names cannot see
 * an anonymous expression.
 *
 * It is a **budget, not a ban** — deliberately. The fix is not local:
 * `calculateReplacementTotals` in `@cfs/core` does multiply-then-round while
 * these sites do round-then-multiply, so under integer cents they systematically
 * diverge and the PDF footer can disagree with the order it renders. Closing it
 * needs a stored per-line replacement field or a new core helper —
 * api-cloudrun#450 Phase C3.
 *
 * ## ⭐ Two jobs, one scanner — the ratchet split by DIRECTION
 *
 * A budget ratchet fails in BOTH directions on purpose: raising it hides a
 * regression, and leaving it high after a cleanup throws away what the cleanup
 * won. Both arms are right, and they are **not the same kind of failure**:
 *
 * | direction | job | required | what a red one means |
 * |---|---|---|---|
 * | `over`  | `money-lint`         | ✅ | a REGRESSION — new unguarded arithmetic. Repairable in CodeMirror. |
 * | `under` | `money-lint-ratchet` | advisory | a CLEANUP the budget should record. Repairable only by editing this file. |
 *
 * That split exists because the manager's template editor is a first-class
 * authoring surface with **no GitHub escape** — operators do not all have access
 * to the org. An operator who removes a raw-arithmetic site (the right thing to
 * do) would otherwise get *"budget 2 but only 1 site(s) remain — lower it to 1"*
 * as a **merge-blocking** check they cannot clear from any control they can
 * reach. So the arm only an engineer can clear comes off the merge path, and
 * the ratchet keeps its teeth: the budget still cannot silently stay high,
 * because `money-lint-ratchet` says so on every run.
 *
 * ⚠️ Rules 1 and 2 stay on the REQUIRED job in both directions: Rule 2 has no
 * budget at all, and Rule 1's is empty, so neither has a lowering arm that an
 * operator could trip. The non-vacuity guard stays required too — a scan that
 * silently examines nothing is the one failure that makes every other verdict
 * meaningless.
 *
 * Run: deno task lint:money        (required arm)
 *      deno task lint:money:ratchet (advisory arm)
 */
import { BLAME_FLAG, familiesOfPath, readBlameSet } from "./affectedFamilies.ts";

// ── Arguments ───────────────────────────────────────────────────────

const DIRECTION_FLAG = "--direction=";
const directionArg = Deno.args.find((a) => a.startsWith(DIRECTION_FLAG));
const direction = directionArg?.slice(DIRECTION_FLAG.length) ?? "over";
if (direction !== "over" && direction !== "under") {
  console.error(`money-lint: --direction must be "over" or "under", got ${JSON.stringify(direction)}`);
  Deno.exit(2);
}
const unknownArgs = Deno.args.filter(
  (a) => !a.startsWith(BLAME_FLAG) && !a.startsWith(DIRECTION_FLAG),
);
if (unknownArgs.length > 0) {
  console.error(
    `money-lint: unexpected argument(s) ${unknownArgs.map((a) => JSON.stringify(a)).join(", ")}.\n` +
      `  Usage: money-lint.ts [--direction=over|under] [${BLAME_FLAG}<path>]\n`,
  );
  Deno.exit(2);
}

const blameSet = await readBlameSet(Deno.args);

// ── Budgets ─────────────────────────────────────────────────────────

/**
 * Per-file budget of `it.currency` references.
 *
 * EMPTY. All 19 of `quote.eta`'s `it.currency` cells became
 * `it.money.formatCents`, so Rule 1 is the ban its header promises rather than
 * a grandfathered allowance. A file absent from this map may hold ZERO — which
 * is every file. Re-adding an entry is the deliberate act this guard exists to
 * make visible.
 */
const BUDGET: Record<string, number> = {};

/** Non-closed currency.js operations. Not a budget: zero, permanently. */
const OPEN_OP = /\.(?:divide|multiply|distribute)\(/g;
const CURRENCY = /it\.currency\b/g;

/**
 * Rule 3: raw `*` or `/` with a money-named operand on either side.
 *
 * Keys on the IDENTIFIER carrying the unit, the same way api-cloudrun's Ratchet
 * F does — so it fires where the units are declared in the name and stays
 * silent on `i / 2` or a loop index. `rate` is deliberately NOT a money word: a
 * rate is not an amount.
 */
const RAW_MONEY_ARITH =
  /\b\w*(?:cost|price|total|subtotal|amount|tax)\w*\b\s*[*\/]|[*\/]\s*\b\w*(?:cost|price|total|subtotal|amount|tax)\w*\b/i;

/**
 * Per-file budget of raw money arithmetic. Ratchets down, never up.
 *
 * Six -> three -> two. Three: the replacement-cost GRAND totals stopped being
 * hand-rolled entirely — `it.orders.calculateReplacementTotals` is the real
 * function and the footer now agrees with the stored order by construction
 * instead of by coincidence.
 *
 * Two: the per-UNIT tax column stopped dividing money by hand.
 * `Math.round(lineTaxCents / qty)` is half UP, so it was asymmetric on exactly
 * the negative values that table deliberately admits — `Math.round(-2.5)` is -2
 * where the magnitude-preserving answer is -3. It is now
 * `it.money.roundDivHalfAwayFromZero`, core's own primitive, whose docblock
 * states the property the column needed: `f(-x) === -f(x)`. Worth carrying
 * forward: the site went away because an EXPORTED primitive replaced it, not
 * because it was spelled more cleverly, and that is what the remaining two are
 * waiting on too.
 *
 * What remains is the per-line subtotal and the percent tax arm, which have no
 * exposed helper (`computeItemTaxAmountCents` is denylisted as a building block
 * and there is no stored per-line replacement field), so they are spelled out
 * in core's own order. api-cloudrun#450 Phase C3.
 */
const RAW_BUDGET: Record<string, number> = {
  "templates/quote.eta": 2,
};

// ── Scan ────────────────────────────────────────────────────────────

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile && p.endsWith(".eta")) yield p;
  }
}

const roots: string[] = [];
for (const d of ["templates", "layouts", "partials", "template-components"]) {
  try {
    await Deno.stat(d);
    roots.push(d);
  } catch { /* absent */ }
}

/**
 * Which lines of a source are inside an Eta comment block.
 *
 * ⚠️ **Prose about the rule is not a violation of it, and the previous test
 * could not tell the difference.** It skipped a line STARTING with `//`, `*` or
 * `<%/*` — so the first line of a `<%/* … *\/%>` block was exempt and every
 * continuation line was not. A partial whose docblock explains "money-lint
 * fails CI on `.divide(`/`.multiply(`" therefore reported three non-closed
 * operations in a comment, and a props list reading
 * `numberCell/moneyCell/itemTaxCents/pathKey` reported raw arithmetic. Neither
 * line executes.
 *
 * Comments cannot compute, so exempting them weakens nothing: there is no code
 * to hide in one. Line numbers are preserved (the set is of indices, not a
 * rewritten string) so every finding still points at the line the author reads.
 */
function commentLines(src: string): Set<number> {
  const out = new Set<number>();
  const lines = src.split("\n");
  let inBlock = false;
  lines.forEach((line, i) => {
    let rest = line;
    if (inBlock) {
      out.add(i);
      const close = rest.indexOf("*/");
      if (close === -1) return;
      inBlock = false;
      rest = rest.slice(close + 2);
    }
    // `<%/* … */%>` (Eta) and `/* … */` (inside an eval tag) alike.
    const open = rest.search(/<%\/\*|\/\*/);
    if (open !== -1 && rest.indexOf("*/", open) === -1) {
      inBlock = true;
      out.add(i);
    }
    if (/^\s*(?:\/\/|\*|<%\/\*|<%#)/.test(line)) out.add(i);
  });
  return out;
}

/**
 * Rule 3 keys on a `*` or `/` beside a money-named identifier, which is
 * arithmetic — and a `/` inside a STRING is never arithmetic. Without this,
 * `includeAsync("@partials/shared/totals.eta", …)` reads as `/totals` and
 * counts as a raw money operation, which would mean no shared partial may ever
 * be NAMED for the thing it renders.
 */
const stripStrings = (line: string) =>
  line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

interface Finding {
  /** The file the finding is in — its family is derived from this for blame. */
  file: string;
  text: string;
  /** `over` findings are regressions; `under` findings are unrecorded cleanups. */
  direction: "over" | "under";
}

const findings: Finding[] = [];
const counts = new Map<string, number>();
const rawCounts = new Map<string, number>();
const rawSites: string[] = [];
let files = 0;

for (const root of roots) {
  for await (const file of walk(root)) {
    files++;
    const src = await Deno.readTextFile(file);
    counts.set(file, [...src.matchAll(CURRENCY)].length);
    const comments = commentLines(src);
    let raw = 0;
    src.split("\n").forEach((line, i) => {
      // A comment line is prose about money, not arithmetic on it.
      if (!comments.has(i) && RAW_MONEY_ARITH.test(stripStrings(line))) {
        raw++;
        rawSites.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
      if (comments.has(i)) return;
      for (const m of line.matchAll(OPEN_OP)) {
        findings.push({
          file,
          direction: "over",
          text: `${file}:${i + 1}  non-closed money operation: ${m[0]}\n` +
            `      currency.js quantizes at its precision, so this makes a rounding\n` +
            `      decision nothing states. A template must not compute money at all —\n` +
            `      the value arrives already computed by @cfs/core/utils/*.`,
        });
      }
    });
    rawCounts.set(file, raw);
  }
}

// Rule 1 — over.
for (const [file, n] of [...counts].sort()) {
  const allowed = BUDGET[file] ?? 0;
  if (n > allowed) {
    findings.push({
      file,
      direction: "over",
      text: `${file}  ${n} it.currency references, budget ${allowed}\n` +
        `      it.currency is the RAW library — unguarded, and withdrawn from the render\n` +
        `      context entirely. Use it.money.* for money display.`,
    });
  }
}

// Rule 3 — over.
for (const [file, n] of [...rawCounts].sort()) {
  const allowed = RAW_BUDGET[file] ?? 0;
  if (n > allowed) {
    findings.push({
      file,
      direction: "over",
      text: `${file}  ${n} raw money arithmetic site(s), budget ${allowed}\n` +
        `      A bare \`*\` or \`/\` on a money value. Neither Rule 1 nor Rule 2 can see\n` +
        `      this — they key on currency.js — which is how quote.eta's replacement\n` +
        `      table computed money in float, green, for this guard's whole life.\n` +
        `      A template must not compute money: the value arrives already computed\n` +
        `      by @cfs/core/utils/*, swept against exact rational references.\n` +
        rawSites.filter((x) => x.startsWith(file + ":")).map((x) => `        ${x}`).join("\n"),
    });
  }
}

// Rule 3 — under. The advisory arm: a cleanup the budget has not recorded yet.
for (const [file, allowed] of Object.entries(RAW_BUDGET)) {
  const n = rawCounts.get(file);
  if (n === undefined) {
    findings.push({
      file,
      direction: "under",
      text: `${file}  raw-arithmetic budget ${allowed} but the file does not exist — remove the entry.`,
    });
  } else if (n < allowed) {
    findings.push({
      file,
      direction: "under",
      text: `${file}  raw-arithmetic budget ${allowed} but only ${n} site(s) remain — lower it\n` +
        `      to ${n}, so the ratchet keeps what the cleanup won.\n` +
        `      (Advisory: this arm is deliberately NOT a required check, because the only\n` +
        `      repair is editing scripts/money-lint.ts, which the manager's template editor\n` +
        `      cannot open. Removing a site is the RIGHT thing to do — this is the ratchet\n` +
        `      asking an engineer to bank the win, not a regression.)`,
    });
  }
}

// Rule 1 — under, plus the stale-entry arm. Vacuous while BUDGET is empty, and
// kept on the REQUIRED job precisely because of that: it has no arm an operator
// can trip, so it costs them nothing and it will be there if a budget returns.
for (const [file, allowed] of Object.entries(BUDGET)) {
  const n = counts.get(file);
  if (n === undefined) {
    findings.push({
      file,
      direction: "over",
      text: `${file}  budgeted at ${allowed} but the file does not exist — remove the entry.`,
    });
  } else if (n < allowed) {
    findings.push({
      file,
      direction: "over",
      text: `${file}  budget ${allowed} but only ${n} references remain — lower it to ${n},\n` +
        `      so the ratchet keeps what the cleanup won.`,
    });
  }
}

// ── Report ──────────────────────────────────────────────────────────

// Non-vacuity. Without this a renamed directory or a changed extension would
// leave the guard green over an EMPTY scan. Required arm only — it is a fact
// about the scan, not about a budget, and it must never be advisory.
if (direction === "over" && files === 0) {
  console.error("money-lint: found no .eta files at all — the scan is broken, not clean.");
  Deno.exit(1);
}

const mine = findings.filter((f) => f.direction === direction);

/**
 * Blame, for the required arm only.
 *
 * ⚠️ A finding in a SHARED file (`layouts/base.eta`, `partials/shared/**`) maps
 * to every family, so it blocks any scoped run. That is the conservative
 * direction and it is correct: the shared overlay ships on every document, so
 * there is no family it is somebody else's problem for.
 *
 * The advisory arm is never scoped — it blocks nothing, so partitioning it
 * would only hide half of a report whose entire purpose is to be read.
 */
const inScope = (f: Finding) => {
  if (blameSet === null) return true;
  const of = familiesOfPath(f.file);
  if (of === "all") return blameSet.size > 0;
  return [...of].some((gp) => blameSet.has(gp));
};

// ⚠️ **The advisory arm still EXITS 1.** "Advisory" is a property of branch
// protection — `money-lint-ratchet` is not in `required_status_checks` — not a
// property of the exit code. An arm that exited 0 on a finding would render
// GREEN, and a ratchet nobody can see is not a ratchet: the whole reason this
// direction was split off rather than deleted is that the budget must not be
// allowed to silently stay high. Red-but-not-blocking is exactly the state
// being aimed at.
const failing = direction === "under" ? mine : mine.filter(inScope);
const notices = direction === "under" ? [] : mine.filter((f) => !inScope(f));

if (notices.length) {
  console.log(
    `money-lint: ${notices.length} finding(s) outside this change's blame scope — ` +
      `reported, not blocking. They are red on \`main\`:\n`,
  );
  for (const f of notices) console.log("  " + f.text + "\n");
}

if (failing.length) {
  console.error(
    direction === "under"
      ? `money-lint-ratchet: ${failing.length} budget(s) higher than the code.\n\n` +
        `  ⚠️ This job is ADVISORY — it is deliberately not a required status check,\n` +
        `  so it does not block the merge. Nothing here is a regression: a site went\n` +
        `  away, which is the right thing to have happened. The repair is lowering a\n` +
        `  budget in scripts/money-lint.ts, which the manager's template editor cannot\n` +
        `  open — which is precisely why this arm is off the merge path.\n`
      : `money-lint failed:\n`,
  );
  for (const f of failing) console.error("  " + f.text + "\n");
  Deno.exit(1);
}

console.log(
  direction === "under"
    ? `money-lint-ratchet: ${files} .eta files, every budget matches the code.`
    : `money-lint: ${files} .eta files, no unguarded money arithmetic` +
      `${notices.length ? ` (${notices.length} out-of-scope finding(s) reported above)` : ""}.`,
);
