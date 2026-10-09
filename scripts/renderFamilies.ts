/**
 * Which template families RENDER differently after this diff? The fan-out for
 * `visual-diff.yml`.
 *
 * This replaced a bash `case` that hardcoded `layouts/base.eta`,
 * `styles/base.css` and `partials/shared/*` as "every family" and mapped every
 * `templates/<gp>.meta.json` to a no-op (api-cloudrun#1245). Both had stopped
 * being true:
 *
 * - **A shared file re-renders the families that DECLARE its component, not every
 *   family.** Ownership is the component sidecars' `files[]`
 *   (`template-components/*.meta.json`); a family renders with its own files plus
 *   the `files[]` of the components in its `depends_on`. api-cloudrun publishes
 *   exactly that set (`ownsTemplatePath` / `resolveFamilyOverlayAtTree`), so the
 *   gate has to fan out the same way or it gates a different change from the one
 *   that ships.
 * - **A sidecar edit that moves `depends_on`, `render` or `params` IS a render
 *   change.** `depends_on` decides which components' files a family renders with;
 *   `render` moves the page geometry and the footer; `params` decides what a
 *   default resolves to. The API cuts a version for each. A rename or a
 *   `fixtures[]` description is still not a render change.
 *
 * ⚠️ **This answers a different question from `affectedFamilies.ts`, and the two
 * tables must stay different.** That one asks whose LINT verdict a diff could
 * change and fans a shared file out to every family on purpose (over-blaming is
 * the safe direction for a lint). Its header has the divergence table; keep both.
 *
 * ⚠️ **A legacy shared path no component claims still fans out to every family**,
 * which is the conservative direction when nothing says who renders with it.
 *
 * Pure core (`renderFamilies`) + a thin CLI. No imports, so the CLI can run with
 * `--no-lock` before anything has resolved the import map.
 */

/** A family's render-relevant sidecar fields. */
export interface FamilySidecarView {
  depends_on?: { components?: unknown };
  render?: unknown;
  params?: unknown;
}

/** The head tree, reduced to what the fan-out needs. */
export interface RenderTree {
  /** Every registered family (one per `templates/<gp>.meta.json`) → its `depends_on.components`. */
  familyDependsOn: Map<string, string[]>;
  /** Every component (`template-components/<c>.meta.json`) → its `files[]`. */
  componentFiles: Map<string, string[]>;
}

const LEGACY_SHARED = (p: string) =>
  p === "layouts/base.eta" || p === "styles/base.css" || p.startsWith("partials/shared/");

/** Every component-owned path → its one owner. Throws on a path two components claim,
 * exactly as api-cloudrun's `componentFileIndex` does. */
export function componentFileIndex(componentFiles: Map<string, string[]>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [c, files] of componentFiles) {
    for (const f of files) {
      const prior = index.get(f);
      if (prior !== undefined && prior !== c) {
        throw new Error(`${f} is claimed by two components: ${prior} and ${c}`);
      }
      index.set(f, c);
    }
  }
  return index;
}

/** Whether a sidecar edit changes what the family renders. A missing base side
 * (a new family) counts as changed; a missing head side (a removed family) never
 * renders, so it does not. */
export function sidecarRenderChanged(
  base: FamilySidecarView | null,
  head: FamilySidecarView | null,
): boolean {
  if (head === null) return false;
  if (base === null) return true;
  const view = (s: FamilySidecarView) =>
    JSON.stringify([s.depends_on?.components ?? [], s.render ?? null, s.params ?? []]);
  return view(base) !== view(head);
}

const one = (gp: string | undefined): string | null => (gp && !gp.includes("/") ? gp : null);

/**
 * The families whose rendering this diff can change.
 *
 * @param changed paths from `git diff --name-only <merge-base> HEAD`
 * @param head the head tree's families and components
 * @param sidecarChanged whether `templates/<gp>.meta.json` changed a render field
 */
