# PayTrack ko samjho — Hinglish walkthrough

## Pehle overall flow

React browser mein UI dikhata hai. Express request validate karta hai, session se user identify karta hai, aur PostgreSQL se data read/write karta hai. PayPal Sandbox payment approval, capture aur refund handle karta hai. Browser ko PayPal secret kabhi nahi milta.

Teen important rules yaad rakho:

1. Browser ka amount authoritative nahi hai. Backend product price database se leta hai.
2. PayPal approval aur completed capture alag steps hain. Approval ke baad bhi order `CREATED` reh sakta hai.
3. Timeout ka matlab failure prove hona nahi hai. Provider payment complete kar chuka ho sakta hai jab hamara server response ka wait chhod de.

## Folder aur file map

```text
PayTrack/
  client/
    index.html
    vite.config.ts
    src/
      main.tsx
      App.tsx
      Catalogue.tsx
      OrderDetailsPanel.tsx
      Badge.tsx
      types.ts
      api.ts
      styles.css
  server/
    sql/001_initial.sql
    src/
      index.ts
      config.ts
      app.ts
      auth.ts
      orders.ts
      paypal.ts
      payments.ts
      webhooks.ts
      database-script.ts
      errors.ts
    tests/
      paytrack.test.ts
      provider.test.ts
    vitest.config.ts
  .env.example
  README.md
  LEARNING_GUIDE.md
  INTERVIEW_GUIDE.md
  VERIFICATION.md
```

`package.json` ke workspaces ka matlab client aur server ke dependencies ek root install se manage hote hain. `-w server` command ko server package ke context mein chalata hai. TypeScript configs strict type checking enable karte hain. `package-lock.json` exact installed dependency versions fix karta hai; `npm ci` isi lock ko use karta hai.

`client/index.html` React ka mount point hai. `main.tsx` root par `App` render karta hai. React StrictMode development mein effect ko dobara chala sakta hai, isliye mount effect sirf reads karta hai; capture/refund effect mein automatically nahi chalte. `vite.config.ts` `/api` request Express ko proxy karta hai. Browser same origin se communicate karta hai, isliye alag CORS setup ki zarurat nahi.

`server/src/index.ts` config, database pool aur PayPal adapter create karke API start karta hai. SIGINT/SIGTERM par server close aur pool cleanup hota hai. `app.ts` ordinary Express routes rakhta hai: route request leta hai, authorization check karta hai, relevant function call karta hai, aur JSON response bhejta hai. Is project mein generic repository ya dependency-injection container nahi hai.

## Frontend ke main functions

| Function                  | Input → processing → output                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `App`                     | User interaction → state aur API calls coordinate → account, catalogue aur orders UI.                                                                                                |
| `load` inside `useEffect` | Initial page/query string → session, products, orders fetch → initial state. Approval query sirf message/selection set karta hai.                                                    |
| `errorMessage`            | Unknown thrown value → Error check → readable message string.                                                                                                                        |
| `refreshOrders`           | Optional selected order ID → list/detail GET → updated state.                                                                                                                        |
| `authenticate`            | Submit event + email/password → login/register POST → new user/CSRF state. Password state clear hoti hai.                                                                            |
| `logout`                  | Click → logout POST, fresh anonymous session GET → user/order state clear.                                                                                                           |
| `checkout`                | Selected quantities → product IDs/quantities build, order POST → saved order selected. Successful save ke baad cart key remove hoti hai, so same items ka new purchase possible hai. |
| `orderAction`             | `payment`, `capture`, `refund` ya `reconcile` → corresponding POST + detail refresh → updated state or verified Sandbox redirect.                                                    |
| `openOrder`               | Order ID → authorized detail GET → selected order.                                                                                                                                   |
| `Catalogue`               | Products, quantities aur callbacks → display estimate + cart UI → presentational React elements. Iska estimate backend price verification replace nahi karta.                        |
| `OrderDetailsPanel`       | Selected order, role, busy state aur callbacks → allowed controls + status → detail view. Backend independently permissions enforce karta hai.                                       |
| `statusLabel`, `Badge`    | Provider/local status → readable text/CSS class → status badge.                                                                                                                      |
| `api`                     | Path, method, body, optional key → fetch with cookie + CSRF header, status check → parsed JSON or Error.                                                                             |
| `saveCsrfToken`           | Session response token → module variable update → future POST headers.                                                                                                               |
| `money`                   | Integer cents → `Intl.NumberFormat` → USD display string.                                                                                                                            |
| `operationKey`            | Logical operation name → existing sessionStorage key read or UUID create → stable browser retry key. Backend DB hi actual duplicate protection hai.                                  |

