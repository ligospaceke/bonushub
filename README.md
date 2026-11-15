# BonasHub v2

Multi-vendor B2B marketplace: buyers, approved sellers, quotations, M-Pesa and card payments, commission, settlements and an audit trail.
Cloudflare Worker + D1 (SQLite) + vanilla JS. No frameworks, no build step.

**Status: the backend is complete and tested (20 tests). The frontend is not built yet** and is waiting on the original BonasHub theme (see "Frontend" below).

## Run it locally

```bash
node -v                # needs Node 22.13 or newer
npm run seed           # demo sellers, products and a buyer (local only)
npm run dev            # http://localhost:8787  (API under /api)
npm test               # 20 tests: money, commission, state machine, full buyer-to-seller journey, security attacks
```

Demo logins (password `Demo-pass-12345`): `owner@bonashub.local`, `rift@demo.local`, `savanna@demo.local`, `build@demo.local`, `buyer@demo.local`.
Payments run on a **sandbox gateway**: after "paying", a simulated page approves or declines, exactly like an M-Pesa prompt would.

## What is built

| Area | Done |
|---|---|
| Accounts | Buyer, seller and admin accounts; seller approval workflow (pending, approved, rejected, suspended); staff roles (owner, finance, catalogue, support); consent recorded at registration; email/phone verification codes |
| Catalogue | 10 launch categories, editable by admin without code; products with specs, MOQ, stock, fixed price or quotation; product approval; edits to content go back for review |
| Cart and checkout | Server-side pricing (the browser never sets a price, total or commission); one parent order with a sub-order per seller; BH-2026-000001 references; atomic stock reservation; idempotent checkout |
| Quotations | Request, seller reply with price and validity, accept converts once into an order at the quoted price, expiry enforced |
| Payments | Provider adapter; an order is marked paid **only** after the server asks the provider what really happened (webhooks just trigger that check); forged and replayed callbacks tested |
| Commission | Rate chosen per line at order time and stored (admin override, then Founding 3% for 6 months, then category, then default 5%); calculated on product subtotal only; proportional reversal on refunds; history preserved |
| Fulfilment | All 11 statuses with who may move each; tracking reference, proof of delivery, buyer confirmation, disputes; unpaid orders expire and return stock; unconfirmed deliveries auto-complete |
| Refunds, settlements | Buyer request, admin decision (full or partial), automatic refund when a seller rejects a paid order; admin-managed settlements with payout reference |
| Books | Append-only ledger that always balances (tested after every scenario); append-only status history, payment events and audit log (database triggers); hash-chained audit log with a verify endpoint |
| Admin | Overview analytics, orders, payments, refunds, sellers, products, categories, commission and settings, staff, audit; sales report as JSON and CSV (opens in Excel) |
| Security | PBKDF2 password hashing, HttpOnly SameSite sessions, role and staff-permission checks on every route, rate limits, cross-site request check, server-side validation, security headers |

## Decisions I made that you should confirm

These are business rules the brief left open. Each is one setting or one line to change.

1. **Commission becomes earned when the sale completes** (buyer confirms delivery, or automatically after 7 days with no dispute). Before that it is "accrued" and shown separately.
2. **Settlements are payable 7 days after completion** (a dispute window), and never while a dispute is open. Adjustable in settings.
3. **Delivery charges go to the seller and carry no commission.** Delivery is a flat fee per seller (or negotiated for quotations).
4. **Founding Seller and negotiated rates never stack.** The admin override always wins and needs a written reason. Founding places go to the first 50 approved sellers; the admin can decline it for a seller.
5. **Sellers see the buyer's contact and address only after payment is confirmed.**
6. **Refund after a seller was already paid** is recorded and flagged for the admin to recover from the seller's next settlement. Recovery is manual for now.
7. **VAT** is a single setting (default 0%). How tax applies to your sellers' invoices needs your accountant.

## Not built yet, and what each needs

