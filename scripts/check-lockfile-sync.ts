#!/usr/bin/env -S deno run --no-lock --allow-read
/**
 * Refuses a `deno.json` / `deno.lock` disagreement (templates#230).
 *
 * A `@cfs/core` pin bumped in `deno.json` without a matching `deno install`
 * leaves the lockfile resolving the old beta. `deno install --frozen` refuses
 * that outright:
 *
 *   error: The lockfile is out of date. Run `deno install --frozen=false`, or
 *   rerun with `--frozen=false` to update it.
 *   changes:
 *     5 | -    "jsr:@cfs/core@10.0.0-beta.355": "10.0.0-beta.355",
 *
 * 🔴 NOTHING ELSE IN THIS REPO CATCHES IT, and that is the whole reason this
 * file exists. Every other guard here resolves `@cfs/core` from the
 * ALREADY-INSTALLED dependency tree in `DENO_DIR`, which still satisfies the
 * old spec and works perfectly — so `lint:fixtures` validates against the
 * schema build the lock names while the *intent* recorded in `deno.json` says
 * something else, and both are green. templates#243 is the incident: a pin
 * bumped with the lock left behind, merged with all four checks green.
 *
 * ⚠️ **The consequence here is NOT the same as api-cloudrun's, and it is worse
 * in one direction.** There the desync fails loudly at deploy — `Dockerfile`'s
 * `RUN deno install --frozen`. This repo has no build and no deploy: the lock
 * is what `lint:fixtures` and `lint:deployed-enums` resolve core from, so a
 * stale one makes those guards keep answering, correctly, about a version the
 * repo has stopped claiming to use. Nothing ever goes red. The pin is the
 * repository's statement of which core its sidecars are written against, and a
 * lagging lock quietly makes that statement false.
 *
 * ⚠️ **This is a STRUCTURAL check, never a network one.** It resolves no
 * registry, so it costs milliseconds and sits in FRONT of the expensive gates
 * rather than after them. It cannot tell you a published version exists — only
 * that the two files agree about what is wanted, which is precisely the class
 * `--frozen` rejects.
 *
 * ## Provenance — this is a COPY, and deliberately so
 *
 * `api-cloudrun/scripts/check-lockfile-sync.ts` is the original
 * (api-cloudrun#877); this is a copy with a new header and a new
 * `lint:lockfile` wiring. `findProblems` is pure, so the obvious tidy-up is to
 * lift it into `@cfs/core/utils/` and import it in both repos — **do not.**
 * `@cfs/core` reaches `manager` as a browser bundle, so every dependency it
 * declares becomes one of manager's transitive deps, and this file's oracle is
 * `@std/semver`. Shipping a range parser to a browser to spare two repos ~150
 * duplicated lines of build tooling is the `core#87` lesson in reverse: the
 * cheap-looking move is a claim about the call site, and the cost lands in the
 * dependency graph.
 *
 * ⚠️ **So the two copies can drift, and nothing detects that.** If you fix a
 * bug in the oracle, fix it twice. Both repos exercise it on their own
 * synthetic pairs, which is what keeps each copy honest independently.
 *
 * ## The oracle, and why string equality is the WRONG one
 *
 * 🔴 **Deno NORMALIZES a range when it writes the lockfile**, so the two files
 * legitimately hold different TEXT for the same requirement. Measured on
 * api-cloudrun's (correct, `--frozen`-passing) corpus, 2026-09-06:
 *
 * | `deno.json` | `deno.lock` |
 * |---|---|
 * | `npm:akamai-edgeauth@^0.2` | `npm:akamai-edgeauth@0.2` |
 * | `npm:fast-png@^8.0.0` | `npm:fast-png@8` |
 * | `npm:fflate@^0.8.3` | `npm:fflate@~0.8.3` |
 * | `npm:@conventional-commits/parser@^0.4.1` | `npm:@conventional-commits/parser@~0.4.1` |
 * | `npm:@scalar/hono-api-reference@^0.11.11` | `npm:@scalar/hono-api-reference@~0.11.11` |
 *
 * A `!==` comparison — which is what `manager`'s npm-shaped guard can safely
 * use, because npm mirrors the specifier verbatim — reports **five failures on
 * a corpus that is right**. That is not a milder bug than missing a real one: a
 * guard that cries wolf on every push gets ignored, and then it detects nothing
 * at all. This repo has no pre-push hook to `--no-verify`, so the ignoring here
 * takes the shape templates#243 already measured — a red required check merged
 * anyway, eight times running.
 *
 * ⭐ So the comparison is SEMANTIC: `formatRange(parseRange(x))` canonicalizes
 * both sides to comparators (`^0.2` and `0.2` both become `>=0.2.0 <0.3.0`) and
 * those are compared. All five rows above collapse to equal, while a genuine
 * change (`^4.12.32` → `^4.12.0`, which `--frozen` DOES reject) stays unequal.
 *
 * ## The two arms
 *
 * Comparing the two statements of intent is not sufficient on its own, so:
 *
 * 1. **Membership, in BOTH directions.** Every package spec `deno.json` declares
 *    must appear in `deno.lock`'s `workspace.dependencies`, and every entry
 *    there must be declared. A one-directional check passes the REMOVAL case.
 * 2. **The RESOLVED version must satisfy the declared range.** Arm 1 compares
 *    two statements of intent and would still pass if the lock recorded a
 *    resolution meeting neither — the exact thing `--frozen`'s diff shows.
 *
 * ⚠️ **Scope, stated so nobody trusts it further than it goes.** `--frozen` also
 * validates the transitive `jsr`/`npm` blocks and their integrity hashes; this
 * cannot, because reproducing them means resolving. It catches the class where
 * the two files disagree about what is DIRECTLY wanted, which is the class a
 * hand-edited pin produces. It also checks AGREEMENT, not INTENT: it cannot
 * tell you a core version nobody has pinned yet is the one this repo needs.
 *
 * ⚠️ **There is no `version` field to exclude here.** manager's guard skips one
 * because npm mirrors `version` into `packages[""]` and release-please rewrites
 * it every release; Deno's lockfile mirrors no such field, and this repo's
 * `deno.json` has none. Recorded because its absence is a fact about the format,
 * not an omission.
 *
 * ## Rooting
 *
 * Rooted at the `deno.json` beside this script, resolved from the script's own
 * location rather than `Deno.cwd()` — CI and a hand run start from different
 * places.
 *
 * ⚠️ **This is the case where location-derived rooting is CORRECT**, and it is
 * worth saying because it looks like the `manager#385` bug from the
 * `cfs-worktrees` skill — which `scripts/lint-citations.ts` in this very
 * directory has the OTHER half of. That one resolves the WORKSPACE (sibling
 * repos), where a worktree path gives the wrong answer. The question here is
 * "which deno.json/deno.lock pair am I checking", and if this script is running
 * from a `draft/*` worktree, that worktree's pair is exactly the right answer.
 *
 * ## 🔴 It MUST run with `--no-lock`, and this is not a detail
 *
 * **Measured 2026-09-06, while planting the api-cloudrun guard's own red
 * polarity: running it as a plain `deno run` REWROTE the lockfile it was
 * checking.** Deno resolves the import map at startup and updates `deno.lock` as
 * a side effect — and `--allow-read` does not stop it, because that is the
 * runtime's own lockfile maintenance, not the program's I/O.
 *
 * The result is worse than a no-op. With the `@cfs/core` pin bumped to a version
 * that does not exist, Deno wrote a PARTIAL lock — `workspace.dependencies`
 * advanced to the new spec while the `specifiers` it could no longer justify
 * were dropped — so the guard then read a file neither in the old state nor the
 * new one, and reported four unrelated packages as the problem. A guard that
 * mutates its own subject reports on a corpus that no longer exists.
 *
 * ⭐ `--no-lock` is what makes the check an OBSERVATION:
 *
 *   deno run --no-lock --allow-read scripts/check-lockfile-sync.ts
 *
 * ## 🔴 `deno task` DEFEATS that flag, so there is no task for this check
 *
 * **Measured here, 2026-09-07, isolated three ways.** `deno task X` resolves
 * the import map and maintains `deno.lock` in the LAUNCHER, before `X` starts —
 * so the `--no-lock` on the inner `deno run` protects a process that is already
 * too late.
 *
 * | invocation | `deno.lock` |
 * |---|---|
 * | `deno run --no-lock … check-lockfile-sync.ts` | unchanged |
 * | `deno task lint:lockfile` (inner `--no-lock`) | **rewritten** |
 * | `deno task --no-lock lint:lockfile` | unchanged |
 *
 * ⚠️ **And it is not a cosmetic difference — it erases the finding.** With
 * `@cfs/core` pinned back one beta and no `deno install` (templates#243's exact
 * shape), the direct run reported the desync in three lines. Run after a single
 * unrelated `deno task`, the launcher had already rewritten
 * `workspace.dependencies` AND `specifiers` to the new pin, and the `@cfs/core`
 * finding was **gone from the report** — a vacuous pass on the one class this
 * file exists for.
 *
 * ⭐ So the absence of a `deno task lint:lockfile` is itself the guard: a task
 * that does not exist cannot be invoked wrongly. `deno.json`'s `//lint:lockfile`
 * key carries the command instead. (api-cloudrun's copy DOES define a
 * `check-lockfile` task — its own gate is safe because
 * `api-cloudrun/scripts/hooks/pre-push` calls `deno run` directly, but a hand
 * run through that task carries this trap.)
 *
 * ## 🔴 The same fact fixes its CI POSITION — it must run FIRST
 *
 * Every `deno task` syncs the lock, not just this one. Measured: with the pin
 * bumped, one `deno task lint:citations` was enough to repair `deno.lock` in
 * place, after which this guard passed on `@cfs/core`. So in
 * `.github/workflows/templates-lint.yml` this step sits immediately after
 * `setup-deno` and **before** the first `deno task` — not because it is cheap,
 * though it is, but because anywhere later it reports on a corpus an earlier
 * step already repaired.
 *
 * ⚠️ Locally the same thing happens and is benign: any `deno` command syncs the
 * lock, so a desync you introduce by hand tends to self-heal into an uncommitted
 * `deno.lock` change. Commit it. What this guard catches is a desync that was
 * COMMITTED, which is the state a fresh CI checkout restores.
 *
 * Exit: 0 in sync · 1 desynced (or unreadable).
 */
