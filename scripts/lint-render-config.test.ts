/**
 * Both polarities of `lint-render-config.ts` (templates#291), so the arm cannot
 * go vacuous: the real sidecars are clean, and each planted break is red.
 */
import { assert, assertEquals } from "@std/assert";
import { templateSchemaFields } from "@cfs/core/schemas";
import { checkRenderExpression, lintRenderConfig } from "./lint-render-config.ts";

const pickSheets = templateSchemaFields["pick-sheets"]!;
const aging = templateSchemaFields["aging-reports"]!;
const sessions = templateSchemaFields["movement-sessions"]!;

Deno.test("the real tree: every family's render.filename resolves", async () => {
  const { findings, checked } = await lintRenderConfig(new URL("../", import.meta.url).pathname);
  assertEquals(findings, []);
  // Not vacuous: every family that declares a filename was actually read.
  assert(checked >= 7, `only ${checked} filename(s) checked`);
});

Deno.test("planted: a misspelled field is red (it.doc.scope.nam)", () => {
  const problems = checkRenderExpression("Pick Sheet - <%= it.doc.scope.nam %>", pickSheets);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("scope.nam"), problems[0]);
});

Deno.test("planted: the templates#290 regression is red (AgingScope.name was deleted)", () => {
  const broken = "AR Aging - <%= it.doc.scope.kind === 'all' ? 'All Accounts' : it.doc.scope.name %>";
  assertEquals(checkRenderExpression(broken, aging).length, 1);
});

Deno.test("clean: a correct field, a prototype method and an array index all resolve", () => {
  assertEquals(checkRenderExpression("<%= it.doc.scope.name %>", pickSheets), []);
  assertEquals(checkRenderExpression("<%= it.doc.as_of_invoice_date.slice(0, 10) %>", aging), []);
  assertEquals(
    checkRenderExpression("<% if (it.doc.orders.length === 1) { %><%= it.doc.orders[0].number %><% } %>", sessions),
    [],
  );
});

Deno.test("planted: a field past an array index must exist on the member", () => {
  assertEquals(checkRenderExpression("<%= it.doc.orders[0].numbr %>", sessions).length, 1);
});

Deno.test("planted: what cannot be read statically fails CLOSED", () => {
  for (
    const expr of [
      "<%= it.doc[key] %>",
      "<%= it.doc.scope[k] %>",
      "<%= it['doc'].scope.name %>",
      "<% const d = it.doc %><%= d.scope.nam %>",
    ]
  ) {
    assert(checkRenderExpression(expr, pickSheets).length > 0, `read as clean: ${expr}`);
  }
});

Deno.test("a quoted it.doc is text, not code", () => {
  assertEquals(checkRenderExpression("<%= 'it.doc.nope' %>", pickSheets), []);
});
