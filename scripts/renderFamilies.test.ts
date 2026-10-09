/**
 * `renderFamilies` — the visual-diff fan-out (api-cloudrun#1245). Pure; reads no
 * tree and runs no git.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  componentFileIndex,
  readHeadTree,
  renderFamilies,
  type RenderTree,
  sidecarRenderChanged,
} from "./renderFamilies.ts";

/** The planned split, with today's paths. */
const SPLIT: RenderTree = {
  familyDependsOn: new Map([
    ["quote", ["layout", "letterhead", "destinations", "line-items"]],
    ["invoice", ["layout", "letterhead", "destinations", "line-items"]],
    ["packing-list", ["layout", "letterhead", "destinations"]],
    ["statement", ["layout", "letterhead"]],
  ]),
  componentFiles: new Map([
    ["layout", ["layouts/base.eta", "styles/base.css", "partials/shared/footer.eta"]],
    ["letterhead", ["partials/shared/letterhead.eta", "styles/letterhead.css"]],
    ["destinations", ["partials/shared/destinations.eta", "styles/destinations.css"]],
    ["line-items", ["partials/shared/items-grid.eta", "partials/shared/totals.eta", "styles/line-items.css"]],
  ]),
};
const never = () => false;
const sorted = (s: Set<string>) => [...s].sort();

Deno.test("a component file re-renders only the families that declare its component", () => {
  assertEquals(sorted(renderFamilies(["partials/shared/totals.eta"], SPLIT, never)), ["invoice", "quote"]);
  assertEquals(sorted(renderFamilies(["styles/destinations.css"], SPLIT, never)), [
    "invoice",
    "packing-list",
    "quote",
  ]);
  assertEquals(sorted(renderFamilies(["layouts/base.eta"], SPLIT, never)), [
    "invoice",
    "packing-list",
    "quote",
    "statement",
  ]);
});

Deno.test("today's single `base` still fans a shared edit out to every family", () => {
  const today: RenderTree = {
    familyDependsOn: new Map([["quote", ["base"]], ["statement", ["base"]]]),
    componentFiles: new Map([["base", ["layouts/base.eta", "partials/shared/totals.eta"]]]),
  };
  assertEquals(sorted(renderFamilies(["partials/shared/totals.eta"], today, never)), ["quote", "statement"]);
});

Deno.test("a legacy shared path no component claims falls back to every family", () => {
  assertEquals(sorted(renderFamilies(["partials/shared/unlisted.eta"], SPLIT, never)).length, 4);
});

Deno.test("a sidecar edit is a render change only when depends_on/render/params moved", () => {
  assertEquals(sorted(renderFamilies(["templates/statement.meta.json"], SPLIT, never)), []);
  assertEquals(
    sorted(renderFamilies(["templates/statement.meta.json"], SPLIT, (gp) => gp === "statement")),
    ["statement"],
  );
});

Deno.test("sidecarRenderChanged reads depends_on, render and params — not the rename", () => {
  const base = { depends_on: { components: ["base"] }, render: { margin_top: 0.5 }, params: [] };
  assertEquals(sidecarRenderChanged(base, { ...base, display_name: "x" } as typeof base), false);
  assertEquals(sidecarRenderChanged(base, { ...base, depends_on: { components: ["layout"] } }), true);
  assertEquals(sidecarRenderChanged(base, { ...base, render: { margin_top: 1 } }), true);
  assertEquals(sidecarRenderChanged(base, { ...base, params: [{ key: "k" }] }), true);
  assertEquals(sidecarRenderChanged(null, base), true, "a new family renders");
  assertEquals(sidecarRenderChanged(base, null), false, "a removed family does not");
});

Deno.test("a component SIDECAR edit re-renders its dependents", () => {
  assertEquals(sorted(renderFamilies(["template-components/letterhead.meta.json"], SPLIT, never)).length, 4);
  assertEquals(sorted(renderFamilies(["template-components/line-items.meta.json"], SPLIT, never)), [
    "invoice",
    "quote",
  ]);
});

Deno.test("a family's own files and fixtures map to it; a removed family is dropped", () => {
  assertEquals(
    sorted(renderFamilies(
      ["templates/quote.eta", "styles/invoice.css", "partials/statement/x.eta", "fixtures/packing-list/a.json"],
      SPLIT,
      never,
    )),
    ["invoice", "packing-list", "quote", "statement"],
  );
  assertEquals(sorted(renderFamilies(["templates/gone.eta"], SPLIT, never)), []);
  assertEquals(sorted(renderFamilies(["README.md", "fixtures/quote/nested/x.json"], SPLIT, never)), []);
});

Deno.test("a path two components claim is refused", () => {
  assertThrows(
    () => componentFileIndex(new Map([["a", ["layouts/base.eta"]], ["b", ["layouts/base.eta"]]])),
    Error,
    "claimed by two components",
  );
});

Deno.test("the real tree parses, and every family's components exist", async () => {
  const head = await readHeadTree(new URL("..", import.meta.url).pathname);
  componentFileIndex(head.componentFiles);
  for (const [gp, deps] of head.familyDependsOn) {
    for (const d of deps) assertEquals(head.componentFiles.has(d), true, `${gp} declares unknown ${d}`);
  }
});
