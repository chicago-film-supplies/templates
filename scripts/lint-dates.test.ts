/**
 * `lint-dates.ts` — both polarities.
 *
 * ⭐ **A guard is only ever run against a corpus that happens to be right, so its
 * silence means nothing until something has shown it can speak.** That is the
 * reason `deno task test` exists in this repo at all (see `deno.json`'s `//test`
 * note), and it applies doubly here: the tree this lint scans is clean by
 * construction the moment the lint lands, so every real run is a pass.
 *
 * These read synthetic sources and never touch the disk.
 */
import { assertEquals } from "@std/assert";
import { scanSource } from "./lint-dates.ts";

const src = (...lines: string[]) => lines.join("\n");

Deno.test("an unpinned parseISO is a finding", () => {
  const f = scanSource(
    "t.eta",
    src(`<td><%= it.dateFns.format(it.dateFns.parseISO(d.start), 'EEE M/d/yy', { in: CHICAGO }) %></td>`),
  );
  assertEquals(f.length, 1);
  assertEquals(f[0].fn, "parseISO");
  assertEquals(f[0].line, 1);
});

Deno.test("🔴 pinning the FORMAT alone does not satisfy it — that was the whole defect", () => {
  // The shape that shipped: the format names Chicago, the parse does not, and
  // the call reads as careful. Every one of the 11 repaired call sites looked
  // exactly like this.
  const f = scanSource(
    "t.eta",
    src(`<%= it.dateFns.format(it.dateFns.parseISO(x), 'MMMM d, yyyy', { in: CHICAGO }) %>`),
  );
  assertEquals(f.length, 1);
});

Deno.test("a pinned parse and format is clean", () => {
  const f = scanSource(
    "t.eta",
    src(`<%= it.dateFns.format(it.dateFns.parseISO(x, { in: CHICAGO }), 'M/d/yy', { in: CHICAGO }) %>`),
  );
  assertEquals(f, []);
});

Deno.test("an unpinned FORMAT is a finding too, not just the parse", () => {
  const f = scanSource("t.eta", src(`<%= it.dateFns.format(someDate, 'M/d/yy') %>`));
  assertEquals(f.length, 1);
  assertEquals(f[0].fn, "format");
});

Deno.test("🔴 comments are exempt — the templates that EXPLAIN this defect must spell it", () => {
  // Not a loophole: a comment cannot compute. Without this the lint fails on its
  // own documentation, which is how a guard gets deleted rather than fixed.
  const f = scanSource(
    "t.eta",
    src(
      `<%/* an unpinned it.dateFns.parseISO(x) resolves against the ambient zone */%>`,
      `// it.dateFns.format(y, 'M/d/yy') would be wrong here`,
      `<%= it.dateFns.format(it.dateFns.parseISO(x, { in: CHICAGO }), 'M/d/yy', { in: CHICAGO }) %>`,
    ),
  );
  assertEquals(f, []);
});

Deno.test("🔴 the money and dates formatters are NOT swept up by a bare format(", () => {
  // The match keys on `.dateFns.` precisely so these are invisible to it. A lint
  // that fired on `it.money.formatCents` would be switched off within a week,
  // and it appears 19 times in `quote.eta` alone.
  const f = scanSource(
    "t.eta",
    src(
      `<td><%= it.money.formatCents(item.price.total_cents) %></td>`,
      `<td><%= it.dates.formatChargeDays(d.days_active).periodLabel %></td>`,
      `<td><%= it.money.formatRate(tax.rate) %></td>`,
    ),
  );
  assertEquals(f, []);
});

Deno.test("a call wrapped across lines is read whole, not reported for its formatting", () => {
  // ⚠️ The line-scoped version of this scanner passes the test above and fails
  // this one, by reporting a correctly-pinned call whose author happened to wrap
  // it. The remedy it would demand is "put it back on one line", which is a lint
  // dictating layout — so this arm is what keeps the balanced-paren reader.
  const f = scanSource(
    "t.eta",
    src(
      `<%= it.dateFns.format(`,
      `     it.dateFns.parseISO(x, { in: CHICAGO }),`,
      `     'MMMM d, yyyy',`,
      `     { in: CHICAGO },`,
      `   ) %>`,
    ),
  );
  assertEquals(f, []);
});

Deno.test("a wrapped call that is genuinely unpinned is still caught", () => {
  // The companion to the arm above — without it, "read across newlines" could be
  // implemented as "never report a multi-line call" and both would pass.
  const f = scanSource(
    "t.eta",
    src(`<%= it.dateFns.format(`, `     it.dateFns.parseISO(x),`, `     'MMMM d, yyyy',`, `   ) %>`),
  );
  assertEquals(f.length, 2);
  assertEquals(f.map((x) => x.fn).sort(), ["format", "parseISO"]);
});

Deno.test("every call site is reported, not just the first per file", () => {
  const f = scanSource(
    "t.eta",
    src(
      `<%= it.dateFns.format(it.dateFns.parseISO(a), 'M/d/yy', { in: CHICAGO }) %>`,
      `<%= it.dateFns.format(it.dateFns.parseISO(b), 'M/d/yy', { in: CHICAGO }) %>`,
    ),
  );
  assertEquals(f.length, 2);
  assertEquals(f.map((x) => x.line), [1, 2]);
});
