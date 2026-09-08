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
import * as fulfillmentUtils from "@cfs/core/utils/fulfillments";
import * as sessionUtils from "@cfs/core/utils/sessions";
import * as pickSheetUtils from "@cfs/core/utils/pickSheets";
import * as dateUtils from "@cfs/core/utils/dates";
import * as iconUtils from "@cfs/core/utils/icons";
import { CFS_LOGO_SVG } from "@cfs/core/utils/icons";
import * as moneyUtils from "@cfs/core/utils/money";
import * as organizationUtils from "@cfs/core/utils/organizations";
import { availableUtilNamespaces } from "@cfs/core/schemas";
import {
  injectPartDefaults,
  resolveRenderParams,
} from "@cfs/core/utils/templates";
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
  // `fulfillments` is a template SOURCE collection: a packing list renders from
  // what was PICKED rather than what was ordered. A fulfillments-sourced family
  // resolves to `{dates, money, icons, fulfillments}` and gets NO `it.orders`,
  // so this entry is the only thing that gives it document helpers at all.
  fulfillments: fulfillmentUtils,
  // `movement-sessions` is a template SOURCE with **no Firestore collection
  // behind it** (api-cloudrun#700): a receipt renders the fold of every movement
  // sharing one `uuid_session`, which is rebuilt per call and stored nowhere. A
  // `movement-sessions`-sourced family resolves to `{dates, money, icons,
  // sessions}` and gets NO `it.orders`, so this entry is the only thing that
  // gives a receipt any document helpers at all.
  sessions: sessionUtils,
  // `pick-sheets` is the SECOND source with no Firestore collection behind it,
  // and the first whose document spans MANY stored documents rather than folding
  // one: a multi-order packing list renders every open line at one destination
  // or with one organization, ACROSS orders. A `pick-sheets`-sourced family
  // resolves to `{dates, money, icons, pickSheets}` and gets NO `it.orders`, so
  // this entry is the only thing that gives it document helpers at all.
  //
  // ⚠️ The key is camelCase where every sibling is kebab, and that is forced
  // rather than a style choice: injection keys on the `TEMPLATE_COLLECTION_UTILS`
  // value, which has to be a valid `it.<ns>` identifier, and `it.pick-sheets`
  // does not parse. See the module docstring in `core/src/utils/pickSheets.ts`.
  pickSheets: pickSheetUtils,
  dates: dateUtils,
  money: moneyUtils,
  icons: iconUtils,
  // Always-on as of @cfs/core@10.0.0-beta.304, and it reaches a template for ONE
  // helper: `composeOrgName(path)`, the only way to render a customer name from a
  // frozen `DocumentOrganizationSnapshot.path`. Every document a template renders
  // names a customer and the one place that name appears is
  // `partials/shared/letterhead.eta`, a partial shared across every collection —
  // so it is keyed to no source collection, exactly like `money` and `icons`.
  //
  // ⭐ **The throw below is what made this a required part of the pin bump rather
  // than a discovery in review.** `organizations` joined
  // `ALWAYS_ON_UTIL_NAMESPACES` in core, so `availableUtilNamespaces` requests it
  // for EVERY template; without this entry every `deno task preview` fails at
  // once. That is the harness reporting a harness gap as a harness gap, which is
  // precisely what the silent skip could not do for `money`.
  organizations: organizationUtils,
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

/** `--foo=bar` → "bar"; `--foo bar` → "bar"; absent → undefined. Both spellings
 * because `--param` already accepts both and one flag syntax per script is the
 * least a caller should have to remember. */
