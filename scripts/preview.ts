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
import { tz } from "@date-fns/tz";
import * as orderUtils from "@cfs/core/utils/orders";
import * as invoiceUtils from "@cfs/core/utils/invoices";
import * as dateUtils from "@cfs/core/utils/dates";
import * as iconUtils from "@cfs/core/utils/icons";
import { CFS_LOGO_SVG } from "@cfs/core/utils/icons";
import * as moneyUtils from "@cfs/core/utils/money";
import { availableUtilNamespaces } from "@cfs/core/schemas";
import { resolveRenderParams } from "@cfs/core/utils/templates";
import type { TemplateCollectionType } from "@cfs/core/schemas";

/**
 * Every `@cfs/core/utils` module the server can inject, keyed by its `it.*`
 * namespace. Mirrors `UTIL_MODULES` in `api-cloudrun/src/lib/templates/eta.ts`.
 *
 * ⚠️ **`money` was missing here from the day `it.money` was introduced**, while
 * the server has always injected it — and `money` is in core's
 * `ALWAYS_ON_UTIL_NAMESPACES`, so `availableUtilNamespaces` requests it for
 * *every* template. The resolver below swallowed the miss, so the first
 * `it.money.formatCents(...)` written into a template rendered correctly in
 * production and threw under `deno task preview`: the harness failing on
 * content that is actually fine.
 *
 * That matters more than a broken preview. Phase 11 made `it.money` the ONLY
 * way to render a document total — `it.currency` was withdrawn entirely once
 * documents became cents-denominated — so the harness would have broken
 * progressively as templates were converted, on exactly the change it exists to
 * let an author see.
 *
 * The injected set here must keep MIRRORING the server's, which is asserted
 * against core's `TEMPLATE_LIB_GLOBALS` by Ratchet E. A library injected here
 * and not there is the same failure in the other direction: content that
 * previews fine and throws in production.
 *
 * The server side is guarded (`renderUtilNamespaces.test.ts` asserts every
 * namespace core declares injectable has a module to inject). This repo has no
 * test suite, so the guarantee here is the **throw** below rather than a test.
 */
const UTIL_MODULES: Record<string, unknown> = {
  orders: orderUtils,
  invoices: invoiceUtils,
  dates: dateUtils,
  money: moneyUtils,
  icons: iconUtils,
};

/**
 * The logo, imported rather than pasted.
 *
 * This file used to carry its own copy with a SINGLE path where the real logo
 * has five, so `deno task preview` had been rendering a visibly different logo
 * from production — the exact class of drift a second hand-copied SVG constant
 * invites, and nothing could catch it because the two copies lived in different
 * repos. One string now, in `@cfs/core/utils/icons`, read by both.
 */
const LOGO_SVG = CFS_LOGO_SVG;

/** Frozen render timestamp — deterministic output for goldens. */
const NOW = "2026-01-15T12:00:00.000-06:00";

const eta = new Eta({ autoEscape: true, cache: false });

/**
 * The LAYOUT engine — deliberately partial-free.
 *
 * `renderDocument` registers partials for the body, footer, header and filename
 * and NOT for the layout, whose context is `{doc, body, styles}`: an include
 * there would compile, render, and see none of `it`. Mirroring that split needs
 * a second engine, because `loadTemplate` writes into an instance-scoped store —
 * one shared engine would make an include in the layout work here and throw in
 * production, which is the direction this harness exists to prevent.
 */
const layoutEta = new Eta({ autoEscape: true, cache: false });

// Positionals are [template name, fixture slug]; flags may appear anywhere.
// Filtering them out first is what lets a TASK bake a flag in — `preview:watch`
// passes `--background`, which `deno task` places BEFORE the args a caller
// appends, so reading `Deno.args[0]` directly would resolve the template name
// to "--background".
const flag = (f: string) => Deno.args.includes(f);
const positional = Deno.args.filter((a) => !a.startsWith("--"));

const name = positional[0] || "quote";

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

const fixtureFile = await resolveFixturePath(name, positional[1]);
const outputFile = "preview.html";

