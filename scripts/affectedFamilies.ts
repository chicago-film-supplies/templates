/**
 * Which template families is this PR's author accountable for?
 *
 * ## Scope the BLAME, never the DETECTION
 *
 * Both lints scan the whole tree, and that is not negotiable —
 * `lint-fixtures.ts`'s own header states the reason and `#187` proved it: a
 * `@cfs/core` bump or a `collection_source` flip changes no fixture file, and
 * that is exactly the drift the lint exists to catch. `beta.307` deleted
 * `DocumentOrganizationSnapshot.name` and **all 23 fixtures stopped satisfying
 * their schemas at once while the bump touched zero fixture files**. A
 * changed-files-scoped SCAN would have passed that PR and landed 23 unparseable
 * fixtures.
 *
 * What is separable is *what makes the check red* from *what this author
 * introduced*. So: scan everything, block on findings in the families the PR
 * affects, report the rest as notices. On `main` there is no author to scope to
 * and nothing downstream of it, so the push arm runs unscoped — that asymmetry
 * is what stops the ratchet decaying, because a finding that never blocks
 * anyone eventually blocks no one.
 *
 * ## ⚠️ This table deliberately DISAGREES with `visual-diff.yml`'s
 *
 * `visual-diff.yml:88-130` maps a diff to affected `git_path`s for a different
 * question — *"which families RENDER differently?"* — and this one asks *"which
 * families' LINT VERDICT could this diff have changed?"* Four rows differ, and
 * every one of them is a case a naive copy gets wrong in the direction of
 * missing a real finding:
 *
 * | path | `visual-diff` | here | why |
 * |---|---|---|---|
 * | `templates/<gp>.meta.json` | no-op — "metadata-only, no render change" | **fan IN** | the sidecar holds `fixtures[]` descriptions (check 3) and `params[]` (check 5). It changes no pixel and can redden three checks. |
 * | `deno.json` / `deno.lock` | unmapped → the job skips | **fan OUT to every family** | check 1 resolves `templateSchemaFor` from the pinned core. **This is #187.** |
 * | `goldens/<branch>/<gp>/*.png` | not mapped (it reads goldens, never diffs them) | **fan IN** | check 4 is golden↔fixture parity in BOTH directions, so deleting a baseline is a finding about a file no other row names. |
 * | the lint's own sources | irrelevant | **fan OUT to every family** | changing a check changes every family's verdict, so its author owns all of them. |
 *
 * Keep the divergence commented. Without it the next reader reconciles the two
 * tables — and reintroduces #187.
 */

/** Files whose change re-scopes every family, whatever else the diff holds. */
const FANS_OUT_TO_EVERY_FAMILY = [
  // The `base` component's overlay ships on every document.
  "layouts/base.eta",
  "styles/base.css",
  // Check 1 resolves the document schema from the PINNED core. #187.
  "deno.json",
  "deno.lock",
  // Changing a check changes every family's verdict.
  "scripts/lint-fixtures.ts",
  "scripts/money-lint.ts",
  "scripts/affectedFamilies.ts",
  ".github/workflows/templates-lint.yml",
  ".github/workflows/money-lint.yml",
];

const FANS_OUT_PREFIXES = [
  "partials/shared/",
  // The component sidecar's `files[]` manifest decides what is overlaid.
  "template-components/",
];

/** Every registered family, from the one place that enumerates them. */
export async function allFamilies(root = "."): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(`${root}/templates`)) {
    if (entry.isFile && entry.name.endsWith(".meta.json")) {
      out.push(entry.name.slice(0, -".meta.json".length));
    }
  }
  return out.sort();
}

/**
 * The families a single path belongs to.
 *
 * Returns `"all"` for a shared asset, a set for an owned path, and an empty set
 * for a path that owns nothing (`README.md`, `fixtures/` itself, a stray file).
 * Exported because both lints need the same answer about two different inputs —
 * a CHANGED file (what is this author accountable for?) and a FINDING's file
 * (whose ledger does this land on?) — and those must agree or the partition
 * leaks.
 */
export function familiesOfPath(path: string): Set<string> | "all" {
  if (FANS_OUT_TO_EVERY_FAMILY.includes(path)) return "all";
  for (const prefix of FANS_OUT_PREFIXES) {
    if (path.startsWith(prefix)) return "all";
  }

  const one = (gp: string) => (gp && !gp.includes("/") ? new Set([gp]) : new Set<string>());

  // `templates/<gp>.eta` and `templates/<gp>.meta.json`. The sidecar fans IN
  // here where `visual-diff` no-ops it — see the table above.
  if (path.startsWith("templates/")) {
    const rest = path.slice("templates/".length);
    if (rest.endsWith(".meta.json")) return one(rest.slice(0, -".meta.json".length));
    if (rest.endsWith(".eta")) return one(rest.slice(0, -".eta".length));
    return new Set<string>();
  }

  // `styles/<gp>.css`. `styles/base.css` is caught above as a shared asset.
  if (path.startsWith("styles/")) {
    const rest = path.slice("styles/".length);
    return rest.endsWith(".css") ? one(rest.slice(0, -".css".length)) : new Set<string>();
  }

  // `partials/<gp>/**`. `partials/shared/**` is caught above.
  if (path.startsWith("partials/")) {
    return one(path.slice("partials/".length).split("/")[0] ?? "");
  }

  // `fixtures/<gp>/<slug>.json`
  if (path.startsWith("fixtures/")) {
    return one(path.slice("fixtures/".length).split("/")[0] ?? "");
  }

  // `goldens/<branch>/<gp>/<slug>.png` — three segments before the file, so the
  // family is the SECOND one. `visual-diff` never maps this at all.
  if (path.startsWith("goldens/")) {
    const parts = path.slice("goldens/".length).split("/");
    return parts.length >= 3 ? one(parts[1] ?? "") : new Set<string>();
  }

  return new Set<string>();
}

/**
 * The blame set for a whole diff.
 *
 * ⚠️ A family named by a changed path but not registered in `templates/` is
 * kept rather than dropped — a `fixtures/<gp>/` directory whose sidecar was
 * deleted is precisely the "fails closed" finding check 1 reports, and
 * intersecting it away here would make the lint unable to blame the PR that
 * caused it.
 */
export function blameFamilies(changedFiles: string[], families: string[]): Set<string> {
  const blamed = new Set<string>();
  for (const raw of changedFiles) {
    const path = raw.trim();
    if (!path) continue;
    const of = familiesOfPath(path);
    if (of === "all") return new Set(families);
    for (const gp of of) blamed.add(gp);
  }
  return blamed;
}

/**
 * Parse `--blame-changed-files=<path>` out of argv.
 *
 * Returns `null` when the flag is absent, which is the UNSCOPED mode: every
 * finding blocks. That is the default deliberately — a local run, and the
 * `main` push arm, must both be unscoped, and the safe mode is the one you get
 * by not passing anything.
 *
 * ⚠️ The file is read rather than taken as a list on the command line because a
 * diff can be thousands of paths long, and a truncated argv would silently
 * NARROW the blame set — i.e. fail open. A missing file throws.
 */
export const BLAME_FLAG = "--blame-changed-files=";

export async function readBlameSet(
  args: string[],
  root = ".",
): Promise<Set<string> | null> {
  const flag = args.find((a) => a.startsWith(BLAME_FLAG));
  if (!flag) return null;
  const path = flag.slice(BLAME_FLAG.length);
  const text = await Deno.readTextFile(path);
  return blameFamilies(text.split("\n"), await allFamilies(root));
}
