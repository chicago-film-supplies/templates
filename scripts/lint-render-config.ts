/**
 * Render-config lint — every `it.doc.<path>` a sidecar's `render.filename`
 * dereferences must name a field of that family's `collection_source`.
 * templates#291.
 *
 * ⚠️ **Why this needs its own guard.** `render.filename` is Eta, evaluated
 * against the same context as the template body, but it lives inside a JSON
 * file. Nothing else reads it as code: `lint:fixtures` validates fixture
 * documents, `lint:dates` and `lint:citations` scan `.eta` files, the draft
 * Eta compile gate never sees the sidecar, and `visual-diff` renders the page —
 * the filename is not on the page. So when core#92 (`beta.386`) deleted
 * `AgingScope.name`, every scoped AR Aging PDF downloaded as
 * `AR Aging - undefined - <date>.pdf` with every gate green (repaired in
 * templates#290).
 *
 * **The authority is core's GENERATED field list** (`templateSchemaFields` in
 * `@cfs/core/schemas`), the same list the manager's field panel serves. It is
 * emitted from the Zod schemas, flattens union arms and spells array members
 * as `parent[].child`, so a path resolves here exactly when an author could
 * have picked it from the editor. A hand list in this repo would be a second
 * copy of a core fact.
 *
 * ⚠️ **Static extraction is necessary and NOT sufficient, so this guard fails
 * CLOSED on anything it cannot read.** The expression is arbitrary JavaScript.
 * A computed access (`it.doc[key]`), a bare `it.doc` handed to a function or
 * bound to a name, and `it["doc"]` are all invisible to a path walk — so each
 * is a FINDING, not a skip. Reporting clean on an expression it could not read
 * is the `text`-fallback failure `core/src/utils/fixture-pii.ts` warns about.
 * After the last resolvable field, a member of the value's built-in prototype
 * (`.slice`, `.length`, `.toFixed` …) ends the chain; any other member is
 * unresolvable.
 *
 * ⚠️ **Scope: `render.filename` only.** `render.footer` / `render.header` are
 * content-map KEYS naming `.eta` partials, not expressions, and the shared
 * footer is rendered by families with different collection sources, so it
 * needs a per-family resolution this script does not attempt.
 *
 * Whole-tree, takes no arguments, `--allow-read` only. It answers a question
 * about every family, and a pin bump that deletes a field touches no sidecar —
 * the #187 reason `lint:fixtures` is whole-tree too.
 *
 * Run: deno task lint:render-config
 */
import { type SchemaField, templateSchemaFields } from "@cfs/core/schemas";
import { annotateError } from "./_annotate.ts";

export interface RenderConfigFinding {
  gitPath: string;
  expression: string;
  message: string;
}

/** One step of an `it.doc` access chain. */
type Segment = { kind: "name"; name: string } | { kind: "index" };

/** What a field's generated type string says it is, for the built-in check. */
function builtinOwner(type: string): object[] {
  const owners: object[] = [];
  if (type.includes("[]")) owners.push(Array.prototype);
  if (/\bnumber\b/.test(type)) owners.push(Number.prototype);
  if (/\bboolean\b/.test(type)) owners.push(Boolean.prototype);
  // An enum renders as `a | b | c` and is a string at runtime; only a plain
  // `object` (and nothing else) is not string-like.
  const bare = type.replace(/\?/g, "").split("|").map((s) => s.trim()).filter((s) => s !== "null");
  if (bare.some((t) => !["object", "number", "boolean"].includes(t) && !t.endsWith("[]"))) {
    owners.push(String.prototype);
  }
  return owners;
}

/** Strip string literals so a quoted `it.doc` is not read as code. */
function stripStrings(code: string): string {
  return code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, (m) => " ".repeat(m.length));
}

/** The JavaScript inside every Eta tag of `template`. */
export function etaCode(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/<%([=~-]?)([\s\S]*?)-?%>/g)) out.push(m[2]);
  return out;
}

/**
 * Check one Eta string against one collection's fields. Pure, so the unit arm
 * can plant both polarities.
 */
