/**
 * Scan templates/**, layouts/** and partials/** for hardcoded customer PII.
 *
 * Moved out of the `templates-lint.yml` heredoc so it can share
 * `scripts/_annotate.ts` with every other guard (a stdin script cannot import
 * a sibling module by relative path) and so it runs locally as
 * `deno task lint:pii`. Behaviour is unchanged from the heredoc.
 *
 * ⚠️ `partials/` was NOT scanned until 2026-08-26, and it had never
 * been — while money-lint has walked it all along. It is the worst
 * root to omit: `partials/shared/**` is owned by a COMPONENT and
 * overlaid onto the families that declare it, so one hardcoded line there
 * ships on many documents at once. The file living there today carries the
 * company phone number, which only passes because it is allowlisted
 * below — the guard was never consulted about it.
 *
 * Heuristics (starting point — see the templates-lint.yml header):
 *   - email addresses whose domain is NOT chicagofilmsupplies.com
 *   - US phone-number patterns: (312) 555-1212 / 312-555-1212 /
 *     312.555.1212 / +1 312 555 1212 / 3125551212
 */
import { annotateError } from "./_annotate.ts";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE =
  /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}|\b\d{10}\b/g;
const ALLOWED_EMAIL_DOMAIN = "chicagofilmsupplies.com";
// CFS's own business contact is a legitimate hardcoded constant (it's
// the supplier's number, not customer PII). Allowlist its digits so
// the company-info block in templates doesn't trip the guard. Add
// more CFS lines here if they change.
const ALLOWED_PHONE_DIGITS = new Set(["3128183008"]);

interface Finding {
  file: string;
  line: number;
  kind: "email" | "phone";
  value: string;
}

const findings: Finding[] = [];
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile && p.endsWith(".eta")) yield p;
  }
}
const roots: string[] = [];
for (const d of ["templates", "layouts", "partials"]) {
  try {
    await Deno.stat(d);
    roots.push(d);
  } catch { /* absent */ }
}
for (const root of roots) {
  for await (const file of walk(root)) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(EMAIL)) {
        const domain = m[0].split("@")[1]?.toLowerCase() ?? "";
        if (domain !== ALLOWED_EMAIL_DOMAIN) {
          findings.push({ file, line: i + 1, kind: "email", value: m[0] });
        }
      }
      for (const m of line.matchAll(PHONE)) {
        const digits = m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        if (ALLOWED_PHONE_DIGITS.has(digits)) continue;
        findings.push({ file, line: i + 1, kind: "phone", value: m[0] });
      }
    });
  }
}
if (findings.length) {
  console.error("Hardcoded PII found — pull contact info from it.doc instead:\n");
  for (const f of findings) console.error(`  ${f.file}:${f.line}  hardcoded ${f.kind}: ${f.value}`);
  for (const f of findings) {
    annotateError({
      file: f.file,
      line: f.line,
      title: "templates-lint › pii",
      message: `hardcoded ${f.kind}: ${f.value} — pull contact info from it.doc instead.`,
    });
  }
  Deno.exit(1);
}
console.log("pii-lint: no hardcoded customer PII found.");
