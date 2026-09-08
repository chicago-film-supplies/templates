/**
 * Which published `@cfs/core` should `capture-floor.json`'s `min_core` become?
 *
 * Extracted from `scripts/lint-capture-floor.ts` so it can be tested on a
 * synthetic ladder — the lint itself reads JSR and cannot run under
 * `deno task test`, which is `--allow-read` only.
 *
 * ## Why this is separate from DETECTION (templates#251)
 *
 * 🔴 **The lint detects on TAGS and recommends on TAGS + ROUTES, and the
 * asymmetry is deliberate.** A tag set is what `core` can answer about itself,
 * and the lint's job is to catch a mask that EXISTS while the floor does not
 * require it. But a tag with no route is `api-cloudrun#837`'s defect class —
 * `fakeForMask` falls through to the generic filler, producing *fake, but the
 * wrong kind of fake, and unverifiable by any oracle*. So the number this
 * prints has to clear the higher bar even though the failure that printed it
 * cleared only the lower one.
 *
 * ⚠️ **The measured instance, and why "one version too low" is the dangerous
 * amount:** when the `statements` schema landed, `core` `8404a6d` added the six
 * TAGS as `beta.364` and `fe3858b` added the ROUTE (`organization_path.name` →
 * `organization`) as `beta.365`. A tag-only bisect answers `.364` — higher than
 * the old floor, plausible, and it defeats the guard. `capture-floor.json`'s own
 * `why` already said the previous floor was set for *"the corrected fixture-PII
 * ROUTER (beta.355), **not a tag**"*, so the printed remedy contradicted the
 * rationale of the value it was changing.
 *
 * ⭐ **A remedy that is mechanically followable and wrong is the shape that
 * survives review.** Two sessions hit this within minutes and both rejected the
 * recommendation — but only because they happened to know why the floor exists.
 *
 * ## Route agreement is a COMPARISON, not an absolute test
 *
 * `categoryForField` is total: it returns `text` for anything unrouted, and
 * `text` is also the correct answer for a genuinely free-text field. So
 * "is this leaf routed?" has no answer from the function alone. What IS
 * answerable is whether a candidate routes each leaf **the way the newest
 * published core does** — the same frame the tag comparison already uses, and
 * it needs no list of which categories count as deliberate.
 */

/** What `covers` reports about one candidate version. */
export type CoverVerdict =
  /** Carries every tag the newest does, and routes them all the same way. */
  | true
  /** Something the newest requires is missing at this version. */
  | false
  /** The version could not be interrogated — NOT the same fact as `false`. */
  | null;

export interface FloorSuggestion {
  /** The version to write into `capture-floor.json`. */
  version: string;
  /** Parenthetical for the operator, naming how it was arrived at. */
  note: string;
}

/**
 * The earliest published version that fully covers the newest, or the newest
 * itself when that cannot be established.
 *
 * ⚠️ **Every fallback is the NEWEST, which is always correct and merely
 * over-strict.** The one thing this must never do is answer LOW: a floor below
 * what a capture needs passes `captureFloorVerdict` and writes the leak into
 * git, which nothing recalls.
 *
 * ⚠️ **The bisect assumes the predicate is MONOTONE** (a tag or a route, once
 * landed, stays). Nothing guarantees that, so the boundary is VERIFIED rather
 * than trusted — the version below the answer must NOT cover. If it does, the
 * range is not monotone and the bisect's answer would not be safe.
 *
 * @param published every orderable unyanked version, ascending
 * @param floorVersion the current `min_core`
 * @param newest `published.at(-1)`, passed rather than derived so a caller
 *   cannot silently disagree with the list it also passed
 * @param covers the per-version predicate — injected, which is what makes this
 *   testable without a network or a JSR import
 */
export async function suggestFloor(
  published: readonly string[],
  floorVersion: string,
  newest: string,
  covers: (version: string) => Promise<CoverVerdict>,
): Promise<FloorSuggestion> {
  const fallback: FloorSuggestion = {
    version: newest,
    note: `the newest published version — a bisect for the exact introducing ` +
      `version could not complete, so this is the safe over-strict answer`,
  };

  const floorIdx = published.indexOf(floorVersion);
  if (floorIdx === -1) return fallback;

  let lo = floorIdx + 1;
  let hi = published.length - 1;
  if (lo > hi) return fallback;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const verdict = await covers(published[mid]);
    if (verdict === null) return fallback;
    if (verdict) hi = mid;
    else lo = mid + 1;
  }

  // ⚠️ `lo` is only a candidate until it is CHECKED. The loop narrows to a
  // single index without ever evaluating it when the range started at length 1,
  // and a range whose every member fails converges on the last one — which does
  // not cover. Verifying `lo` itself is what stops that being reported as the
  // answer.
  const at = await covers(published[lo]);
  if (at !== true) return fallback;

  const below = lo - 1 >= 0 ? await covers(published[lo - 1]) : false;
  if (below === false) {
    return {
      version: published[lo],
      note: `the earliest published version carrying every pii tag the newest ` +
        `does AND routing them all the same way (verified: ${published[lo - 1]} ` +
        `does not)`,
    };
  }
  return {
    version: newest,
    note: `the newest published version — the tag/route set is NOT monotone ` +
      `across the range (${published[lo - 1]} also covers), so the bisect's ` +
      `answer would not be safe`,
  };
}
