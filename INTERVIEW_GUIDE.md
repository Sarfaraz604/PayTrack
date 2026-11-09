# PayTrack interview guide

## A 45-second introduction

“PayTrack is a learning project for checkout and full-refund management using React, TypeScript, Express and PostgreSQL. Customers can create orders and approve payments through PayPal Sandbox. Merchants can inspect orders and request eligible refunds. The backend calculates amounts from stored product prices, uses PostgreSQL-backed sessions and enforces ownership and merchant permissions. Payment operations have durable request identifiers and database constraints to prevent duplicates. Timeouts remain uncertain until verified provider responses, webhooks or reconciliation resolve them. The project includes automated tests with mocked PayPal responses and real PostgreSQL queries, plus documentation explaining the flow and its limitations.”

Use this as a factual description of the project. Do not claim personal ownership of code you cannot explain, production scale, real customer use, or measured improvements that were never measured.

## Checkout: click to final status

1. React loads the session/CSRF token and the catalogue. The browser estimate is for display.
2. The customer submits product IDs and integer quantities, with an order idempotency key.
3. Express checks session, Origin and CSRF. PostgreSQL supplies prices. The server validates quantities, calculates USD cents and saves an order with item snapshots inside a transaction.
4. A duplicate buyer/key reuses the stored order only when its normalized cart matches. Changed cart returns 409.
5. The buyer starts payment. The server reserves the one payment row and permanent create/capture request IDs, commits, then creates a PayPal Sandbox order.
6. The server validates provider identifiers, merchant, currency and amount, saves the provider order/approval URL and redirects the browser to the validated Sandbox host.
7. The customer approves using a sandbox buyer account. A return query parameter only displays a message; it does not mark the order paid.
8. The buyer clicks Confirm payment. An atomic database update claims capture; only the winning request calls PayPal.
9. A verified completed capture changes the payment and order atomically to COMPLETED/PAID. Pending outcomes remain pending. A timeout or unexpected result remains UNKNOWN.
10. Signed webhooks and authorized GET reconciliation can settle uncertain results. The browser can refresh order detail at any time.

## Refund flow

The merchant opens a completed payment and requests its full stored amount. The backend checks merchant role and payment eligibility. A short transaction locks the payment and reserves a unique refund with a stable PayPal request ID. After commit, it calls the capture-refund endpoint, validates the result and atomically updates refund/payment/order state. Only a completed full refund makes the order REFUNDED. Duplicate requests return the same operation; a different key does not create another refund.

For an uncertain refund, reconciliation GETs its stored provider ID. If the response was lost before that ID was saved, a verified refund webhook can recover it. A merchant may also supply the refund ID from the Sandbox dashboard; the server fetches and validates the resource, including its local invoice ID and amount/currency. It does not assume the entered ID proves success and never automatically issues another refund.

## Duplicate requests: explain the two layers

Local PostgreSQL constraints/locks prevent multiple logical operations. Provider `PayPal-Request-Id` identifies the same external operation when a supported retry occurs. Both are needed because the database and provider cannot share one transaction. Frontend disabled buttons and sessionStorage keys are convenience features, not the correctness boundary.

Order keys are scoped to buyer + key and compared with the canonical cart. Payment-create/capture keys are scoped to the order; refunds to the payment. Financial bodies are fixed by the stored order, and unexpected fields are rejected. A second key cannot bypass the one-payment/one-refund constraints. This version intentionally does not support replacing failed attempts.

## Timeout example

Suppose PayPal captures $36.00, but the HTTP response is lost. The server leaves the payment UNKNOWN and the order unpaid locally because success is unconfirmed. A second capture request does not issue another provider POST. Check provider status performs GET on the stored provider order, validates the capture ID, amount, USD currency and merchant/order relationships, then records PAID. A verified webhook can do the same.

If creation lost its provider order ID, the persisted create request ID permits bounded creation recovery after one minute and within five hours. Beyond that window, the application requires dashboard investigation. Endpoint retention is finite. A missing capture in one GET does not prove that the previous capture stopped processing, so automatic recapture remains disabled.

