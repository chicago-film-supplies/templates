/**
 * Discriminant-arm fingerprints for `lint-capture-floor` (templates#286).
 *
 * The route fingerprint used to be `categoryForField(leaf.path)` with NO
 * siblings. core#91 routes `scope.name` on a sibling discriminant (`kind`), and
 * called without siblings that lookup falls through to `text` at EVERY version
 * — so a re-route of one arm (say `destination` from `address_full` to
 * something else) produced no difference to detect and the floor stayed put.
 * The oracle (core's check 2b) had the same omission and over-reported loudly;
 * here it under-reports silently, which is the worse direction.
 *
 * The probe set comes from core (`maskRouteProbes()`, beta.680) rather than a
 * table in this repo: one probe per arm of each discriminated route, so a new
 * discriminated route gets probes without an edit here. Each probe is asked of
 * a version's router WITH its siblings, and the answer is stored under the
 * probe's arm-labelled key (`scope.name[kind=destination]`).
 *
 * ⚠️ `declared` is kept for the output only. `kind: "order"` routes to `text`
 * ON PURPOSE (its identity is missing), and an arm known only to a schema union
 * falls through to `text` too. The fingerprint never judges a `text` answer —
 * it only compares one version's answer for an arm with another's — so the two
 * cannot be conflated here, and the label tells a reader which one they are
 * looking at.
 *
 * Pure and db-free, so `deno task test` (`--allow-read` only) can plant a
 * re-route without reaching JSR.
 */

/** The fields of core's `MaskRouteProbe` this lint uses. */
export interface RouteProbe {
  key: string;
  fieldPath: string;
  siblings: Readonly<Record<string, unknown>>;
  declared: boolean;
}

export type Router = (fieldPath: string, siblings?: Readonly<Record<string, unknown>>) => string;

/**
 * Narrow an unknown `maskRouteProbes()` result to probes, or `null` when it is
 * not the shape this lint understands. `null`, never `[]`: an empty probe set
 * compares as covered by everything, which is a silent pass.
 */
export function readProbes(value: unknown): RouteProbe[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: RouteProbe[] = [];
  for (const p of value) {
    if (
      !p || typeof p !== "object" || typeof p.key !== "string" ||
      typeof p.fieldPath !== "string" || typeof p.siblings !== "object" || p.siblings === null ||
      typeof p.declared !== "boolean"
    ) return null;
    out.push({ key: p.key, fieldPath: p.fieldPath, siblings: p.siblings, declared: p.declared });
  }
  return out;
}

/** One version's answer per probe, keyed on the arm-labelled probe key. */
export function probeRoutes(router: Router, probes: readonly RouteProbe[]): Map<string, string> {
  const routes = new Map<string, string>();
  for (const p of probes) routes.set(p.key, router(p.fieldPath, p.siblings));
  return routes;
}

/** How an arm reads in the output: `declared` or `schema-only`. */
export function armLabel(probe: RouteProbe): string {
  return probe.declared ? "declared arm" : "schema-only arm, falls through";
}

/**
 * Every key routed differently at `newest` than at `floor`, as
 * `key: before → after`. Only keys present at BOTH count: a key that exists
 * solely in the newest is a new tag (or a new arm) and is the TAG comparison's
 * business, and reporting it twice would name one change as two.
 */
export function reroutedEntries(
  floor: ReadonlyMap<string, string>,
  newest: ReadonlyMap<string, string>,
  probeByKey: ReadonlyMap<string, RouteProbe> = new Map(),
): string[] {
  return [...newest]
    .filter(([key, category]) => {
      const before = floor.get(key);
      return before !== undefined && before !== category;
    })
    .map(([key, category]) => {
      const probe = probeByKey.get(key);
      return `${key}: ${floor.get(key)} → ${category}` + (probe ? ` (${armLabel(probe)})` : "");
    })
    .sort();
}