`useState` current UI value aur setter deta hai. Setter ke baad React render karta hai. `useEffect(..., [])` initial data load ke liye hai; async function effect ke andar define karke call kiya gaya hai, effect itself async nahi hai. Form ka `event.preventDefault()` page reload rokta hai. Labels, real buttons aur select elements keyboard se accessible hain. `busy` state loading show karti hai, lekin server correctness disabled button par depend nahi karti.

## Authentication aur configuration

| Function           | Input → processing → output                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `readConfig`       | Environment → DB/secret/origin validate → simple Config object. Production origin HTTPS honi chahiye.                                     |
| `createApp`        | Pool, config, PayPal adapter → middleware/routes register → Express app. Tests real app ko fake provider methods ke saath use karte hain. |
| `requireUser`      | Request session → logged-in check → next middleware, otherwise 401.                                                                       |
| `requireMerchant`  | Session user → role check → next, otherwise 403.                                                                                          |
| `csrfToken`        | Session → absent ho to random token create → token string.                                                                                |
| `checkCsrf`        | Origin + token headers → exact origin and constant-time token comparison → continue or 403.                                               |
| `readCredentials`  | Unknown JSON → email normalize, password length validate → email/password object.                                                         |
| `startSession`     | Request + safe user fields → old session regenerate, token rotate, DB save → completed Promise.                                           |
| `requireEmptyBody` | Financial request body → unexpected field check → allow fixed operation or 400.                                                           |
| `AppError`         | HTTP status + safe message → ordinary Error subclass → error middleware ka expected response.                                             |

`argon2.hash` password ko Argon2id hash mein convert karta hai. Random salt library manage karti hai. `argon2.verify` provided password ko saved hash ke against check karta hai. Hashing reversible encryption nahi hai. Database mein plaintext password nahi rakha jata.

Cookie mein sirf opaque session ID hoti hai. Actual user/CSRF data PostgreSQL session table mein hota hai. `httpOnly` JavaScript ko cookie read karne se rokta hai; `sameSite: 'lax'` cross-site cookie sending restrict karta hai aur PayPal top-level return allow karta hai. Production mein `secure` cookie HTTPS par hi send hoti hai. Login par session regenerate karna session fixation se protection deta hai. CSRF token ko session cookie se alag request header mein bheja jata hai; exact Origin bhi validate hota hai.

`helmet` common secure HTTP headers set karta hai. Login/register par `express-rate-limit` repeated guesses limit karta hai. Tests mein limiter skip hota hai, because fixture accounts same local IP se create hote hain. `express.json` JSON parse karta hai aur 64 KB limit oversized bodies rokta hai. Express 5 rejected async route Promises ko error middleware tak bhejta hai, isliye callback nesting/wrapper framework nahi hai.

## Order calculation aur SQL

| Function         | Input → processing → output                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `readKey`        | Header → format/length check → usable string or 400.                                                                                |
| `validateCart`   | Unknown items → size, product ID, quantity, duplicate check; ID se sort → canonical CartItem array.                                 |
| `calculateTotal` | Validated cart + database products → price × quantity integer sum → bounded total in cents. Unknown product reject hota hai.        |
| `createOrder`    | Buyer, key, cart → transaction, user lock, duplicate/payload check, products read, snapshots insert → existing/new order.           |
| `getOrder`       | ID + user → database read + ownership/merchant check → order or 404. Other buyer ko existence bhi expose nahi hoti.                 |
| `migrate`        | Pool → SQL read, transaction/advisory lock, version check → unapplied migration execute.                                            |
| `seed`           | Pool + merchant env → missing products/user insert → catalogue + optional merchant. Existing user role/password preserve hote hain. |