export function renderFamilies(
  changed: readonly string[],
  head: RenderTree,
  sidecarChanged: (gp: string) => boolean,
): Set<string> {
  const index = componentFileIndex(head.componentFiles);
  const families = new Set<string>();
  const components = new Set<string>();
  let all = false;

  for (const raw of changed) {
    const path = raw.trim();
    if (!path) continue;

    const owner = index.get(path);
    if (owner !== undefined) {
      components.add(owner);
      continue;
    }
    if (path.startsWith("template-components/") && path.endsWith(".meta.json")) {
      // What the component owns may have moved, so its dependents re-render.
      const c = one(path.slice("template-components/".length, -".meta.json".length));
      if (c) components.add(c);
      continue;
    }
    if (LEGACY_SHARED(path)) {
      all = true;
      continue;
    }
    if (path.startsWith("templates/")) {
      const rest = path.slice("templates/".length);
      if (rest.endsWith(".meta.json")) {
        const gp = one(rest.slice(0, -".meta.json".length));
        if (gp && sidecarChanged(gp)) families.add(gp);
      } else if (rest.endsWith(".eta")) {
        const gp = one(rest.slice(0, -".eta".length));
        if (gp) families.add(gp);
      }
      continue;
    }
    if (path.startsWith("styles/") && path.endsWith(".css")) {
      const gp = one(path.slice("styles/".length, -".css".length));
      if (gp) families.add(gp);
      continue;
    }
    if (path.startsWith("partials/")) {
      const gp = one(path.slice("partials/".length).split("/")[0]);
      if (gp) families.add(gp);
      continue;
    }
    if (path.startsWith("fixtures/")) {
      // fixtures/<gp>/<slug>.json — re-run that family's goldens.
      const rest = path.slice("fixtures/".length);
      const gp = one(rest.split("/")[0]);
      if (gp && rest.endsWith(".json") && rest.split("/").length === 2) families.add(gp);
      continue;
    }
  }

  if (all) return new Set(head.familyDependsOn.keys());
  for (const [gp, deps] of head.familyDependsOn) {
    if (deps.some((d) => components.has(d))) families.add(gp);
  }
  // A family that no longer exists at head has nothing to render.
  return new Set([...families].filter((gp) => head.familyDependsOn.has(gp)));
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseJson<T>(text: string | null, what: string): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${what} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

async function git(args: string[]): Promise<{ ok: boolean; out: string }> {
  const { success, stdout } = await new Deno.Command("git", { args, stderr: "null" }).output();
  return { ok: success, out: new TextDecoder().decode(stdout) };
}

async function readDirJson(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".meta.json")) {
        out.set(e.name.slice(0, -".meta.json".length), await Deno.readTextFile(`${dir}/${e.name}`));
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Read the head tree from the working directory. */
export async function readHeadTree(root = "."): Promise<RenderTree> {
  const familyDependsOn = new Map<string, string[]>();
  for (const [gp, text] of await readDirJson(`${root}/templates`)) {
    const s = parseJson<FamilySidecarView>(text, `templates/${gp}.meta.json`);
    familyDependsOn.set(gp, strings(s?.depends_on?.components));
  }
  const componentFiles = new Map<string, string[]>();
  for (const [c, text] of await readDirJson(`${root}/template-components`)) {
    const s = parseJson<{ files?: unknown }>(text, `template-components/${c}.meta.json`);
    componentFiles.set(c, strings(s?.files));
  }
  return { familyDependsOn, componentFiles };
}

if (import.meta.main) {
  const baseArg = Deno.args.find((a) => a.startsWith("--base="));
  if (!baseArg) {
    console.error("usage: renderFamilies.ts --base=<merge-base sha>");
    Deno.exit(2);
  }
  const base = baseArg.slice("--base=".length);
  const diff = await git(["diff", "--name-only", base, "HEAD"]);
  if (!diff.ok) {
    console.error(`git diff ${base} HEAD failed`);
    Deno.exit(1);
  }
  const changed = diff.out.split("\n").filter(Boolean);
  console.error("Changed files:\n" + changed.join("\n"));

  const head = await readHeadTree();
  const baseSidecars = new Map<string, FamilySidecarView | null>();
  for (const path of changed) {
    const m = /^templates\/([^/]+)\.meta\.json$/.exec(path);
    if (!m) continue;
    const shown = await git(["show", `${base}:${path}`]);
    baseSidecars.set(m[1], shown.ok ? parseJson<FamilySidecarView>(shown.out, `${base}:${path}`) : null);
  }
  const headSidecar = async (gp: string) => {
    try {
      return parseJson<FamilySidecarView>(
        await Deno.readTextFile(`templates/${gp}.meta.json`),
        `templates/${gp}.meta.json`,
      );
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  };
  const changedSidecars = new Set<string>();
  for (const [gp, b] of baseSidecars) {
    if (sidecarRenderChanged(b, await headSidecar(gp))) changedSidecars.add(gp);
  }

  const out = [...renderFamilies(changed, head, (gp) => changedSidecars.has(gp))].sort();
  console.log(out.join(" "));
}
