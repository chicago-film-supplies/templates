import { assertEquals } from "@std/assert";
import { escapeData, escapeProperty, formatAnnotation } from "./_annotate.ts";

Deno.test("escapeData encodes %, CR and LF — % first, so an encoding is never double-encoded", () => {
  assertEquals(escapeData("100% done\r\nnext"), "100%25 done%0D%0Anext");
  assertEquals(escapeData("%0A"), "%250A");
  // `:` and `,` are legal in the message part.
  assertEquals(escapeData("a: b, c"), "a: b, c");
});

Deno.test("escapeProperty additionally encodes : and ,", () => {
  assertEquals(escapeProperty("a: b, c"), "a%3A b%2C c");
  assertEquals(escapeProperty("50%\n"), "50%25%0A");
});

Deno.test("formatAnnotation — file + line + title", () => {
  assertEquals(
    formatAnnotation("error", {
      file: "templates/quote.eta",
      line: 12,
      title: "money-lint",
      message: "line one\nline two: 100%",
    }),
    "::error file=templates/quote.eta,line=12,title=money-lint::line one%0Aline two: 100%25",
  );
});

Deno.test("formatAnnotation — no file omits file AND line; title is property-escaped", () => {
  assertEquals(
    formatAnnotation("warning", { line: 3, title: "a: b, c", message: "m" }),
    "::warning title=a%3A b%2C c::m",
  );
});

Deno.test("formatAnnotation — file without line", () => {
  assertEquals(
    formatAnnotation("error", { file: "deno.lock", title: "templates-lint › lockfile", message: "x" }),
    "::error file=deno.lock,title=templates-lint › lockfile::x",
  );
});