```ts
const productIds = items.map(function (item) {
  return item.productId;
});
const products = await client.query(
  'SELECT * FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE',
  [productIds]
);
```

1. `map` cart ke har item se ID nikalta hai; business calculation is expression mein hide nahi hai.
2. `client.query` connected PostgreSQL client se query chalata hai.
3. `$1` parameter placeholder hai. User text SQL string mein join nahi hota.
4. `::int[]` PostgreSQL ko batata hai ki parameter integer array hai.
5. `ANY` array mein present IDs match karta hai.
6. `ORDER BY` locks ko consistent ID order mein lene mein help karta hai.
7. `FOR SHARE` order snapshot banne tak product price update ko wait karata hai.

```ts
let total = 0;
for (const item of items) {
  const product = products.find(function (candidate) {
    return candidate.id === item.productId;
  });
  if (!product) throw new AppError(400, 'A selected product is unavailable.');
  total += product.price_minor * item.quantity;
}
```

`total` zero se start hota hai. `for...of` har cart item leta hai. `find` matching authoritative product deta hai. Missing product par request fail hoti hai. Last line cents mein multiplication/addition karti hai. Decimal amount ka browser input is function mein aata hi nahi. Quantity validation pehle `validateCart` mein hoti hai.

Canonical cart ka matlab same product selection, same order mein represent ho. PostgreSQL JSONB object keys ka original order preserve nahi karta, isliye saved cart ko bhi `validateCart` se reconstruct karke compare karte hain. Same key + changed quantity = 409. Existing request ke retry mein prices dobara calculate karke existing order badla nahi jata.

## Payment aur refund functions

| Function             | Input → processing → output                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paypalAmount`       | Integer cents → divide by 100, fixed 2 decimals → PayPal USD string.                                                                                                           |
| `checkAmount`        | Provider amount + expected cents → exact USD/value check → success or validation error.                                                                                        |
| `PayPal.request`     | Method/path/body/request ID → server-side OAuth token, Sandbox fetch, timeout/status check → provider JSON. Transport helper hai; payment decisions yahan hidden nahi hain.    |
| `PayPal.create`      | Local order + persisted request ID → one purchase unit, merchant, custom/reference IDs, return URLs → created provider order.                                                  |
| `PayPal.capture`     | Provider order ID + capture request ID → documented capture POST → provider order response.                                                                                    |
| `PayPal.getOrder`    | Provider order ID → GET → current provider state.                                                                                                                              |
| `PayPal.refund`      | Capture ID, local order/refund, request ID → full amount + local invoice ID POST → provider refund.                                                                            |
| `PayPal.getRefund`   | Refund ID → GET → current refund state.                                                                                                                                        |
| `PayPal.verify`      | Signature headers + parsed event → official verification POST with configured webhook ID → true only for `SUCCESS`.                                                            |
| `checkProviderOrder` | Local order + provider response → order/intent/reference/custom/merchant/amount/currency checks → allow state processing or error.                                             |
| `startPayment`       | Order + key → short DB reservation, external create, validation/save → payment row. Same logical operation duplicate does not call provider twice.                             |
| `saveCreatedPayment` | Provider creation result → validate IDs/amount/merchant + approval URL host → link provider order and approval URL.                                                            |
| `capturePayment`     | Order + key → atomic claim, external capture, verified state apply → completion. Errors preserve UNKNOWN; duplicate never blindly recaptures.                                  |
| `applyPayment`       | Current provider order + local payment → validate one capture and allowed transitions → atomic payment/order update.                                                           |
| `startRefund`        | Eligible order + key → lock payment, reserve unique refund, commit, call provider → refund row.                                                                                |
| `applyRefund`        | Provider/local refund + payment/order → identifiers/invoice/amount/currency/capture-link check → atomic refund/payment/order state update.                                     |
| `reconcileOrder`     | Authorized order, optional merchant recovery refund ID → current GETs or bounded creation-only recovery → validated local state updates. Capture/refund POST repeat nahi hota. |
| `processWebhook`     | Signature headers + unknown event → verify, deduplicate/store, correlate, provider GETs, transactional apply → processed event or retryable error.                             |

`PaymentProvider` ek chhota interface hai jo PayPal adapter ke methods describe karta hai. Production mein real `PayPal` object aur test mein fake methods use hote hain. Ye generic service framework nahi hai. `PayPal` class connection credentials ko server par rakhti hai; business state `payments.ts` mein explicit rehti hai.

```sql
UPDATE payment_attempts
SET capture_key=$2, status='CAPTURING'
WHERE order_id=$1
  AND status='APPROVAL_PENDING'
  AND capture_key IS NULL
