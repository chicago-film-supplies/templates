# Shared template chrome + the invoice and packing-list families

> **Status 2026-08-26.** Phases 0, 0b, 1a, 1b and 2 are **landed and live in
> production**. What remains is one task in this campaign (retire the invoice
> placeholder) and one whole phase that is gated on the CRMS cutover (the
> packing list). Written as one current statement; the executed phases are
> recorded by outcome, not by narrative.

## What this was for

`templates/` held one family — `quote`. Two more were wanted, an **invoice** and
a **packing list**, and all three had to keep sharing chrome as the brand
evolves. Reviewing `quote.eta` against the invoice schema turned up four facts
that decided the shape of the work; three contradicted the premise the request
was built on.

---

## The four findings, and what each became

### 1. There was no `include()` in the render pipeline

`renderTemplate` was `renderStringAsync` on a bare string against an `Eta` with
no `views`, and Eta's filesystem resolver opens `if (!views) throw`. So
`include()`, `includeAsync()` and `layout()` all threw, and `partials/**`
reached a page **only** when a sidecar `render.footer`/`header` named it.

**Built.** Eta's `@` prefix skips the filesystem branch and reads the in-memory
store `loadTemplate` writes; `config.cache: false` does not gate it.

### 2. The invoice PDF already existed in production, as a 59-line placeholder

`api-cloudrun/src/lib/templates/invoice.ts` emits three rows — Total, Amount
Paid, Amount Due — and **no items table, no bill-to, no destinations, no
taxes**. Every invoice PDF a customer has received is that document. It also
interpolates `organization.name`, `subject` and `reference` into HTML
**unescaped**.

**Still true.** The replacement family is live; pointing `invoicePdf.ts` at it is
the one task left in this campaign. See *What remains*.

### 3. `Invoice.payments[]` was deleted 2026-08-03

`totals` carries four rollups and nothing else. The per-settlement journal is a
separate `settlements` collection and a template only ever receives `it.doc`, so
an invoice **cannot** itemise settlement. `InvoiceSchema` is a `z.strictObject`,
so it cannot re-acquire a `payments` array.

**Decided: rollup lines only.** `amount_credited_cents` and `amount_void_cents`
are bare `.optional()` with no default — every read needs `?? 0`.

### 4. An invoice gets `it.invoices`, which lacked five helpers the quote used

**Fixed** by re-export (Phase 0b), with a ratchet asserting all three document
namespaces carry the same function objects.

---

## The design, in one rule each

> **A shared partial never NAMES a util namespace, and never computes a value it
> could be handed.** `it.orders` resolves for one family and `it.invoices` for
> another, so shared markup takes the namespace object as a prop (`u`).

> **One component (`base`), not several.** `LAYOUT_KEY` is the hard-coded literal
> `layouts/base.eta`; a PR touching only `layouts/other.eta` publishes nothing;
> and style concatenation is lexicographic, so a component named `tables` would
> sort *after* `styles/quote.css` and override it.

---

## What landed

| phase | where | outcome |
|---|---|---|
| 0 — include mechanism | `api-cloudrun` `078e87c6` | `includeAsync("@key", props)`; per-call `Eta`; save-time guard |
| 0 — gate parity | `api-cloudrun` `acf4c171` | the gate's fetch set **is** `ownsTemplatePath` |
| 0 — harness + lints | `templates` #142 | preview registers partials; PII scan gains `partials/` |
| 0b — shared sub-interface | `core` `97ac103` → beta.270 | five re-exports + three ratchets |
| 1a — body extraction | `templates` #144 | `quote.eta` 961 → 616; `base` 3 files → 7 |
| 1b — CSS promotion | `templates` `7363e10` | 41 rules moved; `quote.css` 458 → 98 |
| 2 — the invoice family | `templates` #146 → #148 | registered, published `0.2.1`, 7 fixtures, **7 goldens blessed** |
| — fulfillments source | `core` `7770443`+`e994d49` → beta.272 | `it.fulfillments` for Phase 3 |