- **Frontend.** Waiting on your original theme source (below).
- **Real payments.** The sandbox stands in for a provider. For M-Pesa you need a Safaricom Daraja account with a Paybill or Till, then an adapter in `src/payments/` (the interface is documented in `src/payments/index.js`). For cards, choose a provider. Set `SANDBOX_ENABLED=false` before going live.
- **Holding money for sellers is a regulatory question, not only a technical one.** As far as I know, receiving and passing on funds for third parties can count as a payment service in Kenya and may need Central Bank of Kenya authorisation, or use of a licensed provider that supports split payments or escrow. Please take this to a lawyer and your payment provider before launch. Until then the design keeps payouts as **administrator-recorded settlements**, as your brief allows.
- **Email and SMS.** Messages are queued in the `outbox` table and shown in-platform; no sending provider is connected. Because of that, verification is supported but **not enforced** at checkout (enforcing it would lock real users out).
- **Document and image uploads.** Seller documents are recorded as metadata and product images as web addresses. Files need private object storage (R2 or Supabase Storage) with signed links.
- **PDF and native Excel reports.** Reports export as CSV (opens in Excel). A printable report page for "save as PDF" is planned with the frontend.
- **Staff two-factor sign-in, data export and erasure requests, and ODPC registration.** Needed for Kenya's Data Protection Act. Consent is recorded and personal data is limited to what the brief lists; the rest needs a short compliance review.
- **Password hashing strength.** Workers cap PBKDF2 at 100,000 iterations. Rate limiting is in place to compensate; staff two-factor would close the gap.
- **Unverified on real Cloudflare.** Everything is tested on a local SQLite stand-in for D1. Staging deployment will confirm batch size limits (carts are capped at 25 lines to stay safe).

## Deploy to staging

```bash
npx wrangler d1 create bonashub                      # paste the id into wrangler.toml
npx wrangler d1 migrations apply bonashub --remote
node scripts/create-admin.js you@example.com "Your Name"   # prints SQL; run it with: npx wrangler d1 execute bonashub --remote --command "<SQL>"
npx wrangler secret put PAYMENT_WEBHOOK_SECRET
npx wrangler deploy
```

Backups: D1 Time Travel keeps point-in-time restore; also schedule `wrangler d1 export` to storage you own, and rehearse a restore before launch.

## Frontend

The screens are designed (8 artboards approved). The look must match the **previous BonasHub site: its colours, theme loader, animations and dark/light switch**, with only the features changing. The live demo can't be opened from my environment, so I need its source (zip or repo) or screenshots. The UI will be vanilla JS views over this API, with all styling isolated in one theme file so the original look drops in.

## Layout

```
migrations/0001_init.sql   schema, append-only triggers, seed categories and settings
src/lib/                   money, commission rules, order state machine, auth, validation, permissions
src/services/              orders, payments, fulfilment, refunds, settlements, jobs, ledger, audit, notifications
src/routes/                auth, catalogue, buyer, quotes, seller, admin
src/payments/              provider adapter + sandbox gateway
scripts/                   dev server, D1 stand-in, seed, create-admin
test/                      unit and end-to-end tests
```

## Frontend (public/)

Vanilla JS ES modules, hash-routed, no build step. Served by the same Worker as static assets.

- `css/theme.css` is the **only** file that defines the look (colours, fonts, loader, animations, light/dark tokens). `css/app.css` uses those tokens only. **theme.css is currently a stand-in** (ink blue and amber, no green). To apply the original BonasHub theme, replace the variables and loader/animation rules in that one file; no view code needs to change.
- Boot loader, route progress bar, staggered entrance animations, light/dark switch (follows the system until the person chooses, then remembered), and reduced-motion support are all in place.
- `js/views/`: `public.js` (home, products, product, categories, suppliers, cart, checkout, payment), `auth.js`, `account.js` (buyer), `seller.js`, `admin.js` (role-aware navigation; the server enforces permissions), `dash.js` (shared dashboard pieces).
- Verified end to end in a real browser: browse, register/sign in, cart, checkout, sandbox payment, seller processing and dispatch, buyer completion, refund request and admin approval, ledger balanced, all admin screens, light and dark, phone width. No page errors.
- Known gaps: image upload is by web address (needs R2 or similar); a few admin actions use browser prompts for short text (reason, reference) rather than polished dialogs; Excel/PDF export is CSV and browser print only.

## Storefront layer (shop.js, shop.css)
- **Listing** `/products`: faceted navigation. The URL is the source of truth (`?category=&seller=&priceModel=&inStock=&founding=&min=&max=&sort=&q=`), Back/Forward work, counts come from `GET /api/products/facets` (disjunctive: each group is counted without its own filter). Filters sit beside the results on desktop and open as a bottom sheet (native `<dialog>`) on phones.
- **Product page**: gallery with hover zoom, lightbox, thumbnails, video and a 360 viewer (an image URL containing `{n}` plus `#frames=24` becomes a spin; arrow keys also rotate). Products without photos show their drawn illustration. Sticky buy bar on scroll.
- **Compare**: tick "Compare" on up to 4 cards, tray at the bottom, `/compare?ids=` table with sticky headers and "differences only".
- **Theming**: three tiers in `theme.css` (global, semantic, component). `[data-brand]` overrides are supported; sanitise any tenant values to hex colours and lengths before injecting.
- **Navigation**: no boxed skeleton; the old page dims and the new one fades in (opacity only).
