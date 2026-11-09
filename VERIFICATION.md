# Verification record

Verification date: **9 November 2026**. No deployment or GitHub push was performed. No PayPal credentials were supplied; no real provider transaction was attempted.

## Executed successfully

- Dependency installation: npm reported **0 vulnerabilities** at installation time. This is a point-in-time dependency audit, not a security certification.
- TypeScript server and React production builds; Prettier formatting check.
- **37 automated tests passed** across two test files, with all database integration tests enabled. Real PostgreSQL 18 ran in a separate local test cluster on loopback port 55439. The suite used a uniquely generated schema in `paytrack_test`, then removed that schema. Development databases were not reset.
- Tests cover integer-cent pricing, invalid quantities, missing products/duplicate product rows, concurrent duplicate order/payment/capture/refund requests, changed cart keys, fixed financial payload rejection, authentication/session lifecycle, CSRF, public signup role enforcement, merchant/ownership restrictions, browser approval not marking paid, mismatched provider IDs/merchant/amount/currency, webhook verification rejection, deduplication, out-of-order events, unmatched-event redelivery, transaction rollback, refund eligibility, timeouts, safe creation recovery/expiry, capture reconciliation and refund recovery through webhook, GET and merchant-supplied verified ID.
- HTTP adapter tests mock fetch and check Sandbox endpoints, amount/correlation fields, stable request headers, official webhook-verification payload and transport timeout propagation. Tests never call PayPal.
- Migration and seed CLIs ran successfully against a separate disposable `paytrack_smoke_test` database. API startup/readiness returned `ok`; frontend proxy returned the three seeded products.
- Local catalogue rendered in installed headless Chrome at desktop and emulated 390 px mobile widths; screenshots inspected. Mobile document width matched the viewport with no overflowing elements.
- Browser smoke journey passed: customer registration, quantity selection, a correctly priced $36.00 order, explicit unconfigured-Sandbox error with UNKNOWN payment state, and logout. This used a disposable local database and no external PayPal calls.

## Inspected / awaiting manual execution

- Complete merchant and provider browser journeys: API behaviour is tested, but full browser click-through coverage of payments/refunds has not been claimed.
- Actual PayPal Sandbox order creation, buyer approval, capture, full refund, real signature verification, webhook delivery/resend and real-world timeout recovery: **awaiting Sandbox account credentials/configuration**. Mocked tests do not establish live interoperability.
- HTTPS tunnel setup and registered app webhook configuration: instructions supplied, not configured automatically.
- Production hosting, live payments, load/performance tests, distributed rate limiting, disputes and operational recovery: outside this version's scope.

The `.local` folder is ignored workspace QA data, not required application source. Local temporary servers are stopped after verification. To run the project yourself, follow README.md with your own `.env` and database.