import { formatRange, parse, parseRange, satisfies } from "@std/semver";

/** The shape this guard reads out of `deno.json`. */
export interface DenoConfig {
  imports?: Record<string, string>;
}

/** The shape this guard reads out of `deno.lock`. */
export interface DenoLock {
  version?: string;
  specifiers?: Record<string, string>;
  workspace?: { dependencies?: string[] };
}

/**
 * `jsr:@scope/name@RANGE/subpath` → `{ spec, name, range }`.
 *
 * The subpath is dropped on purpose: every `@cfs/core` subpath import is the SAME
 * dependency and the lockfile records it once. So collapse them by pattern, and
 * **never assert how many there are.**
 *
 * ⚠️ An earlier draft of this comment, in the api-cloudrun original, broke its
 * own rule in the same sentence — it read "the 8 `@cfs/core` subpath imports",
 * a figure carried over from THIS repo, where it was already wrong, into one
 * that had 37. Between 2026-09-05 and 2026-09-06 api-cloudrun's real figure
 * went 35 → 36 → 37 → 38 across three commits in a single day.
 *
 * That churn is the evidence, and it is stated as a closed historical window on
 * purpose: a LEVEL ("this repo has N") is the thing that goes stale, and a
 * comment repeating the defect it documents is worse than one that never
 * mentioned a number. `grep -c 'jsr:@cfs/core@' deno.json` if you ever need it.
 */