Prod runs `api-cloudrun v0.186.0`; all four repos pinned to `@cfs/core@10.0.0-beta.272`.

### Three defects found on the way, each closed

- **#635** — the golden gate fetched **no partials**, so the shipped
  `partials/shared/footer.eta` was rendered by production and never by the gate.
  Repaired by making the gate's set `ownsTemplatePath` itself.
- **The cross-family stylesheet bleed** — the gate globbed *every* `styles/*.css`
  in the repo. That equals the owned set only while ONE family exists; the moment
  `styles/invoice.css` landed, `quote.css`'s `html { font-size: 9px }` would have
  won on lex order and blessed the invoice's goldens at the wrong root size.
  Invisible as a `diff`, because golden and candidate share the renderer.
- **#608 (half)** — `renderGoldenHtml` passed `params: {}`, which coincides with a
  `false` default and diverges from every other. The open half is a decision the
  packing list forces; see Phase 3.

---

## The verification recipe — the reusable part of all this

Three techniques, each earning its place because the golden gate cannot do the
job (templates#137: a 0.001 whole-page threshold reported `match` for four stale
goldens).

**1. The exact HTML diff — for a markup refactor.** Every fixture, both param
states, plus `TZ=UTC` for a boundary case; diff the HTML. Anything beyond
whitespace is a bug, not a re-bless. Proved the Phase 1a extraction across 29
renders.

**2. The server-path render — stronger than the harness.** The harness *mirrors*
production; this drives it. Read each tree's owned blobs through
`ownsTemplatePath`, then `assembleOverlay` → `resolveNamespacesFromSidecar` +
`resolveGoldenParams` → `renderGoldenHtml` — the chain `runGoldenDiff` uses — and
compare. Confirmed the gate would pick the new partials up (1 → 5) before
anything deployed.

**3. Cascade equivalence — for a stylesheet move.** An HTML diff cannot help,
because the stylesheet is IN the HTML. Make the move order-preserving, enumerate
the pairs whose relative order flips, clear them by **selector-subject
disjointness**, then assert over the rendered output: body excluding `<style>`
byte-identical, and no `(selector, property)` **cascade winner** changed. Report
how many keys are declared more than once — those are the only ones order can
decide — or the check looks stronger than it is. This is what made Phase 1b
landable after it had been deferred as unverifiable.

⚠️ **Render a real PDF and look at it whenever a `render.footer`/`header` partial
changes.** Neither gate covers that frame — the golden gate screenshots the body
only, and `preview` inlines the footer *below* the body where its `<style>` leaks
onto the whole page. templates#137 tracks closing it.

⚠️ **A local override is fine for verifying against unpublished core, but revert
it.** Point `templates/deno.json`'s `@cfs/core` entries at `../core/src/…`,
render, restore.

---

## What remains

### In this campaign: retire the invoice placeholder

The only task left in Phase 2, and the one that makes all of it reach a customer.
In `api-cloudrun`:

1. Add `getInvoiceTemplateUid()` beside `getQuoteTemplateUid()`
   (`collection_source == "invoices"`, `collection_target == "invoices"`, prefer
   `git_path === "invoice"` — the deployed composite index already serves it).
2. Point `invoicePdf.ts` at `renderDocument`.
3. **Delete `src/lib/templates/invoice.ts`.** Deleting beats a fallback: both
   compile, only deletion makes its call site a compile error.
4. Fix the stale **register-on-merge `params: []`** note in the templates skill
   in the same change — untrue since `af6469be` (2026-05-24), and it is what made
   this doc claim twice that registering needed the manager.

⚠️ **Registering a family does NOT need the manager.** Merging a PR that ADDS
`templates/<gp>.meta.json` registers it and publishes v1: `classifyAffected` puts
an `"added"` sidecar into `structural.registered` (`affected.ts:229`) and
`publishResolvedTemplates` creates the family when the `git_path` query is empty.
Verified live on `invoice` — family doc, `uid_active`, `semver 0.1.0`, thread,
`depends_on.components` resolved from the sidecar slug, and **`params` carried
from the sidecar**.

