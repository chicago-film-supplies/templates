/**
 * `suggestFloor` — the number `lint-capture-floor` prints (templates#251).
 *
 * 🔴 **The whole defect was a recommendation that is HIGHER than the floor,
 * mechanically followable, and wrong.** So an assertion of the shape *"it
 * recommends something above the floor"* passes in the broken state and is
 * worse than no test: `.364` is above `.355`. Every arm below names the exact
 * version.
 *
 * The ladder is synthetic and `covers` is injected, so nothing here reaches JSR
 * — `deno task test` is `--allow-read` only, which is also why the bisect lives
 * in its own module rather than inside the lint.
 */
import { assertEquals } from "@std/assert";
import { type CoverVerdict, suggestFloor } from "./captureFloorSuggest.ts";

/** The published ladder around the measured instance. */
const LADDER = [
  "10.0.0-beta.355",
  "10.0.0-beta.356",
  "10.0.0-beta.360",
  "10.0.0-beta.363",
  "10.0.0-beta.364",
  "10.0.0-beta.365",
];
const NEWEST = LADDER[LADDER.length - 1];

/** Records which versions were interrogated, so an arm can assert the walk. */
function tracking(
  verdict: (v: string) => CoverVerdict,
): { covers: (v: string) => Promise<CoverVerdict>; asked: string[] } {
  const asked: string[] = [];
  return {
    covers: (v: string) => {
      asked.push(v);
      return Promise.resolve(verdict(v));
    },
    asked,
  };
}

/**
 * The measured instance. `core` `8404a6d` added the `statements` TAGS as
 * `beta.364`; `fe3858b` added the ROUTE as `beta.365`. A tag-only predicate
 * covers from `.364`; the route-aware one only from `.365`.
 */
const TAGS_ONLY = (v: string): CoverVerdict => v >= "10.0.0-beta.364";
const TAGS_AND_ROUTES = (v: string): CoverVerdict => v === "10.0.0-beta.365";

Deno.test("🔴 the statements case: recommends .365, NOT the .364 that carries the tags alone", async () => {
  const { covers } = tracking(TAGS_AND_ROUTES);
  const got = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, covers);

  // ⚠️ THE falsifying assertion, and it must name the version. "above the
  // floor" is true of `.364` too, which is the exact wrong answer this exists
  // to catch.
  assertEquals(got.version, "10.0.0-beta.365");
  assertEquals(
    got.version === "10.0.0-beta.364",
    false,
    "recommended the version carrying the TAGS but not the ROUTE — the remedy defeats the floor",
  );
});

Deno.test("the control: a tag-only predicate on the same ladder answers .364", async () => {
  // Not a test of the fix — a test that the FIXTURE can tell the two apart.
  // Without it, the arm above could pass because the ladder only ever had one
  // reachable answer.
  const { covers } = tracking(TAGS_ONLY);
  const got = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, covers);
  assertEquals(got.version, "10.0.0-beta.364");
});

Deno.test("the note names the version below, so the boundary is checkable by hand", async () => {
  const { covers } = tracking(TAGS_AND_ROUTES);
  const got = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, covers);
  assertEquals(got.note.includes("10.0.0-beta.364"), true, got.note);
  assertEquals(got.note.includes("routing them all the same way"), true, got.note);
});

Deno.test("🔴 an uninterrogable version falls back to the NEWEST, never to a guess", async () => {
  // `null` is "could not ask", which is not "does not cover". Treating it as
  // either boolean would answer with a number nobody verified — and answering
  // LOW writes the leak into git.
  const { covers } = tracking((v) => (v === "10.0.0-beta.360" ? null : true));
  const got = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, covers);
  assertEquals(got.version, NEWEST);
  assertEquals(got.note.includes("could not complete"), true, got.note);
});

Deno.test("🔴 a NON-MONOTONE range falls back to the newest and says so", async () => {
  // The bisect is only sound if a tag/route, once landed, stays. Nothing
  // guarantees that, so the boundary is verified: if the version below the
  // answer ALSO covers, the answer is not the earliest and is not safe.
  // ⚠️ The caller only bisects when the floor is STALE, so a predicate saying
  // the floor covers is not a realistic input — model the real precondition:
  // the floor fails, everything above it passes.
  const { covers } = tracking((v) => v !== "10.0.0-beta.355");
  const got = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, covers);
  assertEquals(got.version, "10.0.0-beta.356", "every version above the floor covers, so the earliest is .356");

  // ⭐ **The non-monotone arm is UNREACHABLE from the lint, and testing it here
  // is a claim about this FUNCTION rather than about that caller.** Trace the
  // loop: `below` is `covers(published[lo - 1])`, and `lo - 1` is either a mid
  // the loop already rejected (so `false`) or — only when `lo` never advanced —
  // the FLOOR itself, which is never interrogated. So `below === true` means the
  // floor covers, and the lint only bisects when it does not. Kept anyway,
  // because the guard is cheap and the caller's precondition is not enforced by
  // any type.
  const floorCovers = tracking(() => true);
  const got2 = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, floorCovers.covers);
  assertEquals(got2.version, NEWEST);
  assertEquals(got2.note.includes("NOT monotone"), true, got2.note);
});

Deno.test("🔴 a range where NOTHING covers answers the newest, not the last one tried", async () => {
  // The bisect converges on the last index whether or not it covers, so `lo` is
  // a candidate until it is checked. Without that check this returns the
  // highest FAILING version — a number that looks like an answer.
  const { covers } = tracking((v) => v === NEWEST);
  const got = await suggestFloor(LADDER, "10.0.0-beta.355", NEWEST, covers);
  assertEquals(got.version, NEWEST);
});

Deno.test("a floor absent from the published list falls back rather than indexing from -1", async () => {
  const { covers, asked } = tracking(() => true);
  const got = await suggestFloor(LADDER, "10.0.0-beta.999", NEWEST, covers);
  assertEquals(got.version, NEWEST);
  assertEquals(asked.length, 0, "nothing should be interrogated when the floor is not on the ladder");
});
