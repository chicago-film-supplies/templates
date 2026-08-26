# Shared template chrome + the invoice and packing-list families

> **Status 2026-08-26.** Phase 0, Phase 0b and Phase 1's body extraction are
> built and verified. The deploy and the MCP gap that blocked Phases 2–3 have
> both **cleared**; what remains is **one human action** — registering the two
> families in the manager — named under *Blocked on* below. This doc is written
> as one current statement rather than a stack of updates — it says what is true
> today.

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

### Phase 0b — the shared sub-interface (`core` `a0ceac4`, HELD unpublished)

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

⚠️ **The commit is deliberately NOT pushed, and that is a decision with a
reason — do not just push it to tidy the branch.** A push to `core/beta`
publishes `@cfs/core@10.0.0-beta.270` to JSR, and the workspace rule is that
every consumer's pin moves in lockstep the same day: `api-cloudrun/deno.json`,
`manager/package.json`, and `templates/deno.json` (**exact-pinned, eight entries
— `schemas` plus `utils/`×`orders`,`invoices`,`dates`,`icons`,`money`,
`templates`,`citations`; bump by `sed` over the version string, never by the
count, which has been stale twice**). `api-cloudrun`'s bump cannot be pushed
while ADC is expired, so publishing now would strand a half-done lockstep across
four repos — worse than holding one clean commit.

**Nothing consumes the re-exports until Phase 2.** Publish at the start of Phase
2, when there is one publish, one bump and one real consumer.

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

