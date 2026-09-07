/**
 * The lockfile-desync guard (`scripts/check-lockfile-sync.ts`), templates#230.
 *
 * Three jobs, and the middle one is why this is a test file rather than a grep:
 *
 * 1. **The live ratchet** — THIS repo's actual `deno.json` and `deno.lock`
 *    agree. That is the value assertion; without it the rest tests a function
 *    no tree is measured by.
 * 2. **The ORACLE, on synthetic pairs, in both polarities.** 🔴 Deno NORMALIZES
 *    a range when it writes the lockfile, so the obvious `!==` comparison —
 *    which manager's npm-shaped guard can safely use — reports failures on a
 *    corpus that is right. A guard that cries wolf gets merged past, and this
 *    repo has the receipts: eight consecutive pin bumps merged with
 *    `templates-lint` RED (templates#243). The false-positive arm is not a
 *    nicety.
 * 3. **The wiring** — `.github/workflows/templates-lint.yml` actually runs it,
 *    with `--no-lock`, as a bare `deno run`, and FIRST.
 *
 * ⚠️ (1) alone passes vacuously if the checker stops checking; (2) alone passes
 * while no tree is ever measured; (3) alone passes while the guard is wrong.
 * None of the three is the guard on its own.
 *
 * ⭐ **This file never reads the real `deno.lock` except in arm (1)**, and that
 * is deliberate. Every other Deno invocation in this repo rewrites the lock as a
 * side effect of resolving the import map — including the `deno test` that runs
 * this file — so a synthetic pair is the only corpus a test here can hold still.
 */
import { assert, assertEquals } from "@std/assert";
import {
  canonical,
  type DenoConfig,
  type DenoLock,
  findProblems,
  parseImport,
} from "./check-lockfile-sync.ts";

const REPO = new URL("../", import.meta.url);
const readJson = (f: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(f, REPO)));

/** A minimal in-sync pair, in the shape Deno actually writes for this repo. */
function pair(
  overrides: { imports?: Record<string, string>; lock?: Partial<DenoLock> } =
    {},
) {
  const config: DenoConfig = {
    imports: {
      "@cfs/core/schemas": "jsr:@cfs/core@10.0.0-beta.362/schemas",
      "@cfs/core/utils/orders": "jsr:@cfs/core@10.0.0-beta.362/utils/orders",
      "@bgub/eta": "jsr:@bgub/eta@^4.6.0",
      "date-fns": "npm:date-fns@^4.4.0",
      ...overrides.imports,
    },
  };
  const lock: DenoLock = {
    version: "5",
    specifiers: {
      "jsr:@cfs/core@10.0.0-beta.362": "10.0.0-beta.362",
      "jsr:@bgub/eta@^4.6.0": "4.6.0",
      "npm:date-fns@^4.4.0": "4.4.0",
    },
    workspace: {
      dependencies: [
        "jsr:@cfs/core@10.0.0-beta.362",
        "jsr:@bgub/eta@^4.6.0",
        "npm:date-fns@^4.4.0",
      ],
    },
    ...overrides.lock,
  };
  return { config, lock };
}

Deno.test("lockfileSync - THIS repo's deno.json and deno.lock agree", () => {
  // The ratchet, and the only arm that reads the real files. A `@cfs/core` pin
  // bumped without a `deno install` fails here rather than living on in a lock
  // that `lint:fixtures` and `lint:deployed-enums` keep resolving core from.
  const problems = findProblems(readJson("deno.json"), readJson("deno.lock"));
  assertEquals(problems, []);
});

Deno.test("lockfileSync - templates#243's shape: a pin bumped without an install", () => {
  // The incident this exists for. `deno.json` moved to a new beta, `deno.lock`
  // still resolves the old one, and every other guard is green because they all
  // read the LOCK.
  const { config, lock } = pair({
    imports: { "@cfs/core/schemas": "jsr:@cfs/core@10.0.0-beta.363/schemas" },
  });
  const problems = findProblems(config, lock);

  // ⚠️ Assert BOTH arms fire, not merely that something did. Arm 1 compares two
  // statements of intent; arm 2 reads what was actually resolved. A change that
  // silenced arm 2 while arm 1 still spoke would look identical here if this
  // only counted problems.
  assert(
    problems.some((p) => p.includes('wants "10.0.0-beta.363"')),
    `arm 1 (intent) did not fire: ${JSON.stringify(problems)}`,
  );
  assert(
    problems.some((p) => p.includes("does not satisfy")),
    `arm 2 (resolution) did not fire: ${JSON.stringify(problems)}`,
  );
});

