# Shared template chrome + the invoice and packing-list families

> **Status 2026-08-26.** Phases 0, 0b, 1a and **1b** are landed or committed, and
> Phase 2 is **authored and locally verified**. One thing blocks everything left
> and it is a GitHub Actions outage — see *Blocked on*. Registering a family
> turned out NOT to need the manager, which this doc previously claimed twice.
> Written as one current statement rather than a stack of updates.

## What this is

`templates/` held exactly one family — `quote`. Two more are wanted: an
**invoice** (`invoices`→`invoices`) and a **packing list**
(`orders`→`packing_lists`, `fulfillment` surface, a boolean param selecting the
delivery leg or the collection leg). All three must keep sharing chrome as the
brand evolves.

Reviewing `quote.eta` against the invoice/order schemas surfaced four facts that
decide the shape of the work. Three contradicted the premise the request was
built on.

---

## The four findings

### 1. There was no `include()` in the render pipeline — sharing body markup did not exist

`renderTemplate` is `eta.renderStringAsync` on a bare string against an `Eta`
with **no `views`**, and Eta's `resolvePath` opens with
`if (!views) throw new EtaFileResolutionError(…)`. So `include()`,
`includeAsync()` and `layout()` all threw. `partials/**` reached a page **only**
when a sidecar `render.footer`/`render.header` named it — two slots per family,
each rendered as its own isolated document.

**Built (Phase 0).** Eta's escape hatch is the `@` prefix: a name starting with
`@` skips the filesystem branch and reads the in-memory `templatesAsync` store
`loadTemplate` writes, and `config.cache: false` does **not** gate that branch.

### 2. The invoice PDF already exists in production, and it is a 59-line placeholder

`api-cloudrun/src/services/invoicePdf.ts` regenerates a draft invoice PDF on
every meaningful invoice write via Cloud Task, plus a versioned path saved by
user action, with a full Uploadcare work-list/reconcile story. It renders via
`renderInvoiceHtml` (`api-cloudrun/src/lib/templates/invoice.ts`), whose own
docstring says *"placeholder for PDF generation."*

It emits three rows — Total, Amount Paid, Amount Due — and **no items table, no
bill-to, no destinations, no taxes, no line items at all**. Every invoice PDF a
customer has received is that document. It also interpolates
`organization.name`, `subject` and `reference` into HTML **unescaped**.

**So the invoice deliverable is not "author an `.eta`" — it is retiring that
placeholder** and pointing `invoicePdf.ts` at the git-canonical family, the way
`services/quotes.ts` does through `getQuoteTemplateUid()` + `renderDocument()`.

### 3. `Invoice.payments[]` was deleted 2026-08-03 — settlement is unreachable from a template

`totals` carries four rollups and nothing else: `amount_paid_cents`,
`amount_credited_cents`, `amount_void_cents`, `amount_due_cents`. The
per-settlement journal is a separate `settlements` collection reached by
`GET /settlements?uid_invoice=…`, and a template only ever receives `it.doc`.
`InvoiceSchema` is a `z.strictObject`, so an invoice cannot re-acquire a
`payments` array.

**Decision taken: rollup lines only**, so no pipeline change is needed. Two of
the four fields are bare `.optional()` with **no default** — every read needs
`?? 0`.

### 4. An invoice gets `it.invoices`, which was missing five helpers the quote's markup depends on

`availableUtilNamespaces(["invoices"], ["invoices"])` → `{dates, money, icons,
invoices}`. **No `it.orders`.** `it.invoices` did not carry `orderHasRentals`,
`orderHasDiscount`, `orderHasTax`, `getDestinationsLegend` or
`isSameAsDeliveryDates` — which the items grid and the destinations block both
call. **Fixed (Phase 0b).**

Three schema differences remain, all real:

| | order line | invoice line |
|---|---|---|
| `price.replacement_cents` | yes | **absent** — no Replacement Costs table |
| `zero_priced` | yes | **absent** — `projectOrderItemToInvoiceItem` does not carry it |
| dividers | `[destination, group]` | `[order, destination, group]` — `Order #975` rows |