**Registering the two new families** — the only one left. `POST /templates` and
`.../fork` are deliberately **not** MCP verbs: registering permanently reserves a
`git_path` (invariant S5) and fixes the immutable source/target collections. Do
it in the manager. ⚠️ `starterSidecar` omits `depends_on` when the slug list is
empty, which publishes a family with **no layout**, and every render then fails
**409 `FAILED_PRECONDITION`** (`PreconditionError`, not a 422 — two comments in
`api-cloudrun` said 422 and were corrected in the same change that closed
api-cloudrun#684). So either fork from `quote`, or register with
`depends_on: { components: ["base"] }`.

⚠️ **If it is registered without one anyway, that is now recoverable from an
agent** rather than a trip back to the manager: `templates_set_metadata` can set
`depends_on` after the fact. It opens a `meta/*` PR and leaves it OPEN, because
the change is visual — a human merges it.

**Cleared 2026-08-26:**

- ~~`api-cloudrun` prod deploy~~ — `v0.185.0` carries `078e87c6` + `acf4c171` and
  deployed to prod (build `00b296f3`). A `main`-based templates PR now hits a
  prod API that fetches partials, so a golden for a body that includes one no
  longer fails `EtaNameResolutionError`.
- ~~ADC expired~~ — re-authenticated.
- ~~The MCP metadata gap~~ — see the section below.

---

## Phase 1b — the CSS promotion (NOT done, and deliberately separated)

~250 of `styles/quote.css`'s 458 lines are document-agnostic and are the real
carrier of the brand: the `:root` scale and `--label-col`, the `#grid-wrapper`
page grid and `--dest-block-3`, `table-layout: fixed` and the `thead th` border
chrome, `.wide`/`.total`/`.center`/`.capitalize`, the letterhead rules, and
`#details, #items, #replacement-costs thead th:not(:first-child) { width: auto }`.

**Why it is not in Phase 1a:**

1. **Byte-identity is impossible by construction.** The concatenated stylesheet
   *is* in the rendered HTML, so any move shows in the diff — and a diff showing
   the same rules in a different order says nothing about whether the cascade
   changed.
2. **The only automated check is `visual-diff`, and it cannot substantiate this
   change.** Its 0.001 whole-page threshold reported `match` for four stale
   goldens (templates#137); re-rendering an *unchanged* tree produces deltas up
   to 0.000738, the same order of magnitude. Signal and noise overlap; what
   separates them is that a real change is **contiguous**, which a whole-page
   ratio throws away.
3. **No local pixel evidence is available** — no Docker, no local Gotenberg.
4. **The mixed selectors are the hard part.** `#destinations, #items,
   #replacement-costs`, `#items th, #replacement-costs th, …` and the three-way
   `thead th:not(:first-child)` rule each span shared and quote-only ids.
   Splitting one means duplicating the selector across two files, which perturbs
   source order in ways nothing available here can check.
5. **Its benefit is realized in Phase 2**, which is blocked anyway. Without it
   `styles/invoice.css` restates some brand rules — duplication, not breakage.
   The cross-family bleed that *would* have been breakage is closed by
   `acf4c171`.

**Precondition: templates#137.** A contiguity-aware golden diff is what makes a
CSS-only change verifiable. Do that first, then promote the CSS with the gate
actually able to speak to it.

---

## Phase 2 — the `invoice` family

Sidecar: `collection_source: "invoices"`, `collection_target: "invoices"`,
`surfaces: ["invoice"]`, `depends_on.components: ["base"]`, one boolean param
`hide_zero_priced_components`, and a `render` block with four margins, `filename`,
and `footer: "partials/shared/footer.eta"`. **No `base_font_size`** — deleted in
templates#138; a template sets its own root in `styles/invoice.css`.

Body:

- **`#details`** — Invoice #, Date, **Due Date**, Order Number(s) (`number_orders`),
  Reference.
- **`#destinations`** — `includeAsync` the shared partial.
  ⚠️ **Join the pair to its divider on `destinations[].uid === item.uid`, never on
  `uid_delivery`/`uid_collection`** — those are address-book ids two sections can
  share, they move when an address is corrected, and they are being deleted
  (#662/#663 closed). The `uid` join is what makes #664 moot here.
- **`#items`** — the shared partial, with `showOrderBanner: true`. **The arm is
  already in it**: an `order` divider renders a banner that always shows, unlike
  the destination banner which is suppressed at `destinations.length === 1`. An
  invoice that bills one order still says which, because that is the question the
  invoice exists to answer.
- **Per-order subtotals** under each `order` divider — new markup, no quote
  precedent. `it.invoices.getOrderScopedItems(items, orderDividerUid)` is the
  scoping primitive. Sum stored `price.total_cents`; **do not recompute** —
  integer addition is closed.
- **`#totals`** — the shared partial plus `extraRows` (Amount Paid / Credits
  Applied / Amount Due, each `?? 0`). **The prop is already in it**, already
  formatted by the caller, because a partial that formatted them would be
  deciding what `?? 0` means for a field it cannot see.
- **No `#information`, no `#replacement-costs`.**

⚠️ `templates/invoice.eta` gets money-lint `RAW_BUDGET` **0**. ⚠️ **Do not move
`replacementLine` into a shared partial** — both of `quote.eta`'s two budgeted
raw sites live in it, and the budget ratchets both ways.

**Fixtures.** 1,020 prod invoices — capture, never hand-write
(`templates_capture_fixture` → `applyPii`). Each `description` must state what it
covers that no sibling does. Minimum set: a multi-order invoice (two `order`
dividers), a `part_paid` (invoice **#2364**: one $196.25 payment against
$306.50), one with credits, a foreign billing address, the 6-column floor, the
9-column ceiling, and **#2390** for the flat-tax zero-priced component.

⚠️ **Golden parity is lint-enforced** (templates#135): `deno task lint:fixtures`
fails on any fixture without a baseline — or any baseline without a fixture —
**once a family has graduated on a branch**. It fails *open* before graduation.
So the first bless commits the whole family to full parity in the same commit;
land the fixture set before blessing, not incrementally after.

**Then retire the placeholder.** Add `getInvoiceTemplateUid()` beside
`getQuoteTemplateUid()` (`collection_source == "invoices"`,
`collection_target == "invoices"`, prefer `git_path === "invoice"` — the deployed
composite index already serves it), point `invoicePdf.ts` at `renderDocument`,
and **delete `api-cloudrun/src/lib/templates/invoice.ts`**. Deleting beats a
fallback: both compile, only deletion makes its call site a compile error.

---

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

The exact-diff harness is the reusable part. `deno task preview quote <slug>` for
every fixture, both param states, plus `TZ=UTC` for `evening-boundary`; diff the
HTML. It is exact where the gate is thresholded, which is the whole lesson of
templates#137. Anything beyond whitespace is a bug, not a re-bless.

Also: **render a real PDF and look at it whenever a `render.footer`/`header`
partial changes.** Neither gate covers that frame — the golden gate screenshots
the body only, and `preview` inlines the footer *below* the body where its
`<style>` leaks onto the whole page. templates#137 tracks closing it.

## Context recommendation

**CLEAR CONTEXT** before Phase 2. Phases 0/0b/1a are landed or committed and this
doc carries every load-bearing fact from them. Phase 2 starts fresh against a
deployed prod API, the full 18-tool `/mcp/templates` surface, and a registered
`invoice` family — the registration being the one step still waiting on a human.
