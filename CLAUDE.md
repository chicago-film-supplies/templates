# CLAUDE.md

## Overview

HTML/Eta templates rendered server-side (via `api-cloudrun`) into PDFs using Gotenberg.

**Git-canonical.** Git is the source of truth for template *content*; Firestore is a rebuildable projection (family doc + `templates-versions`). This repo is the canonical content store and an ad-hoc local-dev/preview harness; the production editing surface lives in `manager/`.

## Repo layout (sidecar + convention)

```
templates/<name>.eta        document body partial (rendered with `it`)
templates/<name>.meta.json  sidecar: display_name, collection_source/target, surfaces[], depends_on.components[], params[]
layouts/<name>.eta          component layout skeleton (wraps the body via `it.body`, injects `it.styles`)
styles/<name>.css           per-template OR per-component stylesheet
```

Render = overlay(template content ∪ each `depends_on.components` component's active version). The renderer concatenates the component `styles/*.css` (in `depends_on` order) followed by the template's own `styles/<name>.css`, renders the body, then injects body + styles into `layouts/base.eta`. `scripts/preview.ts` performs the same overlay locally.

`display_name` lives in the sidecar (renames are metadata-only PRs), keeping the Firestore family doc fully rebuildable from git.

## LLM Reference Docs

Fresh copies of framework documentation are fetched on session start into `.claude/docs/` (gitignored). When working with templates, consult the relevant docs before relying on memory:

- `.claude/docs/eta.txt` — Eta v4 template engine (syntax, API, config). **Read this whenever working on template syntax, tag usage, or helper access.**

Run `deno task fetch-llms-docs` to refresh manually.

## Template Context

Templates receive data via `it`:

- `it.doc` — the source document (e.g., an Order)
- `it.version` — version number or `null` for drafts
- `it.now` — **frozen** render timestamp (ISO string). Use this for "today" — never `new Date()` (non-deterministic output breaks golden diffs)
- `it.logo` — inline SVG logo markup
- `it.dateFns` — full date-fns library (parseISO, format, isSameDay, etc.)
- `it.currency` — currency.js for formatting currency values
- `it.orders` — `@cfs/utilities/orders` (orderHasRentals, orderHasDiscount, orderHasTax, isPreTaxItem, calculateReplacementTotals)
- `it.dates` — `@cfs/utilities/dates` (formatChargeDays, countCfsBusinessDays)

## Eta Syntax

- `<%= expr %>` — escaped output
- `<%~ expr %>` — raw/unescaped output (use for HTML)
- `<% code %>` — logic (if/for/const)
- Auto-escaping is enabled by default

## Order Data Shape (for quotes)

Key paths available on `it.doc`:

- `number`, `status`, `reference`, `subject`, `notes`
- `organization.name`, `organization.billing_address` (street, street2, city, region, postcode, country_name)
- `dates.delivery_start`, `dates.delivery_end`, `dates.collection_start`, `dates.collection_end`, `dates.charge_start`, `dates.charge_end`, `dates.days_active`, `dates.days_charged`
- `customer_collecting`, `customer_returning`
- `destinations[]` — each has `delivery` and `collection` endpoints with `address`, `contact`, `instructions`
- `items[]` — mixed types:
  - Line items (type: rental/sale/service/surcharge/replacement/custom): `uid, name, description, quantity, price { base, replacement, chargeable_days, formula, subtotal, subtotal_discounted, discount { rate, type, amount }, taxes[], total }`
  - Group dividers (type: "group"): `uid, name, description`
  - Destination dividers (type: "destination"): `uid, name, uid_delivery, uid_collection`
- `totals` — `{ subtotal, subtotal_discounted, discount_amount, taxes[], transaction_fees[], total }`
- `tax_profile` — "tax_applied" | "tax_exempt" | "reverse_charge"

## Price Field Meanings

- `price.base` — unit price (daily/weekly rate)
- `price.subtotal` — formula-applied amount: `base × (chargeable_days / 5) × qty` for five_day_week, `base × qty` for fixed
- `price.subtotal_discounted` — subtotal after discount applied
- `price.total` — the actual line charge: `subtotal_discounted + sum(taxes)`
- `price.replacement` — replacement cost per unit (only on rentals)

**Known bug**: `getDaysFactor` in `@cfs/utilities/orders` does not enforce a 1-week minimum for five_day_week formula. Rentals < 5 days get a multiplier < 1 (e.g., 2 days = 0.4×) when the minimum should be 1. This causes `subtotal` to be less than `base` for short rentals.

## Template Context Limitations

- No `isEqual` / deep comparison available — use `JSON.stringify(a) === JSON.stringify(b)` as workaround
- No `isLineItem` utility — use `item.type !== "group" && item.type !== "destination"` to filter line items
- `isPreTaxItem` excludes transaction_fee items from price calculations

## Conditional Column Hiding Pattern

Hide table columns when data is irrelevant (follow the pattern from OrderItems in manager):

- Hide "discount" column if `!it.orders.orderHasDiscount(lineItems)`
- Hide "duration" column if `!it.orders.orderHasRentals(lineItems)`
- Hide "tax" column if `!it.orders.orderHasTax(lineItems)`
- Hide "replacement" column if `!it.orders.orderHasRentals(lineItems)`

Use `<% if (condition) { %>...<% } %>` to conditionally render `<th>` and matching `<td>` cells.

## Style Guidelines

- Templates contain only HTML markup (no `<style>` blocks) — styles are managed externally
- Use semantic table markup (`<table>`, `<thead>`, `<tbody>`, `<th scope="col">`)
- Use `currency(value).format()` for all monetary values
- Use `it.dateFns.format(it.dateFns.parseISO(isoString), 'pattern')` for dates