Deno.test("lockfileSync - the @cfs/core subpath imports are ONE dependency", () => {
  // ⚠️ The set must agree with ITSELF, never with a count. The workspace
  // CLAUDE.md records that line going stale twice by being counted, and the
  // api-cloudrun original's own docblock once said "the 8 subpath imports" —
  // a figure carried from THIS repo into one that had 37.
  const imports: Record<string, string> = {};
  for (
    const sub of [
      "schemas",
      "utils/orders",
      "utils/templates",
      "utils/dates",
      "utils/money",
    ]
  ) {
    imports[`@cfs/core/${sub}`] = `jsr:@cfs/core@10.0.0-beta.362/${sub}`;
  }
  const { config, lock } = pair({ imports });
  assertEquals(findProblems(config, lock), []);

  const specs = new Set(
    Object.values(config.imports!).map((v) => parseImport(v)?.spec),
  );
  // One entry per PACKAGE — asserted against the lock's own direct set, which is
  // the thing that has to agree, rather than against a number written here.
  assertEquals(
    [...specs].filter((s) => s?.startsWith("jsr:@cfs/core")).length,
    lock.workspace!.dependencies!.filter((d) => d.startsWith("jsr:@cfs/core"))
      .length,
  );
});

Deno.test("lockfileSync - a REMOVED import is caught (the direction one arm misses)", () => {
  // deno.json dropped a dependency, deno.lock still lists it as direct. A
  // one-directional membership check passes this.
  const { config, lock } = pair();
  delete config.imports!["date-fns"];
  const problems = findProblems(config, lock);
  assert(
    problems.some((p) =>
      p.includes("npm:date-fns") && p.includes("not in deno.json")
    ),
    `the removal direction did not fire: ${JSON.stringify(problems)}`,
  );
});

Deno.test("lockfileSync - an ADDED import with no install is caught", () => {
  // The shape this very change had before its own `deno install` — measured
  // 2026-09-07 while wiring the guard in, which is how the red polarity here is
  // known to be reachable rather than merely constructed.
  const { config, lock } = pair({
    imports: { "@std/semver": "jsr:@std/semver@^1.0.8" },
  });
  const problems = findProblems(config, lock);
  assert(
    problems.some((p) =>
      p.includes("@std/semver") && p.includes("missing from deno.lock")
    ),
    `the addition direction did not fire: ${JSON.stringify(problems)}`,
  );
});

Deno.test("lockfileSync - Deno's range NORMALIZATION is not a desync", () => {
  // 🔴 The false-positive arm, and the reason the comparison is semantic rather
  // than `!==`. These five rows are measured on api-cloudrun's own correct,
  // `--frozen`-passing corpus (2026-09-06). This repo's four direct deps happen
  // to round-trip verbatim today, so its live corpus cannot exercise this — the
  // arm has to be synthetic or it is not an arm at all.
  const rows: Array<[string, string]> = [
    ["^0.2", "0.2"],
    ["^8.0.0", "8"],
    ["^0.8.3", "~0.8.3"],
    ["^0.4.1", "~0.4.1"],
    ["^0.11.11", "~0.11.11"],
  ];
  for (const [declared, locked] of rows) {
    assertEquals(
      canonical(declared),
      canonical(locked),
      `"${declared}" and "${locked}" are one requirement; a !== guard fails here`,
    );
  }

  const config: DenoConfig = { imports: { "fast-png": "npm:fast-png@^8.0.0" } };
  const lock: DenoLock = {
    version: "5",
    specifiers: { "npm:fast-png@8": "8.0.2" },
    workspace: { dependencies: ["npm:fast-png@8"] },
  };
  assertEquals(findProblems(config, lock), []);
});

