/**
 * Read-only audit of backticked `path.ext` / `path.ext:N` citations in this
 * repo's prose.
 *
 * (Angle brackets throughout this file mark a PLACEHOLDER rather than a path.
 * The citation regex rejects a leading `<`, so an illustrative example cannot
 * report itself broken from inside the scanned scope.)
 *
 * The RULES live in `@cfs/core/utils/citations` — the same module core,
 * api-cloudrun and manager run. This file is the thin per-repo half:
 * `SCAN_ROOTS`, `OWN_TOP_LEVEL`, `REPOS` and {@link EXEMPT} are facts about
 * `templates` specifically. **A deliberate split, not residual duplication** —
 * what moved is everything that could be wrong identically in two repos,
 * including `classifyCitation`, the branch separating BROKEN from UNVERIFIABLE.
 *
 * ⚠️ **This repo's citation surface is almost entirely CROSS-REPO**, which makes
 * its two runs differ more than anywhere else: `templates` is a thin harness and
 * most of what its prose names lives in api-cloudrun. In CI — where only this
 * repo is checked out — those citations are UNVERIFIABLE rather than broken, so
 * **a green CI run here says very little**. Measured at the gate's landing: 1
 * broken in a full workspace, 0 in a CI checkout. The check earns its keep on a
 * developer's machine and in the PR job below only as a floor.
 *
 * ⚠️ **`.eta` templates are deliberately NOT scanned.** They are rendered
 * output, not instruction — and the two guards that do read them
 * (`.github/workflows/templates-lint.yml`'s PII scan, and
 * `.github/workflows/money-lint.yml`) ask different questions of them.
 *
 * Usage:
 *   deno task lint:citations
 *   deno run --allow-read --allow-env scripts/lint-citations.ts --verbose
 *
 * Exit: 0 clean · 1 error · 2 findings (broken or ambiguous).
 */
import {
  CITATION,
  type CitationVerdict,
  classifyCitation,
  describesDeletion,
  isHistoryDoc,
  preferOwnRepo,
  resolveSpecifier,
} from "@cfs/core/utils/citations";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const WORKSPACE = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const REPOS = ["core", "api-cloudrun", "manager", "templates", "erp-spec", "claude-plugins"];
const SKIP = new Set([
  "node_modules",
  ".git",
  "_dist",
  "dist",
  "coverage",
  // Rendered PNGs and their diffs — captured output, not authored content.
  "goldens",
  "test-results",
  // 🔴 **An agent worktree is a full SECOND COPY of a sibling repo, and this
  // scanner walks all six.** Claude Code puts them at
  // `<repo>/.claude/worktrees/<name>`, so without this every path in that repo
  // gains a duplicate resolution target and citations that resolved fine for
  // months report AMBIGUOUS — which fails `--strict`, which is what CI and the
  // local gate run. **It breaks for citations nobody touched**, in files nobody
  // edited: measured 2026-09-04, one worktree in `api-cloudrun` made five
  // citations here ambiguous, in `CLAUDE.md`, `README.md` and `scripts/preview.ts`.
  //
  // api-cloudrun's own scanner was repaired for exactly this (`43162a93`, after
  // 1,110 false AMBIGUOUS blocked every session sharing that checkout). This
  // scanner has the same hole because it is a different implementation of the
  // same walk — and it is worse here, because this repo's citations point almost
  // entirely AT the sibling repos where the worktrees live.
  //
  // ⚠️ The fix belongs in the WALK, not in the tool that trips over it: a
  // worktree there is legitimate and is where the harness puts them.
  "worktrees",
]);

const verbose = Deno.args.includes("--verbose");
const argFiles = Deno.args.filter((a) => !a.startsWith("--"));

const byBasename = new Map<string, string[]>();
const allPaths: string[] = [];
const presentRepos = new Set<string>();

/**
 * ⚠️ **The try MUST wrap the ITERATION, not the `Deno.readDir` call** — it
 * returns an async iterable and defers `NotFound` to the first `next()`, so a
 * try around the call alone catches nothing and the error escapes as an
 * unhandled rejection. api-cloudrun's runner was written that way until
 * 2026-08-23 and would have crashed on its first CI run, where five of the six
 * repos are absent by construction.
 */