RETURNING *
```

Pehli request matching row update karke claim leti hai. Concurrent request ko updated condition dobara check karni padti hai; `capture_key` ab NULL nahi hai, so zero rows milti hain. Sirf returned row wali request PayPal call karti hai. `RETURNING` updated record deta hai, extra SELECT ki zarurat nahi hoti. Crash ke baad claim database mein rehta hai.

`applyPayment` aur `applyRefund` mein `WITH changed AS (...)` PostgreSQL common table expression hai. Isko chhoti temporary query result ki tarah padho: pehle payment/refund update hota hai, uske returned IDs se next related update hota hai. Ye ek SQL statement hai; related local states atomically change hote hain. `CASE WHEN` SQL ka if/else hai. Status conditions old pending result ko completed/refunded result overwrite karne se rokti hain. Ye query thodi unfamiliar hai, lekin atomic related writes ke liye rakhi gayi hai.

## External call ko transaction mein kyun nahi rakha?

Flow: `BEGIN → local reservation → COMMIT → PayPal call → validation → local result write`. Network ke dauran DB connection lock pakadkar nahi baithta. PayPal apni database transaction hamare PostgreSQL ke saath share nahi karta. Local rollback se external charge reverse nahi hota. Isi gap ke liye durable operation IDs, UNKNOWN state, verified webhooks aur reconciliation hain.

Webhook handler event metadata pehle store karta hai, phir provider GET karta hai. GET ke baad short transaction mein event row lock hoti hai, validated financial state update hota hai aur event PROCESSED hota hai. Agar validation fail ho to related processing rollback hoti hai; event metadata retry ke liye rehta hai. Duplicate event ka primary key same hai. PENDING event late aaye to bhi completed/refunded state downgrade nahi hoti.

## Necessary syntax aur standard API notes

| Syntax/API                                       | Simple meaning                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `async` / `await` / `Promise<void>`              | Async operation ka wait without blocking JS thread; `void` output value nahi hai. `Promise` type parameter ordinary result typing hai.                                          |
| `new Promise` in session helpers                 | Callback-based session API ko await-compatible banata hai. Error par reject, successful callback par resolve.                                                                   |
| `interface`, `extends`, `Record<number, number>` | Data shape; existing shape extend karna; product ID se quantity dictionary. Advanced conditional/generic type programming use nahi hua.                                         |
| `unknown`, `as Type`                             | External value initially unknown; assertion compiler ko expected shape batata hai. Assertion runtime validation nahi karta, isliye financial fields separately check hote hain. |
| `value!`                                         | Compiler ko batata hai ki earlier check/known flow ke baad value present hai. Runtime validation ka replacement nahi.                                                           |
| `?.`, `??` / `                                   |                                                                                                                                                                                 | `   | Optional property read; nullish/default or falsy fallback. Optional chains sirf small provider-response shapes read karne ke liye hain. |
| `{ ...quantities, [productId]: quantity }`       | Old state copy karke selected product ki quantity replace; React state mutate nahi hoti.                                                                                        |
| `void load()` / `void orderAction(...)`          | Event/effect ko return value nahi chahiye. Called function internally errors catch karta hai.                                                                                   |
| `crypto.randomUUID`, `randomBytes`               | Standard secure random identifiers/tokens. Provider request IDs user ke browser totals se nahi bante.                                                                           |
| `timingSafeEqual`, `Buffer.byteLength`           | Equal byte length confirm karke tokens compare; early character-by-character mismatch timing avoid hoti hai.                                                                    |
| `AbortSignal.timeout(15000)`                     | Fetch ko 15 second baad stop waiting karata hai. Provider operation cancel hone ki guarantee nahi.                                                                              |
| `Buffer.from(...).toString('base64')`            | OAuth Basic authentication encoding. Base64 encryption nahi; HTTPS transport protect karta hai.                                                                                 |
| `URL`, `URLSearchParams`, `encodeURIComponent`   | URLs parse/build karne ke standard APIs. Hostname check malicious approval redirect rokta hai.                                                                                  |
| `response.ok`, `response.json`                   | HTTP success range check; JSON body read. 204 response ko JSON parse nahi karte.                                                                                                |
| `Intl.NumberFormat`, `toFixed(2)`                | Display USD formatting; provider boundary par exact two-decimal string.                                                                                                         |
| `FOR UPDATE`, `FOR SHARE`                        | Transaction-scoped row locks for concurrent requests.                                                                                                                           |
| `ON CONFLICT DO NOTHING`, `UNIQUE`               | Database duplicate insert reject/preserve karta hai. Ye browser button se independent hai.                                                                                      |
| `pg_advisory_xact_lock`                          | Migration version check/application ko serialize karta hai; transaction end par release.                                                                                        |
| `Pool`, `connect`, `release`, `pool.end`         | Reusable DB connections, explicit transaction connection, return connection, shutdown cleanup.                                                                                  |
| `try/catch/finally`                              | Work, error handling, guaranteed cleanup. Connection release `finally` mein hota hai.                                                                                           |
| Module augmentation in `auth.ts`                 | Existing express-session interface mein hamare `user`/`csrf` fields add karta hai. Library session extension ka normal TS mechanism hai.                                        |
| `import.meta.url`, `new URL('../sql/...', ...)`  | Migration file ko module location ke relative locate karta hai, shell directory par depend nahi karta.                                                                          |
| `class`, `constructor`, `private`                | Error/provider wrapper ka ordinary object structure. Constructor initial values assign karta hai; private config adapter ke andar use hota hai.                                 |

## Tests ko kaise padho

`describe` related tests group karta hai. `it` behaviour define karta hai; `expect` actual result check karta hai. `beforeAll` private schema banata hai; `beforeEach` usi test schema ko reset karke fresh users create karta hai; `afterAll` sirf generated schema remove karta hai. `supertest.agent` session cookies retain karta hai, isliye login ke baad same buyer request kar sakta hai. `vi.fn` provider methods track/mock karta hai; `mockImplementationOnce` ek specific timeout/mismatch simulate karta hai. `Promise.all` tests mein concurrent duplicate requests issue karta hai. Application idempotency kisi in-memory test mock par depend nahi karti.

`provider.test.ts` actual HTTP adapter ke fetch calls inspect karta hai: Sandbox URL, headers, request IDs, amount, webhook verification body. `paytrack.test.ts` real PostgreSQL/Express/session flow test karta hai. Mocked verification test authentic signature verification ka live proof nahi hai. Final executed results `VERIFICATION.md` mein hain.

## Recommended learning milestones

1. **Database + orders:** `001_initial.sql`, `orders.ts`, `database-script.ts`. Samjho: FK, snapshots, cents, parameterized query, BEGIN/COMMIT/ROLLBACK.
2. **Authentication:** `auth.ts`, `app.ts`, `config.ts`. Samjho: session cookie aur server-side data ka difference, CSRF, role vs ownership.
3. **PayPal + safety:** `paypal.ts`, `payments.ts`, `webhooks.ts`. Samjho: create/approve/capture, stable request ID, unknown outcome, no network inside DB transaction.
4. **React:** `App.tsx`, `Catalogue.tsx`, `OrderDetailsPanel.tsx`, `api.ts`, `Badge.tsx`, `types.ts`, `styles.css`. Samjho: state → render; event → API; display estimate vs authoritative total.
5. **Verification + explanation:** tests aur three guides. Ek duplicate request aur timeout scenario khud trace karo, phir interview answers apne words mein explain karo.

Har milestone ka output working behaviour aur readable files hain. Sandbox account/configuration ke bina local verified tests ko live PayPal integration success mat bolo.
