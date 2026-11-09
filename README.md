# PayTrack — Checkout and Refund Management

A small learning project using React + TypeScript + plain CSS, Express + TypeScript, PostgreSQL (`pg`), and **PayPal Sandbox only**. Named functions, explicit SQL, ordinary loops and simple interfaces keep the business logic visible. No deployment, GitHub push or real-money integration is included.

## Start locally

Install Node.js **24 LTS** (or another supported version >=24), npm and PostgreSQL 16 or newer. Node 25 and PostgreSQL 18 were available for verification in this workspace. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Create two separate databases using pgAdmin, or PostgreSQL's `createdb` command. If it is not on PATH, use its full installation path.

```text
createdb -U postgres paytrack
createdb -U postgres paytrack_test
```

Edit `.env`: set your development database URL, a random session secret, and your chosen merchant email/password. Generate a secret with:

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```text
npm run db:migrate
npm run db:seed
npm run dev:server
```

In a second terminal:

```text
npm run dev:client
```

Open **http://localhost:5173** (use this exact origin with the default settings). The frontend proxies `/api` to Express at port 3000. PostgreSQL must be running. The merchant seed never upgrades an existing customer or changes an existing password. Use a fresh merchant email if needed. Products can be seeded without PayPal credentials; merchant creation needs a password of 12–128 characters. Public registration always creates customers.

Without PayPal credentials, accounts, catalogue, carts and local orders work. Starting checkout displays a configuration error and preserves the saved operation. After configuring PayPal, use **Check provider status** to recover creation within its safe recovery window. There is no mock checkout mode or fallback pretending payment succeeded.

## Environment variables

| Variable                                   | Purpose                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                             | Development PostgreSQL connection string. URL-encode special password characters.                                                 |
| `TEST_DATABASE_URL`                        | Separate disposable database, name ending in `_test`. Tests never fall back to `DATABASE_URL`.                                    |
| `SESSION_SECRET`                           | At least 32 random characters; signs the opaque session cookie.                                                                   |
| `APP_ORIGIN`                               | Exact browser origin, default `http://localhost:5173`; also used for PayPal return URLs and CSRF origin checks.                   |
| `PORT`                                     | API port, default 3000. If changed, update the Vite proxy too.                                                                    |
| `NODE_ENV`                                 | `development` locally. Production cookies require HTTPS and a correctly configured trusted proxy. Never use `test` outside tests. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials; server only.                                                                                        |
| `PAYPAL_MERCHANT_ID`                       | Merchant ID of the sandbox business account receiving the payment.                                                                |
| `PAYPAL_WEBHOOK_ID`                        | ID of the webhook registered for this sandbox REST app.                                                                           |
| `MERCHANT_EMAIL`, `MERCHANT_PASSWORD`      | Used only by the seed command; no built-in password.                                                                              |

Secrets belong in ignored `.env`, never in frontend `VITE_` variables. The PayPal API base URL is hardcoded to `https://api-m.sandbox.paypal.com`; there is no live switch. Currency is **USD only**. `$18.00` is `1800` internally, formatted as `"18.00"` only at the provider boundary. Catalogue illustrations are CSS drawings; no external asset pipeline is required. Google Fonts is optional, with local sans-serif fallbacks.

## Configure PayPal Sandbox