async function index(dir: string): Promise<boolean> {
  try {
    for await (const e of Deno.readDir(dir)) {
      if (SKIP.has(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await index(p);
      else if (e.isFile) {
        byBasename.set(e.name, [...(byBasename.get(e.name) ?? []), p]);
        allPaths.push(p);
      }
    }
  } catch {
    return false;
  }
  return true;
}
for (const r of REPOS) {
  if (await index(`${WORKSPACE}/${r}`)) presentRepos.add(r);
}
const absentRepos = REPOS.filter((r) => !presentRepos.has(r));

let memoryIndexed = false;
try {
  const home = Deno.env.get("HOME");
  if (home) {
    for await (const proj of Deno.readDir(`${home}/.claude/projects`)) {
      if (!proj.isDirectory) continue;
      if (await index(`${home}/.claude/projects/${proj.name}/memory`)) memoryIndexed = true;
    }
  }
} catch { /* no memory dir on this machine — the absent-repo rule covers it */ }

/**
 * Where this repo keeps instruction-grade prose.
 *
 * ⚠️ **A root that is skipped must be skipped out loud**, so the summary prints
 * what it DID scan. api-cloudrun's worst gap was in NEITHER its scanned list nor
 * its deferred one, so nothing anywhere said it was uncovered — and it held a
 * broken citation. A configured root that does not exist FAILS rather than being
 * skipped: a root silently dropping out reads as a clean result rather than an
 * unscanned one.
 */
const SCAN_ROOTS: Array<{ path: string; exts: string[] }> = [
  { path: "CLAUDE.md", exts: [".md"] },
  { path: "README.md", exts: [".md"] },
  { path: ".claude", exts: [".md"] },
  { path: "scripts", exts: [".ts", ".md"] },
  { path: ".github", exts: [".yaml", ".yml", ".md"] },
];

async function* filesUnder(dir: string, exts: string[]): AsyncGenerator<string> {
  let entries;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return;
  }
  for await (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* filesUnder(p, exts);
    else if (exts.some((x) => e.name.endsWith(x))) yield p;
  }
}

async function docsToCheck(): Promise<string[]> {
  if (argFiles.length) return argFiles;
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = `${REPO}/${root.path}`;
    let stat;
    try {
      stat = await Deno.stat(abs);
    } catch {
      console.error(
        `error: configured scan root \`${root.path}\` does not exist — fix SCAN_ROOTS`,
      );
      Deno.exit(1);
    }
    if (stat.isFile) out.push(abs);
    else for await (const f of filesUnder(abs, root.exts)) out.push(f);
  }
  return out.filter((f) => !isHistoryDoc(f));
}

const rel = (p: string) => p.replace(`${WORKSPACE}/`, "");

/**
 * Dead citations allowed to stand for a stated reason, checked in BOTH
 * directions: if the path comes BACK the exemption fails as obsolete; if the
 * citation DISAPPEARS it fails as unmatched. `file` is WORKSPACE-relative,
 * because that is the form the report prints.
 */
const EXEMPT: { file: string; path: string; why: string }[] = [];
const exemptUsed = new Set<string>();

const lineCounts = new Map<string, number>();
async function lineCount(f: string): Promise<number> {
  const hit = lineCounts.get(f);
  if (hit !== undefined) return hit;
  const n = (await Deno.readTextFile(f)).split("\n").length;
  lineCounts.set(f, n);
  return n;
}

const OWN_TOP_LEVEL = new Set<string>();
for await (const e of Deno.readDir(REPO)) OWN_TOP_LEVEL.add(e.name);

const counts: Record<CitationVerdict, number> = {
  "ok": 0,
  "broken": 0,
  "ambiguous": 0,
  "unverifiable": 0,
  "deleted-ok": 0,
};
let checked = 0, pathOnly = 0;
const brokenList: string[] = [];