interface RenderConfig {
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  filename?: string;
  footer?: string;
  header?: string;
}

interface Sidecar {
  display_name: string;
  collection_source?: TemplateCollectionType;
  collection_target?: TemplateCollectionType;
  depends_on?: { components?: string[] };
  params?: { key: string; type: "boolean"; label?: string; default?: boolean; required?: boolean }[];
  render?: RenderConfig;
}

const sidecar: Sidecar = JSON.parse(
  await Deno.readTextFile(`templates/${name}.meta.json`),
);
const components = sidecar.depends_on?.components ?? [];
const renderConfig = sidecar.render ?? {};

/**
 * `it.params` — the template's declared render params, resolved the way the
 * SERVER resolves them.
 *
 * Through core's own `resolveRenderParams`, not a local reimplementation, for
 * the same reason `UTIL_MODULES` above must mirror `eta.ts`: a harness that
 * decides defaults, unknown keys or required-ness on its own terms renders a
 * different document than production while looking correct here. It was absent
 * entirely until `quote` declared its first param, so `it.params.<key>` threw
 * `Cannot read properties of undefined` in preview while the server injected a
 * resolved object.
 *
 * Override one from the CLI to see the other state:
 *   deno task preview quote <fixture> --param hide_zero_priced_components=true
 * An unknown key or a non-boolean value throws here exactly as it 422s there.
 */
const paramOverrides: Record<string, unknown> = {};
for (const arg of Deno.args) {
  if (!arg.startsWith("--param")) continue;
  const spec = arg.startsWith("--param=") ? arg.slice("--param=".length) : Deno.args[Deno.args.indexOf(arg) + 1];
  if (!spec || !spec.includes("=")) {
    throw new Error(`--param needs <key>=<true|false>, got: ${spec ?? "(nothing)"}`);
  }
  const [key, raw] = spec.split("=", 2);
  paramOverrides[key] = raw === "true" ? true : raw === "false" ? false : raw;
}
const params = resolveRenderParams(sidecar.params ?? [], paramOverrides);

// Overlay the stylesheet: component styles first, then the template's own.
const styleParts: string[] = [];
for (const dep of components) {
  // A component need not ship a stylesheet — `base.meta.json`'s `files[]` is a
  // manifest, not a promise of one file per kind — and the server concatenates
  // whatever `styles/*.css` keys the content map happens to hold rather than
  // demanding one per dependency. An unguarded read turned "this component has
  // no CSS" into a NotFound crash naming a path the author never wrote.
  try {
    styleParts.push(await Deno.readTextFile(`styles/${dep}.css`));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}
styleParts.push(await Deno.readTextFile(`styles/${name}.css`));
const styles = styleParts.join("\n");

const layout = await Deno.readTextFile("layouts/base.eta");
const templateBody = await Deno.readTextFile(`templates/${name}.eta`);
const doc = JSON.parse(await Deno.readTextFile(fixtureFile));

/**
 * Register every includable partial under the `@` prefix the server uses.
 *
 * Both pools: `partials/shared/**` (owned by the `base` COMPONENT, overlaid onto
 * every family) and `partials/<name>/**` (this family's own). The server resolves
 * the same set out of the merged content map via `partialEntries`
 * (`api-cloudrun/src/lib/templates/eta.ts`), so a key registered here and not
 * there — or the reverse — is content that previews one way and renders another.
 *
 * The `@` prefix is not decoration. Eta routes any name WITHOUT it to its
 * filesystem resolver, which throws on the absent `views` config; with it, the
 * name reads the in-memory store `loadTemplate` writes. Authoring form:
 *
 *   <%~ await includeAsync("@partials/shared/bill-to.eta", { title: "…" }) %>
 */
async function* walkEta(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory) yield* walkEta(`${dir}/${e.name}`);
    else if (e.isFile && e.name.endsWith(".eta")) yield `${dir}/${e.name}`;
  }
}