### Phase 3 — the packing list, gated on the CRMS cutover

⚠️ **Rendered by CRMS today.** `processOrderDocs` renders it, uploads to
Uploadcare and writes `orders/{uid}/documents/packing-list`. This is a
CRMS-elimination deliverable and needs a render+upload service mirroring
`services/quotes.ts` — more work than the invoice, which already had its PDF
plumbing.

Sidecar: `collection_source: "fulfillments"`, `collection_target: "packing_lists"`,
`surfaces: ["fulfillment"]`.

⚠️ **The source is `fulfillments`, decided 2026-08-26 (Alex).** A packing list
should say what was **picked**, not what was ordered, and only a fulfillment
knows the difference — a fulfillment line carries `quantity` beside
`quantity_order`, and `path_substituted_for` when a picker swapped an item. The
enum gained `fulfillments` as a **source only**; nothing produces a fulfillment
from a template. `surfaces` is a separate axis and was already right — it is
where "appears on the fulfillment page" is expressed, not what the document
reads.

⚠️ **A fulfillment always exists**: they are keyed by order uid, 1:1 with orders
(997/997 measured). There is no "before picking starts" gap, which is why a
second source is not needed — and multi-source would make the gate resolve the
UNION of namespaces, so a body calling `it.orders.*` on a fulfillment would pass
the gate and throw live, reopening the hole `availableUtilNamespaces` closed.

**It does not share the items grid.** `buildPackingList` returns
`{uid, name, type, quantity, stock_method, group_name}` — **no price at all**.
Four columns, no money, no conditional columns. It shares the letterhead,
destinations, footer and the stylesheet, and nothing else.

**The leg param.** `it.fulfillments.groupByDestination(...)` already returns
`packing_list_delivery` (rental + sale) and `packing_list_collection` (rental
only) per destination, so the split is data rather than markup.
⚠️ `TEMPLATE_PARAM_TYPES` is `["boolean"]`, so the selector is a boolean
(`collection_leg`, default `false`), not an enum.

⚠️ **This family forces api-cloudrun#608's open half.** Its leg param is not
cosmetic — the collection list is half the document's purpose — and at a `false`
default that half can never be golden-compared. `resolveGoldenParams` gates the
DEFAULT state only. Decide whether a fixture may declare a second golden at a
non-default param state; do not just apply a one-line fix.

### Open issues this campaign produced

- **api-cloudrun#688** — a family's first fixture PR auto-merges before it can be
  blessed, so the family ships ungated. Measured: templates#147 merged 23s after
  `visual-diff` said `no-golden`. **Phase 3 will hit it next.**
- **core#71** — a commit changing the public API surface can carry a
  non-releasing type and nothing notices until the version does not move.
- **api-cloudrun#608** — the params decision above.
- **api-cloudrun#627** — `applyPii`'s postcode mask is US-ZIP-only, so a foreign
  postcode renders as filler. Now frozen into **two** blessed goldens
  (`quote` and `invoice` `billing-foreign-country`); re-capture and re-bless both
  together when it lands.
- **templates#137** — the golden gate's threshold. Phase 1b landed without it by
  using cascade equivalence instead, but a CSS change still cannot be
  substantiated by the gate.

---

## Context recommendation

**CLEAR CONTEXT.** Everything landed is live and recorded above; the two
remaining pieces are independent of each other and of the history. The
placeholder retirement is a single `api-cloudrun` session. Phase 3 cannot start
until the CRMS cutover and should begin fresh against this doc.

⚠️ **Delete this doc in the PR that lands the placeholder retirement IF Phase 3
has been split into its own issue by then** — a plan that describes only
post-cutover work is better as an issue than as a plan. Until then it stays, kept
current.