export function parseImport(
  value: string,
): { spec: string; name: string; range: string } | null {
  const m = /^(jsr|npm):((?:@[^/@]+\/)?[^@/]+)@([^/]+)/.exec(value);
  if (!m) return null;
  return {
    spec: `${m[1]}:${m[2]}@${m[3]}`,
    name: `${m[1]}:${m[2]}`,
    range: m[3],
  };
}

/**
 * A range reduced to comparators, so two spellings of one requirement compare
 * equal. Returns the raw text prefixed when it will not parse — an unparseable
 * range then compares by string rather than silently equalling everything.
 */
export function canonical(range: string): string {
  try {
    return formatRange(parseRange(range));
  } catch {
    return `raw:${range}`;
  }
}

/**
 * The whole check, pure. Returns every disagreement; an empty array is
 * in-sync. Kept free of I/O so `scripts/check-lockfile-sync.test.ts` can exercise
 * both polarities on synthetic pairs — a guard whose oracle is only ever run
 * against a corpus that happens to be right is not verified.
 */
export function findProblems(config: DenoConfig, lock: DenoLock): string[] {
  const problems: string[] = [];
  const imports = config.imports ?? {};
  const specifiers = lock.specifiers ?? {};
  const workspace = lock.workspace;

  // ⚠️ Assert the SHAPE before reading it. A lockfile version bump that renames
  // or restructures these keys would otherwise leave every arm below iterating
  // an empty object and reporting a clean run — the vacuous pass that makes a
  // guard worse than none.
  if (!workspace || !Array.isArray(workspace.dependencies)) {
    return [
      `deno.lock has no \`workspace.dependencies\` array (lockfile version ` +
      `${
        JSON.stringify(lock.version)
      }; this guard reads v5). The format moved — ` +
      `fix this script rather than deleting the check.`,
    ];
  }
  if (Object.keys(imports).length === 0) {
    return [
      "deno.json declares no `imports` — either the file moved or this guard is " +
      "reading the wrong one. Refusing to report a vacuous pass.",
    ];
  }

  /** Declared package specs, deduplicated across subpath imports. */
  const declared = new Map<string, { name: string; range: string }>();
  for (const [alias, value] of Object.entries(imports)) {
    const parsed = parseImport(value);
    if (!parsed) {
      problems.push(
        `${alias} — "${value}" is not a jsr:/npm: specifier this guard can read`,
      );
      continue;
    }
    declared.set(parsed.spec, { name: parsed.name, range: parsed.range });
  }

  /** Locked DIRECT dependencies, keyed by package name. */
  const locked = new Map<string, { spec: string; range: string }>();
  for (const spec of workspace.dependencies) {
    const parsed = parseImport(spec);
    if (!parsed) {
      problems.push(
        `deno.lock workspace.dependencies holds an unreadable entry: "${spec}"`,
      );
      continue;
    }
    locked.set(parsed.name, { spec, range: parsed.range });
  }

  const declaredNames = new Set([...declared.values()].map((d) => d.name));

  // ── Arm 1: membership + agreement, in BOTH directions ─────────────
  for (const [, { name, range }] of declared) {
    const hit = locked.get(name);
    if (!hit) {
      problems.push(
        `${name} is in deno.json imports but missing from deno.lock`,
      );
    } else if (canonical(hit.range) !== canonical(range)) {
      problems.push(
        `${name} — deno.json wants "${range}", deno.lock records "${hit.range}" ` +
          `(${canonical(range)} vs ${canonical(hit.range)})`,
      );
    } else if (!(hit.spec in specifiers)) {
      problems.push(
        `${hit.spec} is in deno.lock's workspace but has no \`specifiers\` resolution`,
      );
    }
  }
  for (const [name, { spec }] of locked) {
    if (!declaredNames.has(name)) {
      problems.push(
        `${spec} is a direct dependency in deno.lock but not in deno.json imports`,
      );
    }
  }

  // ── Arm 2: the RESOLVED version must satisfy the DECLARED range ────
  // Arm 1 compares two statements of intent; this reads what was actually
  // resolved. ⚠️ An npm resolution can carry a peer suffix
  // (`0.11.11_hono@4.12.32`), which is not part of the version.
  let checked = 0;
  for (const [spec, { name, range }] of declared) {
    const hit = locked.get(name);
    if (!hit) continue;
    const resolved = specifiers[hit.spec];
    if (!resolved) continue; // already reported by arm 1
    const version = resolved.split("_")[0];
    let ok: boolean;
    try {
      ok = satisfies(parse(version), parseRange(range));
    } catch {
      continue; // unparseable either side — arm 1 compared it as raw text
    }
    checked++;
    if (!ok) {
      problems.push(
        `${name} — deno.lock resolved ${version}, which does not satisfy "${range}" (${spec})`,
      );
    }
  }

  // ⚠️ Arm 2 skips anything it cannot parse, so an arm that checked NOTHING
  // would report clean. Assert it reached most of the corpus — the same reason
  // the CLAUDE.md budget ratchet asserts its walker still finds sections.
  if (declared.size > 0 && checked < declared.size * 0.8) {
    problems.push(
      `arm 2 only checked ${checked} of ${declared.size} resolutions — it is skipping ` +
        `most of the corpus, so its silence means nothing`,
    );
  }

  return problems;
}