for (const doc of await docsToCheck()) {
  let text: string;
  try {
    text = await Deno.readTextFile(doc);
  } catch (e) {
    console.error(`error: cannot read ${doc}: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
  const findings: string[] = [];
  const seen = new Set<string>();
  const relDoc = rel(doc);

  for (const m of text.matchAll(CITATION)) {
    const [, path, from, to] = m;
    const key = from === undefined ? path : `${path}:${from}${to ? `-${to}` : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (from === undefined) pathOnly++;
    checked++;

    // ⚠️ Consulted FIRST, before every heuristic: two of classifyCitation's
    // steps are environment-dependent, so a lookup after them is reached on one
    // machine and not another — and the both-directions discharge below then
    // reports "the citation is gone" about one sitting untouched in the file.
    const ex = EXEMPT.find((e) => e.file === relDoc && e.path === path);
    if (ex) {
      exemptUsed.add(`${relDoc}::${path}`);
      continue;
    }

    const resolved = resolveSpecifier(path);
    const candidates = preferOwnRepo(
      resolved.includes("/")
        ? allPaths.filter((f) => f.endsWith(`/${resolved}`))
        : byBasename.get(resolved) ?? [],
      `${REPO}/`,
    );

    let lineOutOfRange = false;
    let eofDetail = "";
    if (candidates.length && from !== undefined) {
      const top = Number(to ?? from);
      const lengths = await Promise.all(candidates.map(lineCount));
      lineOutOfRange = !candidates.some((_, i) => top <= lengths[i]);
      if (lineOutOfRange) {
        eofDetail = candidates.map((f, i) => `${rel(f)} has ${lengths[i]}`).join("; ");
      }
    }

    const verdict = classifyCitation({
      resolved,
      candidates,
      presentRepos,
      absentRepos,
      knownRepos: REPOS,
      ownTopLevel: OWN_TOP_LEVEL,
      describesDeletion: describesDeletion(text, m.index),
      lineOutOfRange,
    });
    counts[verdict]++;

    switch (verdict) {
      case "ok":
        break;
      case "broken": {
        const why = lineOutOfRange ? `line past EOF (${eofDetail})` : "no such file";
        findings.push(`  BROKEN     ${key} — ${why}`);
        brokenList.push(`${relDoc}: ${key}${lineOutOfRange ? " (past EOF)" : ""}`);
        break;
      }
      case "ambiguous":
        findings.push(`  AMBIGUOUS  ${key} → ${candidates.map(rel).join("  |  ")}`);
        break;
      case "unverifiable": {
        const head = resolved.split("/")[0];
        const why = /node_modules|_dist/.test(resolved)
          ? "build artifact; re-derive from the published package"
          : REPOS.includes(head)
          ? `repo \`${head}\` is not checked out here`
          : `unresolved, and ${absentRepos.join("/")} not checked out`;
        findings.push(`  UNVERIFIABLE ${key} — ${why}`);
        break;
      }
      case "deleted-ok":
        if (verbose) findings.push(`  DELETED-OK   ${key} — prose says it is gone`);
        break;
    }
  }

  if (findings.length) {
    console.log(`\n${relDoc}`);
    for (const f of findings) console.log(f);
  }
}

let exemptionFailures = 0;
for (const e of EXEMPT) {
  const key = `${e.file}::${e.path}`;
  const resolves = allPaths.some((f) => f.endsWith(`/${e.path}`)) ||
    (byBasename.get(e.path)?.length ?? 0) > 0;
  if (resolves) {
    exemptionFailures++;
    console.log(
      `\nexemption ${e.file} -> \`${e.path}\` is OBSOLETE: the path resolves again. Delete it.`,
    );
  } else if (!exemptUsed.has(key)) {
    exemptionFailures++;
    console.log(
      `\nexemption ${e.file} -> \`${e.path}\` matched NOTHING: the citation is gone. Delete it.`,
    );
  }
}

console.log(
  `\n${checked} citations checked (${checked - pathOnly} line-numbered, ` +
    `${pathOnly} path-only) — ${counts.broken} broken, ${counts.ambiguous} ambiguous, ` +
    `${counts["deleted-ok"]} deleted-and-said-so, ${counts.unverifiable} unverifiable`,
);
if (absentRepos.length) {
  console.log(
    `Sibling repos not checked out: ${absentRepos.join(", ")} — citations into them are ` +
      `UNVERIFIABLE, not broken.`,
  );
  console.log(
    "⚠️ This repo's citations are mostly CROSS-REPO, so this run is much weaker than a " +
      "full-workspace one. Do not read it as evidence the prose is clean.",
  );
}
if (!memoryIndexed) {
  console.log("Auto-memory notes not found on this machine — citations to them are UNVERIFIABLE.");
}
if (!argFiles.length) {
  console.log(`Scanned: ${SCAN_ROOTS.map((r) => r.path).join(", ")}.`);
  console.log(
    "Not scanned: templates/**, layouts/**, partials/** (.eta) — rendered output, guarded " +
      "instead by the PII scan in templates-lint.yml and by money-lint.yml.",
  );
}
if (counts.broken || counts.ambiguous || exemptionFailures) {
  if (brokenList.length) {
    console.log(`\n${brokenList.length} broken citation(s):`);
    for (const b of brokenList) console.log(`  ${b}`);
    console.log(
      "\nFix by repointing the citation, deleting it, or — if the path really is gone —\n" +
        "saying so in the surrounding prose, which is what a reader needs anyway.",
    );
  }
  console.log(
    "⚠️ A citation that resolves may still have drifted off its subject — this cannot see that.",
  );
  Deno.exit(2);
}
Deno.exit(0);