## Relationships and transaction boundaries

A user has many orders; each order has item snapshots referencing products. An order has at most one payment, and a payment has at most one refund. Webhook events have globally unique provider event IDs and may link to an order. Session data lives separately in PostgreSQL. Foreign keys prevent orphaned relationships; unique constraints prevent duplicate provider resources and logical financial operations.

Order creation is one database transaction. Payment/refund reservations are short database transactions or atomic claims. Provider network requests occur after commit. Result writes atomically update related local states. Webhook financial updates and its PROCESSED marker commit together, after external verification/status lookups. A local rollback cannot reverse a provider charge; reconciliation closes that gap.

## Fifteen likely questions

1. **Why calculate totals on the backend?** Browser data can be changed. The server accepts IDs/quantities, reads database prices and calculates the authoritative total.
2. **Why integer cents?** Bounded integer arithmetic avoids floating-point rounding in local monetary calculations. USD strings with two decimals are created only at the provider boundary.
3. **Why store item prices when products already have prices?** Order items are historical snapshots. A later catalogue change must not rewrite an existing order total.
4. **How are passwords stored?** As salted Argon2id hashes from a maintained library. Passwords are never stored in plaintext or reversible form.
5. **How are sessions secured?** PostgreSQL stores session state; an opaque signed HttpOnly cookie identifies it. SameSite, production Secure cookies, login regeneration, Origin checks and CSRF tokens protect browser mutations.
6. **Can signup create a merchant?** No. Public registration inserts the customer role explicitly. Merchant creation is a separate seed operation with an explicit password.
7. **Can one buyer read another buyer's order?** No. The backend checks ownership and returns 404 for an inaccessible order. Merchants have explicitly permitted order access.
8. **Does PayPal approval mean payment completed?** No. Only a validated capture/provider state can mark it paid. The browser redirect is not evidence of settlement.
9. **How do you prevent duplicate captures?** A persisted capture key and an atomic conditional update allow one caller to claim the operation; provider request IDs and unique constraints add durable protection.
10. **What happens if an idempotency key has different data?** A changed canonical cart returns 409. Fixed financial operations reject unexpected request fields; different operation keys cannot create another operation for the same payment/order.
11. **Why not wrap PayPal in a database transaction?** PostgreSQL cannot atomically commit an HTTP provider action. Holding locks during network calls wastes connections and still cannot roll back the external transaction.
12. **How are webhook signatures verified?** The server posts the signature headers, configured app webhook ID and event to PayPal's documented verification endpoint and accepts only SUCCESS. Simulator postback verification is unsupported.
13. **How are duplicate or old webhooks handled?** Unique provider event IDs deduplicate deliveries. Current provider status is fetched; guarded updates prevent completed/refunded state downgrades. Event processing and local state updates commit together.
14. **What does a timeout mean?** The result is uncertain. The provider may have completed the action. Preserve UNKNOWN and reconcile through verified GET/webhook data instead of blindly repeating financial POSTs.
15. **What was tested, and what remains unverified?** Real PostgreSQL/Express tests cover pricing, validation, access, duplicates, webhook ordering, refunds, timeouts and reconciliation with mocked PayPal methods. Adapter tests inspect mocked HTTP requests. Actual account approvals, captures, refunds and real signatures still require Sandbox credentials and manual verification. Exact results are in VERIFICATION.md.

## Honest limitations and next improvements

There are no production users, load-test claims, revenue claims or invented performance metrics. This is a single-server sandbox project with USD only, one attempt and one full refund per order/payment. It omits inventory, shipping fulfilment, partial refunds, replacement failed attempts, subscriptions, coupons and live money. The latest 100 orders are shown. Capture/refund outcomes that remain unresolved require dashboard investigation; no scheduled reconciliation worker exists.

Useful next steps would be actual Sandbox account verification, a scheduled reconciliation job, event retry visibility for merchants, session invalidation after role changes, password recovery/email verification, order pagination and operational monitoring. Production readiness would additionally need provider/business requirements, disputes and retention policies, secure hosting review and recovery procedures. These are future work, not completed features.