Deno.test("lockfileSync - a GENUINE range change is still caught", () => {
  // The other half of the arm above: tolerating normalization must not tolerate
  // a real widening. `^4.12.32` → `^4.12.0` is one `--frozen` DOES reject.
  const config: DenoConfig = { imports: { "hono": "npm:hono@^4.12.0" } };
  const lock: DenoLock = {
    version: "5",
    specifiers: { "npm:hono@^4.12.32": "4.12.32" },
    workspace: { dependencies: ["npm:hono@^4.12.32"] },
  };
  assert(
    findProblems(config, lock).length > 0,
    "a widened range compared equal",
  );
});

Deno.test("lockfileSync - a lockfile whose SHAPE moved REFUSES, it does not pass", () => {
  // ⚠️ The vacuous pass this guard could most easily become. A lockfile version
  // bump that renames `workspace.dependencies` would leave every arm iterating
  // an empty object and reporting clean.
  const { config } = pair();
  const problems = findProblems(config, { version: "6", specifiers: {} });
  assert(
    problems.some((p) => p.includes("workspace.dependencies")),
    `a moved lockfile format reported clean: ${JSON.stringify(problems)}`,
  );

  // And the mirror: an empty `imports` is this guard reading the wrong file.
  assert(findProblems({ imports: {} }, pair().lock).length > 0);
});

Deno.test("lockfileSync - parseImport collapses subpaths and keeps scopes", () => {
  assertEquals(
    parseImport("jsr:@cfs/core@10.0.0-beta.362/utils/orders")?.spec,
    "jsr:@cfs/core@10.0.0-beta.362",
  );
  assertEquals(
    parseImport("npm:@date-fns/tz@^1.5.0")?.name,
    "npm:@date-fns/tz",
  );
  assertEquals(parseImport("npm:date-fns@^4.4.0")?.range, "^4.4.0");
  assertEquals(parseImport("./scripts/preview.ts"), null);
});

Deno.test("lockfileSync - CI runs it with --no-lock, as a bare `deno run`, and FIRST", () => {
  // 🔴 All three clauses are load-bearing and were measured here on 2026-09-07.
  //
  // `--no-lock`: a plain `deno run` updates `deno.lock` as a side effect of
  // resolving the import map, so the guard rewrites the file it is checking.
  //
  // bare `deno run`: `deno task X` resolves the import map in the LAUNCHER,
  // before X starts, so an inner `--no-lock` is already too late. Wrapped in a
  // task, the guard reported on a corpus the launcher had just repaired.
  //
  // FIRST: that is true of EVERY task, not only this one — a single
  // `deno task lint:citations` was enough to rewrite the lock to a bumped pin,
  // after which the guard reported the `@cfs/core` desync no more.
  const wf = Deno.readTextFileSync(
    new URL(".github/workflows/templates-lint.yml", REPO),
  );
  const code = wf.split("\n").filter((l) => !l.trimStart().startsWith("#"));

  // ⚠️ Match the line that INVOKES it, not one that merely names it.
  const invocation = code.find((l) =>
    /deno run\b/.test(l) && l.includes("check-lockfile-sync.ts")
  );
  assert(
    invocation,
    "templates-lint.yml does not `deno run` scripts/check-lockfile-sync.ts",
  );
  assert(
    invocation.includes("--no-lock"),
    `the workflow runs the guard without --no-lock: ${invocation.trim()}`,
  );

  const body = code.join("\n");
  const guardAt = body.indexOf("check-lockfile-sync.ts");
  const firstTaskAt = body.indexOf("deno task");
  assert(
    firstTaskAt >= 0,
    "no `deno task` step found — this assertion has lost its subject",
  );
  assert(
    guardAt < firstTaskAt,
    "the lockfile guard must run BEFORE the first `deno task`, which syncs the lock",
  );

  // The absence of a task IS the guard — see deno.json's `//lint:lockfile`.
  const tasks = readJson("deno.json").tasks as Record<string, string>;
  const wrapped = Object.entries(tasks).filter(
    ([name, body]) =>
      !name.startsWith("//") && body.includes("check-lockfile-sync.ts"),
  );
  assertEquals(
    wrapped,
    [],
    "a deno task wrapping the guard defeats its --no-lock; deno.json's //lint:lockfile says why",
  );
  assert(
    Object.keys(tasks).includes("//lint:lockfile"),
    "the explainer for that deliberate absence is gone — a future reader will just add the task back",
  );
});