export function checkRenderExpression(template: string, fields: SchemaField[]): string[] {
  const types = new Map(fields.map((f) => [f.path, f.type]));
  const problems: string[] = [];
  for (const raw of etaCode(template)) {
    const code = stripStrings(raw);
    if (/\bit\s*\[/.test(code) || /\bit\s*\?\.\s*\[/.test(code)) {
      problems.push(`computed access on \`it\` (\`it[...]\`) — cannot be read statically`);
    }
    // Every reference to `doc` off `it`, however it is written.
    const re = /\bit\s*(?:\?\.|\.)\s*doc\b/g;
    for (const m of code.matchAll(re)) {
      const rest = code.slice(m.index! + m[0].length);
      const segs: Segment[] = [];
      let cursor = 0;
      let computed = false;
      while (true) {
        const tail = rest.slice(cursor);
        let mm: RegExpMatchArray | null;
        if ((mm = tail.match(/^\s*\??\.\s*([A-Za-z_$][\w$]*)/))) {
          segs.push({ kind: "name", name: mm[1] });
        } else if ((mm = tail.match(/^\s*(?:\?\.)?\s*\[\s*\d+\s*\]/))) {
          segs.push({ kind: "index" });
        } else if (/^\s*(?:\?\.)?\s*\[/.test(tail)) {
          // Anything but a numeric index — including a quoted key, which
          // stripStrings has already blanked — is read as computed. Closed.
          computed = true;
          break;
        } else break;
        cursor += mm[0].length;
      }
      const shown = `it.doc${
        segs.map((s) => s.kind === "index" ? "[n]" : `.${s.name}`).join("")
      }`;
      if (computed) {
        problems.push(`\`${shown}[…]\` is a computed access — cannot be read statically`);
        continue;
      }
      if (segs.length === 0) {
        problems.push(
          "bare `it.doc` (passed whole or bound to a name) — its field accesses cannot be read statically",
        );
        continue;
      }
      let cur = "";
      for (const seg of segs) {
        const curType = cur === "" ? "object" : types.get(cur)!;
        if (seg.kind === "index") {
          if (cur === "" || !curType.includes("[]")) {
            problems.push(`\`${shown}\` indexes \`${cur || "it.doc"}\`, which is not an array (${curType})`);
            cur = "\u0000";
            break;
          }
          cur = `${cur}[]`;
          // `x[]` itself is not listed; its children are `x[].child`.
          types.set(cur, curType.replace("[]", "").replace(/\?|\|\s*null/g, "").trim() || "object");
          continue;
        }
        const next = cur === "" ? seg.name : `${cur}.${seg.name}`;
        if (types.has(next)) {
          cur = next;
          continue;
        }
        if (cur !== "" && builtinOwner(curType).some((p) => seg.name in p)) break; // a method of the VALUE
        problems.push(
          `\`${shown}\` — \`${next.replaceAll("[]", "[n]")}\` is not a field of this collection`,
        );
        cur = "\u0000";
        break;
      }
    }
  }
  return problems;
}

/** Lint every `templates/*.meta.json` under `root` (CWD by default). */
export async function lintRenderConfig(root = "."): Promise<{
  findings: RenderConfigFinding[];
  checked: number;
}> {
  const findings: RenderConfigFinding[] = [];
  let checked = 0;
  const names: string[] = [];
  for await (const e of Deno.readDir(`${root}/templates`)) {
    if (e.isFile && e.name.endsWith(".meta.json")) names.push(e.name);
  }
  for (const name of names.sort()) {
    const gitPath = name.slice(0, -".meta.json".length);
    let sidecar: { collection_source?: string; render?: { filename?: unknown } };
    try {
      sidecar = JSON.parse(await Deno.readTextFile(`${root}/templates/${name}`));
    } catch (err) {
      findings.push({ gitPath, expression: "", message: `sidecar does not parse: ${err}` });
      continue;
    }
    const filename = sidecar.render?.filename;
    if (filename === undefined) continue;
    if (typeof filename !== "string") {
      findings.push({ gitPath, expression: String(filename), message: "render.filename is not a string" });
      continue;
    }
    const source = sidecar.collection_source ?? "";
    const fields = (templateSchemaFields as Record<string, SchemaField[] | undefined>)[source];
    if (!fields) {
      findings.push({
        gitPath,
        expression: filename,
        message: `collection_source ${JSON.stringify(source)} has no generated field list in @cfs/core`,
      });
      continue;
    }
    checked++;
    for (const message of checkRenderExpression(filename, fields)) {
      findings.push({ gitPath, expression: filename, message });
    }
  }
  return { findings, checked };
}

if (import.meta.main) {
  if (Deno.args.length > 0) {
    console.error(`lint-render-config: takes no arguments, got ${Deno.args.join(" ")}`);
    Deno.exit(2);
  }
  const { findings, checked } = await lintRenderConfig();
  if (findings.length === 0) {
    console.log(
      `lint-render-config: ${checked} render.filename expression(s), every it.doc access resolves — clean.`,
    );
    Deno.exit(0);
  }
  console.error(`lint-render-config: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  ✗ [${f.gitPath}] ${f.message}\n      ${f.expression}`);
    annotateError({
      file: `templates/${f.gitPath}.meta.json`,
      title: "templates-lint › render-config",
      message: f.message,
    });
  }
  Deno.exit(1);
}