/** Rooted at this script's own location — see the docblock's *Rooting*. */
export const REPO = new URL("../", import.meta.url);

function read(file: string): Record<string, unknown> {
  try {
    return JSON.parse(Deno.readTextFileSync(new URL(file, REPO)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ lockfile-sync: cannot read ${file} — ${msg}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  const config = read("deno.json") as DenoConfig;
  const lock = read("deno.lock") as DenoLock;
  const problems = findProblems(config, lock);

  if (problems.length > 0) {
    console.error("✗ deno.json and deno.lock are out of sync:\n");
    for (const p of problems) console.error(`    ${p}`);
    console.error(
      "\n  Nothing downstream will go red for you: this repo has no build and no",
    );
    console.error(
      "  deploy, and the other guards keep resolving @cfs/core from the LOCK, so",
    );
    console.error(
      "  they answer correctly about a version deno.json has stopped claiming.",
    );
    console.error(
      "\n  Fix: run `deno install` and commit the updated deno.lock.",
    );
    Deno.exit(1);
  }

  const direct = new Set(
    Object.values(config.imports ?? {}).map((v) => parseImport(v)?.spec).filter(
      Boolean,
    ),
  ).size;
  console.log(
    `lockfile-sync: ${direct} direct dependencies ` +
      `(${
        Object.keys(config.imports ?? {}).length
      } import entries) agree with deno.lock.`,
  );
}
