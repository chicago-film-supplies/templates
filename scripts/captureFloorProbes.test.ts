/**
 * templates#286 — the capture-floor fingerprint sees a DISCRIMINANT re-route.
 *
 * Driven by core's real `maskRouteProbes()` and `categoryForField` (the pinned
 * beta), with a planted router standing in for a future core that re-points one
 * arm. Both polarities, plus the arm that shows why the old sibling-less
 * fingerprint could never have caught it.
 */
import { assert, assertEquals } from "@std/assert";
import { categoryForField, maskRouteProbes } from "@cfs/core/utils/fixture-pii";
import { probeRoutes, readProbes, reroutedEntries, type Router } from "./captureFloorProbes.ts";

const probes = readProbes(maskRouteProbes())!;
const real: Router = (p, s) => categoryForField(p, s);

/** A future core that re-routes the `destination` arm of `scope.name`. */
const planted: Router = (p, s) =>
  s?.kind === "destination" && p.endsWith("scope.name") ? "text" : categoryForField(p, s);

Deno.test("the probe set is real: every scope.name arm, incl. the declared `order → text`", () => {
  assert(probes !== null && probes.length >= 3, "maskRouteProbes() returned too few probes");
  const routes = probeRoutes(real, probes);
  assertEquals(routes.get("scope.name[kind=destination]"), "address_full");
  assertEquals(routes.get("scope.name[kind=organization]"), "organization");
  // Routed to text ON PURPOSE, and labelled declared — not an unrouted arm.
  assertEquals(routes.get("scope.name[kind=order]"), "text");
  assert(probes.find((p) => p.key === "scope.name[kind=order]")?.declared === true);
});

Deno.test("clean: the same router at both versions reroutes nothing", () => {
  assertEquals(reroutedEntries(probeRoutes(real, probes), probeRoutes(real, probes)), []);
});

Deno.test("planted: re-routing ONE arm is red, named by its arm", () => {
  const byKey = new Map(probes.map((p) => [p.key, p]));
  const out = reroutedEntries(probeRoutes(real, probes), probeRoutes(planted, probes), byKey);
  assertEquals(out, ["scope.name[kind=destination]: address_full → text (declared arm)"]);
});

Deno.test("the old fingerprint (no siblings) could not see that re-route", () => {
  // The defect this replaces: without siblings every arm reads `text` at both
  // versions, so there was no difference to detect.
  const before = new Map([["scope.name", real("scope.name")]]);
  const after = new Map([["scope.name", planted("scope.name")]]);
  assertEquals(reroutedEntries(before, after), []);
});

Deno.test("readProbes fails closed on an absent or empty probe set", () => {
  assertEquals(readProbes(undefined), null);
  assertEquals(readProbes([]), null);
  assertEquals(readProbes([{ key: "x" }]), null);
});
