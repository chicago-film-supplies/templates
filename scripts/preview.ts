/**
 * Renders a template with a fixture JSON and writes the output HTML.
 *
 * Mirrors the git-canonical overlay the api-cloudrun render lib performs:
 * the document body (`templates/<name>.eta`) is rendered, then injected into
 * the component layout (`layouts/base.eta`) along with the concatenated
 * stylesheet (component `styles/*.css` from the sidecar's
 * `depends_on.components` + the template's own `styles/<name>.css`).
 *
 * The render date is FROZEN (injected as `it.now`) so output is deterministic
 * — no `new Date()` in templates (golden-diff friendly).
 *
 * Usage: deno task preview [name] [fixture-slug]
 * Defaults: quote + the first fixture in `fixtures/<name>/`.
 * A fixture slug resolves to `fixtures/<name>/<slug>.json`; passing a path
 * (anything containing `/` or ending in `.json`) is also accepted as an
 * escape hatch.
 */
import { Eta } from "@bgub/eta";
import * as dateFns from "date-fns";
import currency from "currency.js";
import * as orderUtils from "@cfs/utilities/orders";
import * as dateUtils from "@cfs/utilities/dates";

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 44 160 80" fill="currentColor" role="img" aria-label="Chicago Film Supplies logo"><path d="m 46.8,104.95007 c -0.2,1.4 0.7,2.5 2.1,2.5 h 47.5 c 1.4,0 2.7,-1.1 3,-2.5 l 0.3,-1.6 H 47.2 l -0.3,1.6 z"/></svg>`;

/** Frozen render timestamp — deterministic output for goldens. */
const NOW = "2026-01-15T12:00:00.000-06:00";

const eta = new Eta({ autoEscape: true, cache: false });

const name = Deno.args[0] || "quote";

/** Resolve the fixture file: explicit path (contains `/` or ends `.json`),
 * a bare slug → `fixtures/<name>/<slug>.json`, or the first fixture in
 * `fixtures/<name>/` when no argument is passed. */
async function resolveFixturePath(name: string, arg: string | undefined): Promise<string> {
  if (arg && (arg.includes("/") || arg.endsWith(".json"))) return arg;
  if (arg) return `fixtures/${name}/${arg}.json`;
  const dir = `fixtures/${name}`;
  try {
    const entries: string[] = [];
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".json")) entries.push(e.name);
    }
    entries.sort();
    if (entries.length === 0) {
      throw new Error(`No fixtures in ${dir}/ — capture one in the manager or drop a JSON file here.`);
    }
    return `${dir}/${entries[0]}`;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`No fixtures directory at ${dir}/ — capture one in the manager first.`);
    }
    throw err;
  }
}

const fixtureFile = await resolveFixturePath(name, Deno.args[1]);
const outputFile = "preview.html";

interface RenderConfig {
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  base_font_size?: number;
  filename?: string;
  footer?: string;
  header?: string;
}

interface Sidecar {
  display_name: string;
  depends_on?: { components?: string[] };
  render?: RenderConfig;
}

const sidecar: Sidecar = JSON.parse(
  await Deno.readTextFile(`templates/${name}.meta.json`),
);
const components = sidecar.depends_on?.components ?? [];
const renderConfig = sidecar.render ?? {};

// Overlay the stylesheet: component styles first, then the template's own.
const styleParts: string[] = [];
for (const dep of components) {
  styleParts.push(await Deno.readTextFile(`styles/${dep}.css`));
}
styleParts.push(await Deno.readTextFile(`styles/${name}.css`));
const styles = styleParts.join("\n");

const layout = await Deno.readTextFile("layouts/base.eta");
const templateBody = await Deno.readTextFile(`templates/${name}.eta`);
const doc = JSON.parse(await Deno.readTextFile(fixtureFile));

const ctx = {
  doc,
  version: 1,
  now: NOW,
  dateFns,
  currency,
  orders: orderUtils,
  dates: dateUtils,
  logo: LOGO_SVG,
};

const body = await eta.renderStringAsync(templateBody, ctx);
let html = await eta.renderStringAsync(layout, { ...ctx, body, styles });

// Render config (margins / base font size / dynamic filename / footer).
// Mirrors the api-cloudrun render path: the footer is rendered via Eta with the
// same context and the dynamic filename string is rendered to a literal. The
// footer renders in an isolated Chromium frame at PDF time — here we inline it
// below the body purely so the preview confirms it parses + renders.
if (renderConfig.filename) {
  const filename = await eta.renderStringAsync(renderConfig.filename, ctx);
  console.log(`Filename → ${filename}`);
}
if (renderConfig.footer) {
  const footerSrc = await Deno.readTextFile(renderConfig.footer);
  const footerHtml = await eta.renderStringAsync(footerSrc, ctx);
  html = html.replace(
    "</body>",
    `<hr><div data-preview-footer>${footerHtml}</div></body>`,
  );
}

await Deno.writeTextFile(outputFile, html);
console.log(`Rendered ${name} → ${outputFile}`);
if (renderConfig.base_font_size || renderConfig.margin_top !== undefined) {
  console.log(
    `Render config: base_font_size=${renderConfig.base_font_size}, ` +
      `margins=[${renderConfig.margin_top},${renderConfig.margin_right},` +
      `${renderConfig.margin_bottom},${renderConfig.margin_left}]`,
  );
}

if (!Deno.args.includes("--no-open")) {
  const cmd = new Deno.Command("open", { args: [outputFile] });
  await cmd.output();
}