function flagValue(f: string): string | undefined {
  const eq = Deno.args.find((a) => a.startsWith(`${f}=`));
  if (eq) return eq.slice(f.length + 1);
  const i = Deno.args.indexOf(f);
  const next = i === -1 ? undefined : Deno.args[i + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

/**
 * Chromium binaries this harness will screenshot with, most-preferred first.
 *
 * ⚠️ These are BINARIES, not app names — `open -a "Brave Browser"` takes the
 * latter and headless takes the former, and they are not interchangeable.
 * `$PREVIEW_BROWSER_BIN` overrides the search outright; `$PREVIEW_BROWSER` (the
 * app name, which the `--open` path also reads) is mapped onto the macOS bundle
 * layout so one variable configures both surfaces.
 */
const BROWSER_CANDIDATES = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/brave-browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

/** App names for the `--open` path, in the same preference order — so a GUI
 * open lands on Chromium rather than on the OS default (Safari here), which is
 * the wrong engine for the reason given at the bottom of this file. */
const MACOS_APP_PREFERENCE = [
  "Brave Browser",
  "Chromium",
  "Google Chrome",
  "Microsoft Edge",
];

/** A `file://` URL for a path Chromium is about to open. Built here rather than
 * pulled from `@std/path`: two call sites do not earn a dependency in a preview
 * harness, and `new URL` percent-encodes the spaces a macOS app bundle path is
 * full of, which naive concatenation does not. */
const fileUrl = (path: string) => new URL(path, `file://${Deno.cwd()}/`).href;

/** The binary's own name, for the log line. */
const binName = (path: string) => path.split("/").pop() ?? path;

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

const appExists = (app: string) => exists(`/Applications/${app}.app`);

function resolveHeadlessBrowser(): string | undefined {
  const explicit = Deno.env.get("PREVIEW_BROWSER_BIN");
  if (explicit) {
    if (!exists(explicit)) {
      // Named and absent is an ERROR, where "found nothing" is a warning: the
      // caller stated which binary to use, so falling back to a different one
      // would silently screenshot with an engine they did not choose.
      throw new Error(`PREVIEW_BROWSER_BIN=${explicit} does not exist.`);
    }
    return explicit;
  }
  const named = Deno.env.get("PREVIEW_BROWSER");
  const fromName = named
    ? `/Applications/${named}.app/Contents/MacOS/${named}`
    : undefined;
  if (fromName && exists(fromName)) return fromName;
  return BROWSER_CANDIDATES.find(exists);
}

/**
 * Viewport width the screenshot is taken at.
 *
 * ⚠️ **A deliberate copy of `DEFAULT_SCREENSHOT_WIDTH_PX` in
 * `api-cloudrun/src/lib/templates/golden.ts`, which is the authority** — it is
 * private there and reaches no shared package, so this cannot be imported the
 * way `injectPartDefaults` is. Matching it is what makes a local look and a
 * `visual-diff` candidate the same layout; drifting apart costs that agreement
 * and nothing else, so this is a soft copy rather than a load-bearing one. If
 * the gate's number moves, move this one and say so.
 */
const SCREENSHOT_WIDTH_PX = 1280;

/** Fallback canvas height when the document cannot be measured. Generous on
 * purpose — a too-tall canvas wastes white space, a too-short one silently cuts
 * the bottom off the page. */
const FALLBACK_HEIGHT_PX = 2400;

/**
 * The canvas to screenshot on, measured from the document itself.
 *
 * `--window-size=W,H` short-circuits both halves. Otherwise the width is
 * `SCREENSHOT_WIDTH_PX` and the height is the document's own `scrollHeight`,
 * read by a throwaway `--dump-dom` pass — a second browser launch, which is the
 * price of old-headless `--screenshot` capturing the viewport rather than the
 * full page.
 */
async function resolveCanvas(
  browser: string,
  file: string,
): Promise<{ width: number; height: number }> {
  const override = flagValue("--window-size");
  if (override) {
    const [w, h] = override.split(",").map((n) => Number.parseInt(n, 10));
    if (Number.isFinite(w) && Number.isFinite(h)) {
      return { width: w, height: h };
    }
    throw new Error(`--window-size needs <width>,<height>, got: ${override}`);
  }
  const probe = `${file}.measure.html`;
  try {
    const html = await Deno.readTextFile(file);
    // Appended AFTER everything, so it measures the finished document. The
    // marker is read out of the dumped DOM rather than out of stdout, because
    // Chromium writes its own noise to both streams.
    await Deno.writeTextFile(
      probe,
      `${html}<script>document.body.insertAdjacentHTML("beforeend",` +
        `'<i id=H>' + document.documentElement.scrollHeight + '</i>')</script>`,
    );
    const out = await new Deno.Command(browser, {
      args: [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        `--window-size=${SCREENSHOT_WIDTH_PX},1000`,
        "--virtual-time-budget=2000",
        "--dump-dom",
        fileUrl(probe),
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    const measured = Number.parseInt(
      new TextDecoder().decode(out.stdout).match(/<i id="H">(\d+)<\/i>/)?.[1] ??
        "",
      10,
    );
    // `+ 1` absorbs a fractional scrollHeight rounding down onto the last line
    // of text; the alternative is a one-pixel crop nobody would think to look
    // for.
    if (Number.isFinite(measured) && measured > 0) {
      return { width: SCREENSHOT_WIDTH_PX, height: measured + 1 };
    }
  } catch {
    // Fall through to the fallback — a measurement failure must not cost the
    // screenshot, only its exact height.
  } finally {
    await Deno.remove(probe).catch(() => {});
  }
  return { width: SCREENSHOT_WIDTH_PX, height: FALLBACK_HEIGHT_PX };
}

const name = positional[0] || "quote";

/** Resolve the fixture file: explicit path (contains `/` or ends `.json`),
 * a bare slug → `fixtures/<name>/<slug>.json`, or the first fixture in
 * `fixtures/<name>/` when no argument is passed. */
async function resolveFixturePath(
  name: string,
  arg: string | undefined,
): Promise<string> {
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
      throw new Error(
        `No fixtures in ${dir}/ — capture one in the manager or drop a JSON file here.`,
      );
    }
    return `${dir}/${entries[0]}`;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `No fixtures directory at ${dir}/ — capture one in the manager first.`,
      );
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
  params?: {
    key: string;
    type: "boolean";
    label?: string;
    default?: boolean;
    required?: boolean;
  }[];
  fixtures?: { slug: string; params?: Record<string, boolean> }[];
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
 * ⚠️ **A fixture's OWN declared state is the base, and `--param` overrides on
 * top of it** (api-cloudrun#608). A fixture's `fixtures[]` entry may carry a
 * `params` map — the state it is rendered and golden-gated at — and seeding
 * from it is what keeps this harness showing the document the GATE freezes for
 * that fixture. Without the seed a `collection_leg` fixture would preview its
 * delivery leg here and be blessed on its collection leg in CI, which is the
 * #325 divergence class one layer out: the harness deciding render inputs on
 * its own terms, and looking correct while doing it.
 *
 * Override from the CLI to see any other state:
 *   deno task preview quote <fixture> --param hide_zero_priced_components=true
 * An unknown key or a non-boolean value throws here exactly as it 422s there.
 */
// `resolveFixturePath` also accepts an arbitrary path, which is not a fixture of
// this family and therefore declares no state — so match only inside the
// family's own dir rather than on the basename, which would silently apply one
// fixture's declared state to an unrelated file that happens to share its name.
const fixtureDir = `fixtures/${name}/`;
const fixtureSlug =
  fixtureFile.startsWith(fixtureDir) && fixtureFile.endsWith(".json")
    ? fixtureFile.slice(fixtureDir.length, -".json".length)
    : null;
const paramOverrides: Record<string, unknown> = {
  ...(sidecar.fixtures?.find((f) => f.slug === fixtureSlug)?.params ?? {}),
};
for (const arg of Deno.args) {
  if (!arg.startsWith("--param")) continue;
  const spec = arg.startsWith("--param=")
    ? arg.slice("--param=".length)
    : Deno.args[Deno.args.indexOf(arg) + 1];
  if (!spec || !spec.includes("=")) {
    throw new Error(
      `--param needs <key>=<true|false>, got: ${spec ?? "(nothing)"}`,
    );
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
  // 🔴 **An ISOLATED frame, built by the same function the PDF path uses.**
  // This used to splice the rendered footer into the body document as a plain
  // `<div>`, and both halves of that were wrong. It failed to reproduce the
  // isolation — Chromium renders a header/footer in its own document, which is
  // why the customer-facing quote footer rendered in Times for as long as it
  // existed while this harness showed it in the page's font — and it CORRUPTED
  // what it was previewing beside it, because the partial's own `<style>`
  // (`body`, `a`, `div`, `footer` — all bare selectors) leaked onto the whole
  // quote. So an author's local check disagreed with the shipped PDF and with
  // the goldens, in both directions at once. templates#137 / #139.
  //
  // ⭐ **`injectPartDefaults` is imported, never reimplemented.** It is the one
  // author of the frame document across three surfaces — this harness, the
  // Gotenberg convert, and the golden gate — which is exactly why it lives in
  // `@cfs/core/utils/templates` rather than in any of them. A local copy here
  // would drift silently: nothing renders both and compares.
  //
  // ⚠️ The margins come from the family's own `render` block, and are passed
  // straight through — `undefined` falls to `injectPartDefaults`' own
  // `CHROMIUM_DEFAULT_MARGIN_IN`. Spelling the fallback again HERE would be a
  // third copy of an external constant, which is the thing moving it into core
  // was for.
  const frame = injectPartDefaults(footerHtml, {
    styles,
    left: renderConfig.margin_left,
    right: renderConfig.margin_right,
  });
  // `srcdoc` on a sandboxed iframe: a real nested browsing context, so the
  // frame's cascade cannot reach the quote and the quote's cannot reach it —
  // which is the property being previewed. `sandbox` with no tokens also blocks
  // scripts, matching a print frame that runs none.
  html = html.replace(
    "</body>",
    `<hr><iframe data-preview-footer sandbox` +
      ` style="width:100%;height:120px;border:0;display:block"` +
      ` title="Footer frame (isolated, as Chromium renders it)"` +
      ` srcdoc="${
        frame.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
      }"></iframe></body>`,
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

// ── Looking at the render ───────────────────────────────────────────────────
//
// 🔴 **The default is a HEADLESS Chromium screenshot, and opening a GUI window
// is opt-in (`--open`).** It was the other way round until 2026-09-08, and both
// halves of that were wrong.
//
// The engine was wrong. Gotenberg renders the PDF with CHROMIUM, so a preview
// opened in Safari — the macOS default, and what a bare `open` reaches — is a
// different engine than the one that produces the artifact: WebKit distributes
// `table-layout: fixed` surplus differently and its font metrics differ, so the
// column widths and wrap points you eyeball there are not the ones that ship.
// `$PREVIEW_BROWSER` existed to fix that and had to be exported by hand, so the
// default stayed wrong for anyone who had not read this comment.
//
// And a WINDOW is the wrong artifact for the caller this harness now mostly
// has. `CLAUDE.md` is explicit that "a `preview` you have not LOOKED AT is not
// a verification, and this repo has no test suite, so looking is the only
// instrument there is" — an agent looks by reading a PNG, and cannot look at a
// window at all. Rendering one per fixture across a family put eight browser
// windows on a person's screen and stole focus from each, which is what
// prompted this.
//
// A human iterating still wants the window: `--open` is that, and
// `preview:watch` bakes it in.
const shotFile = flagValue("--screenshot") ?? "preview.png";

if (!flag("--no-screenshot")) {
  const browser = resolveHeadlessBrowser();
  if (!browser) {
    // ⚠️ A WARNING rather than a throw, and the asymmetry is deliberate. The
    // silent-skip ban this file carries elsewhere (`UTIL_MODULES`) is about a
    // skip that changes what RENDERS — the harness would disagree with
    // production and read as a template bug. A missing browser changes nothing
    // about the HTML; it only means no PNG was written, which is visible by its
    // absence and named here. The render already succeeded and is still useful.
    console.warn(
      `⚠️  No Chromium found — wrote no ${shotFile}. Install Brave/Chromium, or set\n` +
        `    PREVIEW_BROWSER_BIN=/path/to/binary. Tried: ${
          BROWSER_CANDIDATES.join(", ")
        }`,
    );
  } else {
    const { width, height } = await resolveCanvas(browser, outputFile);
    // Old-headless `--screenshot` captures THE VIEWPORT, not the full page, so
    // the canvas has to be sized to the document before the shot rather than
    // after — which is what `resolveCanvas` measures. Getting this wrong is not
    // a cosmetic loss: a truncated PNG silently omits the bottom of a long
    // document, and `long-multi-group` is several pages.
    const shot = new Deno.Command(browser, {
      args: [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        `--window-size=${width},${height}`,
        `--screenshot=${shotFile}`,
        fileUrl(outputFile),
      ],
      stdout: "null",
      // Chromium writes GPU/display noise to stderr on every run even when it
      // succeeds. Swallowed rather than shown, so a working screenshot does not
      // read as a failed one.
      stderr: "null",
    });
    const { success } = await shot.output();
    console.log(
      success
        ? `Screenshot → ${shotFile} (${width}x${height}, ${binName(browser)})`
        : `⚠️  ${
          binName(browser)
        } exited non-zero — ${shotFile} may be stale or missing.`,
    );
  }
}

// The GUI window, now opt-in. `$PREVIEW_BROWSER` still selects the app, and
// still should be a Chromium build for the engine reason above.
if (flag("--open")) {
  const browser = Deno.env.get("PREVIEW_BROWSER") ??
    MACOS_APP_PREFERENCE.find(appExists);
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