1. Sign in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/). Select **Sandbox**, not Live.
2. Under Testing Tools / Sandbox Accounts, create or select a **Business** merchant and a separate **Personal** buyer. Use test accounts with USD balances. Do not enter real payment credentials.
3. Under Apps & Credentials, create a **Sandbox REST app** attached to that business account. Copy its client ID and secret to `.env`. Find the merchant/account ID in the business account details and set `PAYPAL_MERCHANT_ID`.
4. Start both local servers. The browser return URL is `http://localhost:5173/?approved=<local-order-id>`; the server sets this on order creation. The browser return alone never changes financial state.
5. Webhooks require a publicly reachable **HTTPS port 443** URL forwarded to the local API. With your chosen local HTTPS tunnel, register `https://YOUR-TUNNEL/api/webhooks/paypal` under the **same Sandbox app**. Tunnel setup is manual; this project does not deploy anything. Never expose your PostgreSQL port. Forwarding only the webhook path is sufficient when supported by the tunnel.
6. Subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.REFUND.PENDING`, and `PAYMENT.REFUND.FAILED` where available. Store the returned webhook ID in `.env` and restart Express.
7. Register a PayTrack customer. Select products, create an order, and continue to PayPal Sandbox. Approve using the personal sandbox buyer. On return, select **Confirm payment**, then refresh/check provider status. Only a validated capture can mark the order paid.
8. Log out and log in with the seeded PayTrack merchant. Open the paid order and select **Issue full sandbox refund**. Inspect refund status and verified event history.
9. Confirm order, capture and refund IDs in the Sandbox dashboard. Exercise duplicate delivery using the dashboard's real app-event resend. PayPal's generic webhook simulator does **not** support the postback verification method used here; its synthetic events are not a substitute for app-generated events.

If your sandbox account does not support the USD PayPal-wallet flow for its region, use an eligible sandbox business/personal account pair. This project does not implement cards, shipping fulfilment or marketplace onboarding. Physical-looking catalogue products are illustrative; `NO_SHIPPING` keeps this exercise focused on payments.

## Database and state design

`server/sql/001_initial.sql` is applied once by a versioned migration runner, inside a transaction. The runner holds an advisory transaction lock so concurrent migrations do not race. It never resets a database. Seeds insert missing products and a merchant without deleting existing data.

| Table               | Purpose and important constraints                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | Unique normalized email; Argon2id hash; customer or merchant role.                                                                 |
| `products`          | Authoritative positive integer-cent price and descriptive text.                                                                    |
| `orders`            | Buyer FK, USD total, canonical cart JSON, unique `(user_id, idempotency_key)`.                                                     |
| `order_items`       | Order/product FKs; snapshot name/price; quantity 1–10; one row per product/order.                                                  |
| `payment_attempts`  | Unique order FK, provider order ID and capture ID; permanent create/capture request IDs.                                           |
| `refunds`           | Unique payment FK: at most one full refund operation; unique provider refund ID/request ID.                                        |
| `webhook_events`    | Unique provider event ID, minimal correlation identifiers and processing state, optional local order FK. No full personal payload. |
| `session`           | Opaque session IDs and JSON state; indexed expiry for session cleanup.                                                             |
| `schema_migrations` | Applied migration versions.                                                                                                        |

```mermaid
erDiagram
  users ||--o{ orders : places
  orders ||--|{ order_items : contains
  products ||--o{ order_items : references
  orders ||--o| payment_attempts : pays
  payment_attempts ||--o| refunds : refunds
  orders o|--o{ webhook_events : links
```

| Record  | States                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order   | `CREATED → PAID → REFUNDED` (verified reconciliation may discover a refund directly).                                                                |
| Payment | `CREATING → APPROVAL_PENDING → CAPTURING → PENDING / COMPLETED / FAILED`; uncertain calls become `UNKNOWN`; verified full refund becomes `REFUNDED`. |
| Refund  | `REQUESTING → PENDING / COMPLETED / FAILED`; uncertain calls become `UNKNOWN`.                                                                       |
| Webhook | `RECEIVED → PROCESSED / IGNORED / UNMATCHED`; unmatched/failed processing can be retried.                                                            |

No old pending/failed event can downgrade a completed payment or refund. Refunded orders stay refunded. Current provider state is fetched for supported webhook events; event delivery timestamps are not trusted as the ordering mechanism.

## Idempotency, concurrency and uncertain outcomes

- Order keys are scoped to the authenticated buyer. A sorted, validated cart is persisted and compared on reuse; a changed cart returns 409. Extra client totals are ignored. Prices come from PostgreSQL. Duplicate product rows and invalid quantities are rejected.
- Payment-create and capture keys are scoped to a local order; refund keys are scoped to its payment. These financial endpoints accept only empty bodies because their amount/payload is fixed by the persisted order. An unexpected body is rejected. Keys need 16–80 letters, numbers or hyphens. A different key cannot start another payment/refund for the same order.
- A user-row lock serializes local order creation; a short order-row lock reserves payment creation; an atomic conditional update claims capture; a payment-row lock reserves a refund. Unique constraints remain the final defence. Duplicate calls can return an in-progress record; refresh it.
- Each financial operation has a persisted UUID `PayPal-Request-Id`. Database-backed reservations survive server restart. Frontend session storage merely preserves convenient retry keys; it is not the duplicate-prevention mechanism.
- No database transaction is held across a PayPal network call. Reserve and commit, call PayPal, validate and save. A PostgreSQL rollback cannot undo an external capture.
- Timeout, provider error, validation failure or crash can leave `UNKNOWN`, `CREATING`, `CAPTURING` or `REQUESTING`. They must be investigated rather than described as definitely failed. The status action fetches the provider order/refund with GET and applies validated, monotonic updates.
- If order creation lost its provider ID, reconciliation waits at least one minute, then can repeat **creation only**, with the original request ID, within five hours. This conservative limit is below the Orders API's documented six-hour default retention; provider retention is endpoint-specific. Beyond that window, inspect the Sandbox dashboard instead of blindly replaying creation.
- Capture and refund POSTs are never automatically retried. If a capture remains uncertain with no capture visible, the application keeps it unresolved for dashboard review. For a lost refund ID, a verified webhook can recover it. A merchant can also enter the Sandbox refund ID and check status: the server GETs that resource, checks its local refund invoice ID, amount/currency, existing ID and capture link when supplied. It never trusts the entered ID as proof of a refund.
- Signed supported webhook delivery first stores minimal event metadata. It fetches current provider data outside a transaction, then locks the event row and commits the financial updates and processed marker together. Duplicate processed events do nothing. Unmatched events return 503 for provider redelivery. Unknown event types are saved as ignored.

## API reference

All browser mutations require the exact `Origin` and session `X-CSRF-Token`. Payment/order/refund mutations also require `Idempotency-Key`; reconciliation is a status lookup and does not require an idempotency key.

| Method     | Path                                         | Purpose                                                                                         |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET        | `/api/session`                               | Current user and CSRF token.                                                                    |
| POST       | `/api/register`, `/api/login`, `/api/logout` | Account/session lifecycle.                                                                      |
| GET        | `/api/products`                              | Public seeded catalogue.                                                                        |
| GET / POST | `/api/orders`                                | Latest 100 visible orders / create order from `{ items: [{ productId, quantity }] }`.           |
| GET        | `/api/orders/:id`                            | Authorized detail, financial state and merchant event history.                                  |
| POST       | `/api/orders/:id/payment`                    | Buyer creates the one sandbox payment; `{}` body.                                               |
| POST       | `/api/orders/:id/capture`                    | Buyer requests capture after approval; `{}` body.                                               |
| POST       | `/api/orders/:id/refund`                     | Merchant requests a full refund; `{}` body.                                                     |
| POST       | `/api/orders/:id/reconcile`                  | Owner/merchant checks provider status. Merchant may supply `{ providerRefundId }` for recovery. |
| POST       | `/api/webhooks/paypal`                       | PayPal-signature-authenticated endpoint; no browser CSRF.                                       |
| GET        | `/api/health`                                | Database readiness.                                                                             |

## Testing and build

Create `.env.test` in the root, containing **only** a dedicated test URL:

```dotenv
TEST_DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/paytrack_test
```

```text
npm test
npm run build
npm run format:check
```

Without `TEST_DATABASE_URL`, the PostgreSQL integration suite is visibly skipped; pure validation and mocked HTTP adapter tests still run. The integration suite checks the URL and actual database name, requires `_test`, rejects the configured development URL, creates a random private schema, and drops only that schema after the suite. It never deletes or resets a non-test database. Do not point this setting at valuable data, even if its name ends in `_test`.

Tests use real PostgreSQL queries and real Express/session middleware with mocked PayPal methods. Separate adapter tests mock `fetch` and check the actual endpoint/header/body construction. Authentication rate limiting is skipped only under Vitest's `NODE_ENV=test` so fixtures do not exhaust a shared login quota. Production rate limiting remains enabled; its timing is not covered by this suite.

See [VERIFICATION.md](VERIFICATION.md) for the final executed checks and outstanding manual sandbox checks. See [LEARNING_GUIDE.md](LEARNING_GUIDE.md) for the Hinglish walkthrough and [INTERVIEW_GUIDE.md](INTERVIEW_GUIDE.md) for flow explanations and questions.

## Honest boundaries

This is an interview learning application, not a production payment platform. It has one currency, one PayPal payment attempt per order and one full refund operation per payment. It deliberately omits partial refunds, replacement attempts after terminal failures, inventory, fulfilment, subscriptions, coupons, password recovery, email verification, automated background reconciliation, disputes/chargebacks, historical pagination and live money. Latest 100 orders are shown. Server sessions retain the role at login; production role revocation would need session invalidation. The login limiter is process-local, suitable for this single-server exercise. Its errors do not expose raw provider responses or credentials.

The API binds to loopback for local use. Production hosting, reverse-proxy configuration, retention policies, monitoring and operational runbooks need separate work. No claim is made that real PayPal Sandbox transactions or real webhook signatures passed until configured and exercised with your accounts.

## Official references consulted

- [Create order](https://developer.paypal.com/api/orders/v2/orders-create) and [capture order](https://developer.paypal.com/api/orders/v2/orders-capture): server-side CAPTURE flow, request IDs and representation responses.
- [Refund a capture](https://developer.paypal.com/api/payments/v2/captures-refund) and [Payments v2](https://developer.paypal.com/api/payments/v2): refund and status lookups.
- [Webhook integration](https://developer.paypal.com/api/rest/webhooks/rest/) and [verification API](https://developer.paypal.com/api/webhooks/v1): official postback verification, app webhook ID and redelivery behaviour.
- [Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/): endpoint-specific support and retention; never assume an unlimited replay window.