⚠️ **`zero_priced` being absent makes the hide-components param a silent no-op
unless the predicate changes.** Prod invoice **#2390** (billing order 1004)
carries the exact case: `Bottled Water ( /bottle )`, qty 240, `base_cents: 0`,
`subtotal_cents: 0`, nested one level under its parent sale line, owing
**$12.00** of flat `Chicago Bottled Water Tax`. The line is there; the flag is
not. **The zero-priced predicate is therefore a PROP** — quote passes
`zero_priced === true && depth > 0`, invoice passes
`price.base_cents === 0 && depth > 0`. That gives the param on the invoice with
no `InvoiceDocLineItem` schema change and no backfill of 1,020 invoices, and
keeps quote's behaviour byte-for-byte. Core already sets the precedent
(`utils/invoices.ts`: *"Checked on the stored amounts, never inferred from
`zero_priced`."*)

---

## The design

> **A shared partial never names a util namespace, and never computes a value it
> could be handed.** Everything namespace- or family-dependent arrives as a prop
> — conventionally `u` for the namespace object.

> **One component (`base`), not several.** `LAYOUT_KEY` is the hard-coded literal
> `layouts/base.eta`; `ownsTemplatePath` matches nothing for a non-`base` path
> under `layouts/`, so a PR touching only `layouts/other.eta` publishes
> **nothing**; and style concatenation is lexicographic, so a component named
> `tables` would sort *after* `styles/quote.css` and override it.

---

## What has LANDED

### Phase 0 — the include mechanism (`api-cloudrun` `078e87c6`)

- `renderTemplate(source, ctx, namespaces, partials?)` registers each content-map
  key under `@`. **Per call, never the module global** — `loadTemplate` writes an
  instance-scoped `Cacher`, so a shared store lets a published render and a draft
  whose `partials/shared/*` copy has forked race on one key, later registration
  winning for both.
- Registered for the **body, footer, header and filename**; **not the layout**,
  whose context is `{doc, body, styles}`.
- `validateIncludeTargets` runs beside `validateEtaSources` in `gateDraftContent`.
  **The compile gate is structurally blind to a bad include** — `eta.compile()`
  builds the function without executing it — so this is the independent property
  beside the fixed-point one. It 400s on a missing key (naming near matches), the
  sync `include`, a **missing `@` even when the file exists**, and a computed
  name.
- `assembleOverlay` moved to the db-free `src/lib/templates/overlay.ts` so the one
  seam production and the gate share can be unit-tested without live Firestore.
- **#635 closed** — the gate fetched no partials, so the shipped
  `partials/shared/footer.eta` was ungated.
- **#608 closed for the default state** — `renderGoldenHtml` passed `params: {}`,
  which coincides with a `false` default and diverges from every other.
  `resolveGoldenParams` reads the sidecar through core's `resolveRenderParams`.

### Phase 0 — the gate fetches what production publishes (`api-cloudrun` `acf4c171`)

The gate built its own list of a family's render inputs; production builds the
same list in `ownsTemplatePath`. They had already drifted: the gate globbed
**every `styles/*.css` in the repo** where production takes `styles/base.css`
plus the family's own.

⚠️ **That was a latent cross-family corruption timed to fire on Phase 2.** The
moment `styles/invoice.css` lands, every quote golden renders with `invoice.css`
and every invoice golden with `quote.css` — and `styles/quote.css` opens
`html { font-size: 9px }` and carries `body`, `table`, `th, td`, `h1`, `h2, p`,
`hr`, `.wide`, `.capitalize`, `.bold`. Sheets concatenate lexicographically, so
`quote.css` sorts last and wins: **the invoice's goldens would have been blessed
at the quote's root size.** Invisible as a `diff`, too — golden and candidate
both render through `goldenRender.ts`, so they would agree with each other and
disagree with the customer's PDF.

The gate's set **is** `ownsTemplatePath` now, stated as a delegation.

### Phase 0 — the harness and the lints (`templates` PR #142, green)

- `scripts/preview.ts` registers `partials/shared/**` + `partials/<name>/**` under
  `@`. **Two Eta instances**: document surfaces get partials, the LAYOUT does
  not, because production registers none there.
- `preview:watch` watches `partials/` — it did not, so editing the shared footer
  triggered no re-render at all.
- **templates-lint's PII scan gains `partials` as a root.** It had never had one,
  while money-lint has walked `partials` all along — and it is the worst root to
  omit, because `partials/shared/**` is overlaid onto every family.
- Guards the component-stylesheet read (a component need not ship CSS).

### Phase 0b — the shared sub-interface (`core` `97ac103`, PUSHED)

`getDestinationsLegend`, `isSameAsDeliveryDates`, `orderHasDiscount`,
`orderHasRentals`, `orderHasTax` re-exported from `utils/invoices.ts`. Verified
by compile, not inspection: the predicates take `LineItem` (the structural
supertype every `InvoiceDocItemType` member satisfies),
`InvoiceDocDestinationType` **extends** `DocDestinationType`, and an invoice
destination's `dates` is the same `OrderDocDates`.

Three ratchets in `tests/template-helpers.test.ts`: both namespaces export the
set; each pair is the **same function object** (a name check alone stays green
against a drifting hand-written copy); and every real family resolves to a
namespace list containing one that carries the whole set. Catalogue regenerated
(`it.invoices.*`: 13 → 18).

**Pushed 2026-08-26**, superseding the earlier decision to hold it: Phase 2 is
the consumer that justified publishing, exactly as planned. `templates/invoice.eta`
calls all three `orderHas*` predicates through `it.invoices`, which only carries
them from **beta.270**.

⚠️ **It is pushed but NOT PUBLISHED** — the Actions outage stopped the Release
workflow, so JSR is still serving `beta.269`. See § Blocked on for the bump
sequence. Local verification of the invoice was done by temporarily resolving
`@cfs/core` from the sibling checkout and reverting `deno.json` afterwards.

### Phase 1a — the body extraction (`templates` branch `feat/shared-chrome-partials`)

`quote.eta` 961 → 616 lines. `base` grows from 3 files to 7:

```
layouts/base.eta                (unchanged)
styles/base.css                 (unchanged — see Phase 1b)
partials/shared/footer.eta      (templates#140)
partials/shared/letterhead.eta  ← #logo + #bill-to + #cfs
partials/shared/destinations.eta
partials/shared/items-grid.eta
partials/shared/totals.eta
```

**`letterhead` is one partial, not the two the original plan listed.** The DOM
decides: `#logo`, `#bill-to` and `#cfs` are three siblings of `#grid-wrapper` in
that order, and `#bill-to` sits *between* the two blocks that are purely ours.

⚠️ **VERIFIED BYTE-IDENTICAL across 29 renders** — 14 fixtures × both param
states, plus `TZ=UTC evening-boundary`. That is the primary evidence and it is
deliberately not the golden gate: `comparePng`'s threshold is a **0.001
whole-page ratio**, and templates#137 measured four `main` goldens reading
`match` while stale. A pure refactor should need no re-bless at all, and this one
does not.

The technique that made byte-identity reachable: each partial **destructures its
props into the same local names** the body used, so every moved line is
unchanged. Only four lines differ from what was cut — the two namespace calls
(`it.orders.X` → `u.X`), the banner span source, and the destination-banner gate
becoming `showDestinationBanners`.

⚠️ **One whitespace trap, documented in `totals.eta`.** Eta's `autoTrim` slurps
the newline AFTER a tag but keeps the indentation BEFORE it, so an indented loop
that runs zero times still emits its own indent — the `extraRows` loop shifted
`</tbody>` six spaces right on every quote. Its two tags sit at column 0 for that
reason; do not "fix" the indentation.

**`money-lint.yml` had to become comment- and string-aware, and this was not
optional.** Rule 3 keys on a `*`/`/` beside a money-named identifier, so
`includeAsync("@partials/shared/totals.eta", …)` reads as `/totals` — meaning no
shared partial could ever be *named for the thing it renders*. And Rule 2 had no
comment handling at all, so a docblock explaining *"fails CI on `.divide(`"*
reported three non-closed operations. Both fixed: string literals are stripped
before Rule 3 (a `/` inside a string is never arithmetic) and `<%/* … */%>`
blocks are skipped for Rules 2 and 3 (a comment cannot compute). **Verified the
guard still fires** on planted raw arithmetic, on a planted `.divide(`, on
arithmetic sharing a line with a string, and on the down-ratchet.

---

## Blocked on

**One thing, and it is an outage.** GitHub Actions has been in `major_outage`
since 15:11 UTC 2026-08-26, so `core`'s Release workflow never ran and
**`@cfs/core@10.0.0-beta.270` is not published**. `templates/deno.json` still
pins `beta.269`, where `it.invoices.orderHasDiscount` does not exist — so
`templates/invoice.eta` would throw at render. When Actions recovers:

1. confirm `beta.270` on JSR (the commit is pushed: `core` `97ac103`)
2. bump the pin **by `sed` over the version string** in `templates/deno.json`
   (**eight exact-pinned entries** — `schemas`, plus `utils/` × `orders`,
   `invoices`, `dates`, `icons`, `money`, `templates`, `citations`), and in
   `api-cloudrun/deno.json` + `manager/package.json` in lockstep
3. `deno install` / `npm install` so the lockfiles match

⚠️ **REGISTERING THE FAMILIES IS NOT A MANUAL STEP, and this doc said twice that
it was.** Merging a PR that ADDS `templates/<git_path>.meta.json` registers the
family and publishes v1 — `classifyAffected` puts a sidecar with status
`"added"` into `structural.registered` (`affected.ts:229`), and
`publishResolvedTemplates` creates the family doc when the `git_path` query
comes back empty. Verified against the test that already covers it
(`tests/integration/templates/publish.test.ts:255`): family doc created,
`uid_active` set, `semver 0.1.0`, thread cowritten, and
**`depends_on.components` resolved from the sidecar's slugs**.

`params` come from the sidecar too, on that same path
(`publishFromMerge.ts:1060`, *"a git-first register/publish takes them from the
merged sidecar"*). ⚠️ **The templates skill still carries a stale
"register-on-merge `params: []`" note** — untrue since `af6469be` (2026-05-24),
which fixed it and shipped the test at `publish.test.ts:305`. That note is what
made this plan believe the manager was the only door. Correct it in the
api-cloudrun change that retires the invoice placeholder.

So `POST /templates` / `.../fork` stay non-MCP for the reason they always did —
a `git_path` is permanently reserved and the source/target collections are
immutable, which is a decision rather than a mechanical step — but the decision
is expressed by **merging the sidecar**, which is already a human authorisation.

⚠️ `starterSidecar` omits `depends_on` when the slug list is empty, which
publishes a family with **no layout**, and every render then fails **409
`FAILED_PRECONDITION`** (`PreconditionError`, not a 422). That only bites the
manager/fork route; the sidecar committed here declares
`depends_on: { components: ["base"] }` explicitly. If a family is registered
without one anyway, `templates_set_metadata` sets it after the fact — it opens a
`meta/*` PR and leaves it OPEN, because the change is visual.

**Cleared 2026-08-26:**

- ~~`api-cloudrun` prod deploy~~ — `v0.185.0` carries `078e87c6` + `acf4c171` and
  is live on revision `api-cloudrun-00294-btn`. A `main`-based templates PR now
  hits a prod API that fetches partials.
- ~~ADC expired~~ — re-authenticated; the full suite ran green on the push
  (1867 + 7 + 1). ⚠️ The first push was REJECTED by the pre-push hook, which
  reported *"a real test failure, not a flake"*. It was a flake: every test
  passed and the failure was the post-run cleanup sweep losing a TLS socket to
  Firestore after 10m48s. It runs in 16–23s once its backlog is clear, and the
  hook's serial retry reproduces the slow sweep rather than distinguishing it.
- ~~The MCP metadata gap~~ — api-cloudrun#684, see below.
- ~~Registering the families~~ — never was a blocker; see above.

---

## Phase 1b — the CSS promotion — **DONE** (`templates` `7363e10`)

41 rules moved out of `styles/quote.css` into `styles/base.css`: the page grid,
the two alignment edges, the letterhead, the table chrome, and
`#details`/`#destinations`/`#items`/`#totals` — the four sections every document
body now assembles from `partials/shared/**`. `quote.css` 458 → 98 lines,
`base.css` 59 → 537, `invoice.css` ~430 → 29.

**What forced it.** `styles/invoice.css` landed as a ~430-line copy of
`quote.css`, because a family is overlaid from `base.css` plus its OWN sheet and
nothing else (`ownsTemplatePath`). The duplication was the argument.

**What made it verifiable**, having been deferred once as unverifiable. A CSS
move cannot be checked the way the rest of this campaign was — the concatenated
stylesheet IS in the rendered HTML, so any move shows in an HTML diff, and a
diff showing the same rules reordered says nothing about the cascade. The golden
gate cannot settle it either (0.001 whole-page threshold, templates#137), and
there is no local rasterizer.

**Make the move order-preserving, then check that directly.** Sheets concatenate
`base.css` then `<family>.css`, so appending the rules to `base.css` **in their
existing relative order** leaves the concatenated sequence untouched except for
one rule — the quote's `html` font-size, which now follows the moved block
instead of preceding it. Nothing in the block targets `html`.

Every other pair whose relative order flipped was enumerated mechanically (7),
and each cleared by **selector-subject disjointness**: `h1` vs `html`,
`th, td` vs `#cfs`, `#totals` vs `#information` — different element names or
different ids, so they can never match one element and their order cannot
matter. Zero residual pairs.

Then measured:

- all 14 quote fixtures × both param states + `TZ=UTC evening-boundary`, before
  and after: the document body **excluding the `<style>` block is
  byte-identical across all 29**
- the stylesheet lost no declaration and invented none
- of 111 `(selector, property)` cascade keys, **0 winners changed** — and 27 of
  those keys are declared more than once, i.e. are exactly the ones where source
  order decides

⚠️ **Keep the property.** Adding a rule to `base.css` that targets something a
family sheet also targets, at equal specificity, silently moves the winner.
Prefer a new selector over widening one of these. A root font size stays with
the family — `base.css` keeps only the 10px global default, and both
customer-facing families opt down to 9px in their own sheet.

---

## Phase 2 — the `invoice` family — **AUTHORED** (`templates` `bc184d6` + `658bc13`)

On branch `feat/invoice-family`, stacked on the Phase 1 branch. Not yet a PR:
merging it against the `beta.269` pin would register a family whose body throws
at render.

`templates/invoice.eta` (261 lines), `templates/invoice.meta.json`,
`styles/invoice.css` (29 lines). The body is preamble plus four
`includeAsync` calls — letterhead, destinations, items-grid, totals — so the
invoice renders the same 6-to-9 column grid as the quote from one copy of it.

**The three schema differences, each handled rather than assumed:**

- **No `price.replacement_cents`** → no Replacement Costs table, and money-lint
  `RAW_BUDGET` **0**. ⚠️ Both of `quote.eta`'s two budgeted raw-arithmetic sites
  live in `replacementLine`; do not move that function into a shared partial.
- **No `zero_priced`** → the hide-components param tests
  `price.base_cents === 0 && componentDepth > 0`. Testing the order's flag would
  make the param a silent no-op on every invoice.
- **Three divider levels** `[order, destination, group]` → named once, in
  `isDivider`. Everything downstream works off "is this uid a divider" rather
  than a path LENGTH, which is why `componentDepth` is correct at both depths.
  Verified on prod invoice 2390: its zero-priced component sits at path depth 5
  and resolves to component depth 1.

**Settlement is rollups and cannot be otherwise.** `payments[]` was deleted
2026-08-03 and `InvoiceSchema` is a `z.strictObject`. Amount Paid / Credits
Applied / Amount Due go in as `extraRows`, formatted by the caller because a
shared partial cannot know what `?? 0` means for a field it cannot see. Credits
are omitted at zero — "$0.00 credited" states an absence as a fact.

⚠️ **The order banner is CONDITIONAL** (`number_orders.length > 1`), corrected
from an earlier always-shown design. Per Alex: **multi-order invoicing is a
manager feature that does not go live until after the CRMS cutover.** Measured
2026-08-26, `number_orders` is 0 or 1 across the 200 most recent prod invoices,
so an unconditional banner would put a redundant `Order #1004` row on every
invoice we produce. Both banners now share one principle: a divider naming the
only member of its level is noise.

**Per-order subtotals are deliberately NOT built.** Their whole purpose is
disambiguating a multi-order invoice, which cannot exist until after cutover,
and they would need a hook in the shared items-grid for a case nothing can
currently produce. Add them with the manager feature.
`it.invoices.getOrderScopedItems(items, orderDividerUid)` is the scoping
primitive; sum stored `price.total_cents` and **do not recompute** — integer
addition is closed.

**Verified locally** against three fixtures shaped from prod invoices 2390 and
2364 (identity fields replaced, uncommitted):

- 2390: 7 columns; the em-dash on the taxed zero-priced row — a $0.00 unit price
  and subtotal beside a real $12.00 charge
- param ON: the row hides and its $12.00 rolls onto the parent (Tax
  $40.95 → $52.95, Total $430.95 → $442.95) while `#totals` still reads $442.95
- 2364: Amount Paid $196.25, Credits Applied $25.00, Amount Due $110.25
- two-order variant: both order banners, both destination banners, `#details`
  pluralising to "Order Numbers: 1004, 1005"
- the rendered stylesheet carries the page grid and `--label-col` from
  `base.css` and no `#replacement-costs` rule

### What is left for Phase 2

**Fixtures.** 1,020 prod invoices — capture, never hand-write
(`templates_capture_fixture` → `applyPii`). Each `description` must say what it
covers that no sibling does. Minimum set: a `part_paid` (**#2364**), one with
credits, a foreign billing address, the 6-column floor, the 9-column ceiling,
and **#2390** for the flat-tax zero-priced component. ⚠️ **A multi-order fixture
cannot be captured** — none exists in the corpus — so if that shape is ever
wanted it must be hand-built and say so, like `multi-dest` on the quote.

⚠️ **Golden parity is lint-enforced** (templates#135) once a family has
GRADUATED on a branch. It fails *open* before graduation, so land the whole
fixture set before the first bless rather than incrementally after.

**Then retire the placeholder.** Add `getInvoiceTemplateUid()` beside
`getQuoteTemplateUid()` (`collection_source == "invoices"`,
`collection_target == "invoices"`, prefer `git_path === "invoice"` — the deployed
composite index already serves it), point `invoicePdf.ts` at `renderDocument`,
and **delete `api-cloudrun/src/lib/templates/invoice.ts`**. Deleting beats a
fallback: both compile, only deletion makes its call site a compile error. Fix
the stale register-on-merge `params: []` note in the templates skill in the same
change.

## Phase 3 — the `packing-list` family

⚠️ **The packing list is rendered by CRMS today.** `processOrderDocs` renders it
in CRMS, uploads to Uploadcare and writes `orders/{uid}/documents/packing-list`;
`GET /packing-list?number=` redirects to the signed CDN URL. This family is a
**CRMS-elimination deliverable** and needs a render+upload service mirroring
`services/quotes.ts` — more work than the invoice, which already has its PDF
plumbing.

Sidecar: `collection_source: "orders"` (there is no `fulfillments` source — the
enum is `orders | invoices`), `collection_target: "packing_lists"`,
`surfaces: ["fulfillment"]`. It gets `it.orders`, same as the quote.

**The leg param.** `it.orders.groupByDestination(items, destinations, …)` already
returns `packing_list_delivery` (`rental` + `sale`) and `packing_list_collection`
(`rental` only) per destination. ⚠️ **`TEMPLATE_PARAM_TYPES` is `["boolean"]`**,
so the selector is a boolean (`collection_leg`, default `false`), not an enum.

**It does not share the items grid.** `buildPackingList` returns
`{uid, name, type, quantity, stock_method, group_name}` — **no price at all**.
Four columns, no money, no conditional columns. It shares the letterhead,
destinations, footer and the stylesheet, and nothing else.

⚠️ **This family forces #608's open half.** Its leg param is not cosmetic — the
collection list is half the document's purpose — and at a `false` default that
half can never be golden-compared. `resolveGoldenParams` gates the DEFAULT state
only. Decide whether a fixture may declare a second golden at a non-default param
state; do not just apply a one-line fix.

---

## MCP surface — LANDED 2026-08-26 (api-cloudrun#684)

All three items below shipped. `/mcp/templates` now exposes **18** tools and
carries a connect-time `instructions` blob stating the lifecycle chain and the
sidecar's one-writer-per-section table.

- **`templates_set_metadata` → `PATCH /templates/{uid}/metadata`.** The **only**
  writer for `depends_on` and the entire `render` block, and the reason Phases
  2–3 could not be finished by an agent at all. ⚠️ Both arguments **REPLACE
  WHOLESALE** — read the current block from `templates_read` → a version's
  `content["templates/<git_path>.meta.json"]` and send it back whole. Its
  `render` argument reuses the render lib's own `RenderConfigSchema.strict()`,
  so an unknown key is refused by the tool rather than 400'd by the route.
  ⚠️ A `depends_on`/`render` change is **visual**: the PR is opened and LEFT
  OPEN with `merged: false`. **That is success — do not retry**; a human merges
  it. `name`/`surfaces` auto-merge when green.
- **`templates_list_components` + `templates_read_component`.** ⚠️ **This turned
  out to be an API change, not an MCP-only one, and the note it replaces had the
  reason wrong.** `resolveFamily` does fall through, so the *lifecycle* verbs
  always worked on a component uid — but there was **no GET route for components
  at all** (`GET /template-components` and `/{uid}` did not exist; only `POST`
  did), because the manager reads them straight from Firestore. Both routes are
  now live under `templates.read`, and the autogenerator surfaces them on
  `/mcp/cfs` as well. They deliberately do **not** fall through to the template
  reads: a component family carries no `collection_source`/`surfaces`, so a
  caller that got one back from `GET /templates/{uid}` would read it as a
  template. A template uid is a 404 here and vice versa.
- **`templates_rebase_draft` → `POST /templates-versions/{uid}/rebase`.**
  ⚠️ Content is adopted only when the draft is **clean** — a dirty draft gets
  `content_refreshed: false` and its next commit writes base's changes back out.
  **Commit first, then rebase.**

🔴 **NARROW EVERY FAMILY READ.** Verifying the above against deployed dev turned
up a live defect and it is fixed in the same change: `templates_read` and
`templates_read_component` return every version a family has ever had with its
whole content map, so an unnarrowed call is **over the response cap and returns
NOTHING** — `quote` measured 3,303,497 characters, `base` 106,083. Pass
`uid_version` (`templates_list` / `templates_list_components` → `uid_active`, or
a `draft_uids` entry) **and** `paths`. The sidecar you must read before replacing
it is `paths: ["templates/<git_path>.meta.json"]`.

**Three deliberately absent — do not add:** `templates_merge` (merging *is* the
publish authority), `bless-golden` (**approving the renders is the human
authorization** the lifecycle protects), and `POST /templates` / `.../fork` (a
decision, not a mechanical step). Nothing that landed weakens open-PR-only:
every new verb either opens a PR a human merges, or reads.

---

## Verification recipe

Three techniques, each earning its place because the golden gate cannot do the
job (templates#137: a 0.001 whole-page threshold reported `match` for four stale
goldens).

**1. The exact HTML diff — for a markup refactor.** `deno task preview quote
<slug>` over every fixture, both param states, plus `TZ=UTC` for
`evening-boundary`; diff the HTML. Anything beyond whitespace is a bug, not a
re-bless. This is what proved the Phase 1a extraction across 29 renders.

**2. The server-path render — stronger than the harness.** The harness *mirrors*
production; this drives it. Read each tree's owned blobs out of git through
`ownsTemplatePath`, then `assembleOverlay` → `resolveNamespacesFromSidecar` +
`resolveGoldenParams` → `renderGoldenHtml` — the exact chain `runGoldenDiff` and
`rebless-goldens.ts` use — and compare. It is what confirmed the gate would pick
the new partials up (1 → 5) before any of it deployed.

**3. Cascade equivalence — for a stylesheet move.** An HTML diff cannot help,
because the stylesheet is IN the HTML. Make the move order-preserving, enumerate
the pairs whose relative order flips, clear them by selector-subject
disjointness, and then assert two things over the rendered output: the body
excluding `<style>` is byte-identical, and no `(selector, property)` **cascade
winner** changed. Count how many keys are declared more than once — those are the
only ones order can decide — and report it, or the check looks stronger than it
is. This is what made Phase 1b landable after being deferred as unverifiable.

Also: **render a real PDF and look at it whenever a `render.footer`/`header`
partial changes.** Neither gate covers that frame — the golden gate screenshots
the body only, and `preview` inlines the footer *below* the body where its
`<style>` leaks onto the whole page. templates#137 tracks closing it.

⚠️ **A local override is fine for verifying against unpublished core, but revert
it.** Point `templates/deno.json`'s `@cfs/core` entries at `../core/src/...`,
render, restore. Leaving it committed would make the harness diverge from the
API, which is the one thing this repo's preview exists not to do.

## Context recommendation

**CLEAR CONTEXT.** Phases 0, 0b, 1a and 1b are landed or committed; Phase 2 is
authored and locally verified. This doc carries every load-bearing fact from all
of them, and the remaining work is mechanical and gated on an outage: publish
`beta.270`, bump four pins, merge three stacked branches in order, then capture
the invoice fixture set.

**The merge order matters and is not obvious:** `feat/shared-chrome-partials`
(#144) → `feat/invoice-family`. ⚠️ **Do not merge with `--delete-branch` while
another PR is stacked on it** — deleting the base auto-closes the stacked PR, and
GitHub then refuses to reopen it even once the ref is restored. That cost #143,
which had to be reopened as #144.
