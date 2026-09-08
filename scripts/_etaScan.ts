/**
 * The shared `.eta` scanning primitives — the file walk, the comment map, and
 * the balanced-argument reader.
 *
 * Extracted from `scripts/money-lint.ts` when `scripts/lint-dates.ts` needed the
 * same two, and named with a leading underscore for the same reason
 * `api-cloudrun/scripts/_citationScan.ts` is: it is a helper for the lints, not
 * a lint anyone runs.
 *
 * ⚠️ **`money-lint.ts` could not simply be imported from.** It parses `Deno.args`
 * and calls `Deno.exit` at module top level, so importing one function from it
 * runs its argument validation and can terminate the importing process. That is
 * fine for a script and disqualifying for a library, which is the whole reason
 * this file exists rather than a second copy of `commentLines` living in the new
 * lint. A second copy is exactly what `lint-fixtures.ts` warns about in its own
 * header: a rule with two implementations drifts invisibly, because each caller
 * only ever runs one of them.
 *
 * @module
 */

/** Every `.eta` file under `dir`, recursively. */
export async function* walkEta(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walkEta(p);
    else if (e.isFile && p.endsWith(".eta")) yield p;
  }
}

/**
 * The roots that hold owned template content, filtered to those that exist.
 *
 * ⚠️ **`partials` is in the list and it is the one that matters.** It was absent
 * from the PII scan until 2026-08-26 while money-lint had walked it all along —
 * and it is the worst root to omit, because `partials/shared/**` belongs to the
 * `base` COMPONENT and is overlaid onto EVERY family, so one bad line there
 * ships on every document at once. That is not hypothetical: 4 of the 11
 * unpinned `parseISO` call sites `lint-dates.ts` was written for lived in
 * `partials/shared/destinations.eta`, more than any single template body.
 */
export async function etaRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const d of ["templates", "layouts", "partials", "template-components"]) {
    try {
      await Deno.stat(d);
      roots.push(d);
    } catch { /* absent */ }
  }
  return roots;
}

/**
 * Line indices that are inside a comment.
 *
 * A rule that fires on a comment is a rule that punishes writing down why the
 * code is the way it is — and both lints here carry long prose about the very
 * constructs they ban, so without this they would fail on their own explanation.
 * `lint-dates.ts` is the sharp case: `templates/statement.eta` explains the
 * unpinned-`parseISO` defect in a comment that necessarily spells it.
 *
 * Comments cannot compute, so exempting them weakens nothing: there is no code
 * to hide in one. Line numbers are preserved (the set is of indices, not a
 * rewritten string) so every finding still points at the line the author reads.
 */
export function commentLines(src: string): Set<number> {
  const out = new Set<number>();
  const lines = src.split("\n");
  let inBlock = false;
  lines.forEach((line, i) => {
    let rest = line;
    if (inBlock) {
      out.add(i);
      const close = rest.indexOf("*/");
      if (close === -1) return;
      inBlock = false;
      rest = rest.slice(close + 2);
    }
    // `<%/* … */%>` (Eta) and `/* … */` (inside an eval tag) alike.
    const open = rest.search(/<%\/\*|\/\*/);
    if (open !== -1 && rest.indexOf("*/", open) === -1) {
      inBlock = true;
      out.add(i);
    }
    if (/^\s*(?:\/\/|\*|<%\/\*|<%#)/.test(line)) out.add(i);
  });
  return out;
}

/**
 * The text between the parentheses of a call whose `(` is at `openParen`,
 * counting nesting so a nested call or an object literal does not end it early.
 *
 * ⭐ **Reads across NEWLINES deliberately.** A line-scoped version is three lines
 * shorter and wrong in the direction that costs an author an afternoon: it
 * reports a correctly-pinned call as a finding purely because the author wrapped
 * it, so the remedy is "put it back on one line", which is a lint dictating
 * formatting. Every call site in the repo is single-line today; this is about
 * the twelfth one, written by someone who has never read this file.
 *
 * Returns `null` for an unbalanced call, which a caller should treat as "cannot
 * tell" rather than as a pass — an unterminated call does not compile, so the
 * Eta save gate refuses it before this lint would ever see it.
 */
export function callArgs(src: string, openParen: number): string | null {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return null;
}