const partialKeys: string[] = [];
for (const dir of ["partials/shared", `partials/${name}`]) {
  for await (const key of walkEta(dir)) {
    eta.loadTemplate(`@${key}`, await Deno.readTextFile(key), { async: true });
    partialKeys.push(key);
  }
}

/**
 * The `it.*` util namespaces this template gets — resolved from its sidecar's
 * collections, exactly as the server does (`availableUtilNamespaces`).
 *
 * This harness builds its own context and never calls the API's
 * `renderTemplate`, so it does NOT inherit that function's namespace resolution;
 * hard-coding `orders` + `dates` here would silently diverge from the server the
 * moment an invoice-source template exists — the preview would render green
 * against helpers prod never injects.
 */
const utilNamespaces = availableUtilNamespaces(
  sidecar.collection_source ? [sidecar.collection_source] : [],
  sidecar.collection_target ? [sidecar.collection_target] : [],
);

// Fail loudly on a namespace this harness cannot provide.
//
// This used to be `if (mod) utils[namespace] = mod;` — a silent skip, which is
// how the missing `money` module survived unnoticed. A swallowed miss does not
// make the preview work; it defers the failure to an `undefined is not an
// object` inside the template, where it reads as a template bug rather than a
// harness one. The whole value of this script is telling an author whether
// their content is correct, so it must not report a harness gap as their fault.
const utils: Record<string, unknown> = {};
for (const namespace of utilNamespaces) {
  const mod = UTIL_MODULES[namespace];
  if (!mod) {
    throw new Error(
      `preview: no module for util namespace "${namespace}". The server injects it ` +
        `(see UTIL_MODULES in api-cloudrun/src/lib/templates/eta.ts) but this harness ` +
        `does not, so a template using it.${namespace}.* would render in prod and fail ` +
        `here. Add it to UTIL_MODULES above and map @cfs/core/utils/${namespace} in ` +
        `deno.json — do not re-add a silent skip.`,
    );
  }
  utils[namespace] = mod;
}

const ctx = {
  doc,
  version: 1,
  params,
  now: NOW,
  dateFns,
  tz,
  logo: LOGO_SVG,
  ...utils,
};

const body = await eta.renderStringAsync(templateBody, ctx);
let html = await layoutEta.renderStringAsync(layout, { ...ctx, body, styles });

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
if (partialKeys.length > 0) {
  console.log(`Partials: ${partialKeys.join(", ")}`);
}
// `!== undefined`, not a truthiness test: a 0in margin is a legitimate config
// and would silence this line. The old form short-circuited on
// `renderConfig.base_font_size ||`, so deleting that key (templates#114) would
// have taken the margin log with it.
if (renderConfig.margin_top !== undefined) {
  console.log(
    `Render config: margins=[${renderConfig.margin_top},${renderConfig.margin_right},` +
      `${renderConfig.margin_bottom},${renderConfig.margin_left}]`,
  );
}

// Open in `$PREVIEW_BROWSER` when set, otherwise the OS default.
//
// This is not a preference. Gotenberg renders the PDF with CHROMIUM, so a
// preview opened in Safari is a different engine than the one that produces the
// artifact — WebKit distributes `table-layout: fixed` surplus differently, and
// its font metrics differ, so column widths and wrap points you eyeball there
// are not the ones that ship. Point this at a Chromium build and the preview
// agrees with the PDF:
//
//   export PREVIEW_BROWSER="Brave Browser"   # or "Google Chrome", "Chromium"
//
// Unset keeps the previous behaviour (bare `open` → the macOS default browser).
if (!flag("--no-open")) {
  const browser = Deno.env.get("PREVIEW_BROWSER");
  // `--background` maps to `open -g`: launch/raise the file WITHOUT activating
  // the app. `preview:watch` re-opens on every render, so without it the
  // browser steals focus on every save, which is unusable. Measured: `-g` holds
  // both on a cold start and on repeat opens into an already-running browser.
  const cmd = new Deno.Command("open", {
    args: [
      ...(flag("--background") ? ["-g"] : []),
      ...(browser ? ["-a", browser] : []),
      outputFile,
    ],
  });
  await cmd.output();
}
