import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { migrate } from '../src/database-script.js';
import { Config } from '../src/config.js';
import { calculateTotal, validateCart } from '../src/orders.js';
import { PaymentProvider, ProviderOrder, ProviderResource, PayPal } from '../src/paypal.js';

const products = [{ id: 1, name: 'Notebook', description: 'Test product', price_minor: 1800 }];

describe('Money and cart validation', function () {
  it('calculates cents using authoritative products', function () {
    expect(calculateTotal([{ productId: 1, quantity: 3 }], products)).toBe(5400);
  });
  it.each([0, -1, 1.2, 11, '2', null])('rejects invalid quantity %s', function (quantity) {
    expect(function () {
      validateCart([{ productId: 1, quantity }]);
    }).toThrow();
  });
  it('rejects duplicate and unavailable products', function () {
    expect(function () {
      validateCart([
        { productId: 1, quantity: 1 },
        { productId: 1, quantity: 2 }
      ]);
    }).toThrow();
    expect(function () {
      calculateTotal([{ productId: 2, quantity: 1 }], products);
    }).toThrow();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
// No DB URL means a visible skip, never an implicit use of the development database.
describe.skipIf(!databaseUrl)('PostgreSQL + Express payment safety', function () {
  const schema = 'paytrack_test_' + randomUUID().replaceAll('-', '');
  let pool: Pool;
  let admin: Pool;
  let app: ReturnType<typeof createApp>;
  let buyer: ReturnType<typeof request.agent>;
  let merchant: ReturnType<typeof request.agent>;
  let token: string;
  let merchantToken: string;
  let data: ProviderOrder;
  let refundData: ProviderResource;
  const config: Config = {
    databaseUrl: databaseUrl || '',
    sessionSecret: 'test-session-secret-32-characters-long',
    origin: 'http://localhost:5173',
    production: false,
    paypalClientId: '',
    paypalSecret: '',
    paypalMerchantId: 'TEST-MERCHANT',
    paypalWebhookId: 'TEST-HOOK'
  };
  const provider: PaymentProvider = {
    merchantId: 'TEST-MERCHANT',
    create: vi.fn(async function (order) {
      data = {
        id: 'PROVIDER-ORDER',
        intent: 'CAPTURE',
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [
          {
            reference_id: order.id,
            custom_id: order.id,
            amount: { value: (order.total_minor / 100).toFixed(2), currency_code: 'USD' },
            payee: { merchant_id: 'TEST-MERCHANT' }
          }
        ],
        links: [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=PROVIDER-ORDER'
          }
        ]
      };
      return data;
    }),
    capture: vi.fn(async function () {
      data.status = 'COMPLETED';
      data.purchase_units![0].payments = {
        captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: data.purchase_units![0].amount }]
      };
      return data;
    }),
    getOrder: vi.fn(async function () {
      return data;
    }),
    refund: vi.fn(async function (captureId, order, refundId) {
      refundData = {
        id: 'REFUND-1',
        invoice_id: refundId,
        status: 'COMPLETED',
        amount: { value: (order.total_minor / 100).toFixed(2), currency_code: 'USD' },
        links: [
          { rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/' + captureId }
        ]
      };
      return refundData;
    }),
    getRefund: vi.fn(async function () {
      return refundData;
    }),
    verify: vi.fn(async function () {
      return true;
    })
  };

  beforeAll(async function () {
    const url = new URL(databaseUrl!);
    if (!url.pathname.endsWith('_test'))
      throw new Error('TEST_DATABASE_URL database name must end in _test.');
    if (databaseUrl === process.env.DATABASE_URL)
      throw new Error('Test and development URLs must differ.');
    admin = new Pool({ connectionString: databaseUrl });
    const actual = await admin.query('SELECT current_database() AS name');
    if (!actual.rows[0].name.endsWith('_test')) throw new Error('Refusing a non-test database.');
    // Generated schema is the only object this suite creates or drops.
    await admin.query('CREATE SCHEMA ' + schema);
    pool = new Pool({ connectionString: databaseUrl, options: '-c search_path=' + schema });
    await migrate(pool);
    app = createApp(pool, config, provider);
  });

  beforeEach(async function () {
    vi.clearAllMocks();
    await pool.query(
      'TRUNCATE webhook_events, refunds, payment_attempts, order_items, orders, products, session, users CASCADE'
    );
    await pool.query("INSERT INTO products VALUES (1,'Notebook','Test product',1800)");
    buyer = request.agent(app);
    let session = await buyer.get('/api/session');
    let response = await buyer
      .post('/api/register')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', session.body.csrfToken)
      .send({ email: 'buyer@example.com', password: 'strong-test-password', role: 'merchant' });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('customer');
    token = response.body.csrfToken;
    merchant = request.agent(app);
    session = await merchant.get('/api/session');
    response = await merchant
      .post('/api/register')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', session.body.csrfToken)
      .send({ email: 'merchant@example.com', password: 'strong-test-password' });
    await pool.query("UPDATE users SET role='merchant' WHERE email='merchant@example.com'");
    response = await merchant
      .post('/api/login')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', response.body.csrfToken)
      .send({ email: 'merchant@example.com', password: 'strong-test-password' });
    merchantToken = response.body.csrfToken;
  });

  afterAll(async function () {
    vi.unstubAllGlobals();
    if (pool) await pool.end();
    if (admin) {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin.end();
    }
  });

  async function createOrder(key = randomUUID()) {
    const result = await buyer
      .post('/api/orders')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', token)
      .set('Idempotency-Key', key)
      .send({ items: [{ productId: 1, quantity: 2 }], total: 1 });
    expect(result.status).toBe(201);
    return result.body;
  }
  async function payOrder() {
    const order = await createOrder();
    const start = await post(order.id, 'payment', randomUUID());
    expect(start.status).toBe(200);
    const captured = await post(order.id, 'capture', randomUUID());
    expect(captured.status).toBe(202);
    return order;
  }
  function post(id: string, action: string, key: string) {
    return buyer
      .post('/api/orders/' + id + '/' + action)
      .set('Origin', config.origin)
      .set('X-CSRF-Token', token)
      .set('Idempotency-Key', key)
      .send({});
  }
  function refund(id: string, key: string) {
    return merchant
      .post('/api/orders/' + id + '/refund')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', merchantToken)
      .set('Idempotency-Key', key)
      .send({});
  }
  function webhook(
    eventId: string,
    eventType = 'PAYMENT.CAPTURE.COMPLETED',
    resourceId = 'CAPTURE-1'
  ) {
    return request(app)
      .post('/api/webhooks/paypal')
      .set('paypal-auth-algo', 'SHA256withRSA')
      .set('paypal-cert-url', 'https://api.paypal.com/cert')
      .set('paypal-transmission-id', 'test-transmission')
      .set('paypal-transmission-sig', 'test-signature')
      .set('paypal-transmission-time', new Date().toISOString())
      .send({
        id: eventId,
        event_type: eventType,
        resource: {
          id: resourceId,
          supplementary_data: {
            related_ids: { order_id: 'PROVIDER-ORDER', capture_id: 'CAPTURE-1' }
          }
        }
      });
  }

  it('prices an order on the server and creates one order for concurrent duplicates', async function () {
    const key = randomUUID();
    const results = await Promise.all([createOrder(key), createOrder(key)]);
    expect(results[0].total_minor).toBe(3600);
    expect(results[0].id).toBe(results[1].id);
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(1);
  });
  it('rejects an idempotency key reused with a changed cart', async function () {
    const key = randomUUID();
    await createOrder(key);
    const result = await buyer
      .post('/api/orders')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', token)
      .set('Idempotency-Key', key)
      .send({ items: [{ productId: 1, quantity: 3 }] });
    expect(result.status).toBe(409);
  });
  it('enforces authentication, CSRF, merchant roles and ownership', async function () {
    expect((await request(app).get('/api/orders')).status).toBe(401);
    expect((await buyer.post('/api/orders').send({})).status).toBe(403);
    const order = await createOrder();
    expect((await post(order.id, 'refund', randomUUID())).status).toBe(403);
    const other = request.agent(app);
    const initial = await other.get('/api/session');
    const loggedIn = await other
      .post('/api/register')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', initial.body.csrfToken)
      .send({ email: 'other@example.com', password: 'strong-test-password' });
    expect((await other.get('/api/orders/' + order.id)).status).toBe(404);
    const capture = await other
      .post('/api/orders/' + order.id + '/capture')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', loggedIn.body.csrfToken)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(capture.status).toBe(404);
    expect((await merchant.get('/api/orders/' + order.id)).status).toBe(200);
  });
  it('regenerates login sessions and destroys logout sessions', async function () {
    const before = await buyer.get('/api/session');
    const loggedIn = await buyer
      .post('/api/login')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', token)
      .send({ email: 'buyer@example.com', password: 'strong-test-password' });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body.csrfToken).not.toBe(before.body.csrfToken);
    expect(
      (
        await buyer
          .post('/api/logout')
          .set('Origin', config.origin)
          .set('X-CSRF-Token', loggedIn.body.csrfToken)
          .send({})
      ).status
    ).toBe(204);
    expect((await buyer.get('/api/orders')).status).toBe(401);
  });
  it('does not capture twice under concurrent duplicate requests', async function () {
    const order = await createOrder();
    const key = randomUUID();
    await Promise.all([post(order.id, 'payment', key), post(order.id, 'payment', key)]);
    expect(provider.create).toHaveBeenCalledTimes(1);
    const captureKey = randomUUID();
    await Promise.all([
      post(order.id, 'capture', captureKey),
      post(order.id, 'capture', captureKey)
    ]);
    expect(provider.capture).toHaveBeenCalledTimes(1);
    expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('PAID');
    expect((await post(order.id, 'capture', randomUUID())).status).toBe(409);
  });
  it('does not mark browser approval as paid', async function () {
    const order = await createOrder();
    await post(order.id, 'payment', randomUUID());
    expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('CREATED');
  });
  it('rejects a provider amount mismatch without marking paid', async function () {
    const order = await createOrder();
    await post(order.id, 'payment', randomUUID());
    vi.mocked(provider.capture).mockImplementationOnce(async function () {
      data.purchase_units![0].payments = {
        captures: [
          { id: 'CAPTURE-1', status: 'COMPLETED', amount: { value: '0.01', currency_code: 'USD' } }
        ]
      };
      return data;
    });
    expect((await post(order.id, 'capture', randomUUID())).status).toBe(502);
    const result = (await buyer.get('/api/orders/' + order.id)).body;
    expect(result.status).toBe('CREATED');
    expect(result.payment.status).toBe('UNKNOWN');
  });
  it('preserves uncertain capture outcomes and reconciles without recapturing', async function () {
    const order = await createOrder();
    await post(order.id, 'payment', randomUUID());
    vi.mocked(provider.capture).mockImplementationOnce(async function () {
      data.status = 'COMPLETED';
      data.purchase_units![0].payments = {
        captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: data.purchase_units![0].amount }]
      };
      throw new Error('Simulated provider timeout AFTER capture');
    });
    const key = randomUUID();
    expect((await post(order.id, 'capture', key)).status).toBe(500);
    expect((await buyer.get('/api/orders/' + order.id)).body.payment.status).toBe('UNKNOWN');
    await post(order.id, 'capture', key);
    expect(provider.capture).toHaveBeenCalledTimes(1);
    expect((await post(order.id, 'reconcile', randomUUID())).status).toBe(200);
    expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('PAID');
    expect(provider.capture).toHaveBeenCalledTimes(1);
  });
  it('recovers uncertain creation with the original provider request ID within the safe window', async function () {
    const order = await createOrder();
    vi.mocked(provider.create).mockRejectedValueOnce(new Error('Timeout before order response'));
    await post(order.id, 'payment', randomUUID());
    await pool.query("UPDATE payment_attempts SET created_at=now()-interval '2 minutes'");
    expect((await post(order.id, 'reconcile', randomUUID())).status).toBe(200);
    const calls = vi.mocked(provider.create).mock.calls;
    expect(calls[0][1]).toBe(calls[1][1]);
  });
  it('refuses creation replay after provider idempotency retention could expire', async function () {
    const order = await createOrder();
    vi.mocked(provider.create).mockRejectedValueOnce(new Error('timeout'));
    await post(order.id, 'payment', randomUUID());
    await pool.query("UPDATE payment_attempts SET created_at=now()-interval '7 hours'");
    expect((await post(order.id, 'reconcile', randomUUID())).status).toBe(409);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid webhooks and processes duplicate verified events only once', async function () {
    const order = await payOrder();
    vi.mocked(provider.verify).mockResolvedValueOnce(false);
    expect((await webhook('INVALID')).status).toBe(400);
    expect((await pool.query('SELECT * FROM webhook_events')).rowCount).toBe(0);
    await webhook('EVENT-1');
    await webhook('EVENT-1');
    expect((await pool.query('SELECT * FROM webhook_events')).rowCount).toBe(1);
    expect((await merchant.get('/api/orders/' + order.id)).body.events[0].status).toBe('PROCESSED');
  });
  it('does not regress completed payment on an old pending event', async function () {
    const order = await payOrder();
    data.purchase_units![0].payments!.captures![0].status = 'PENDING';
    expect((await webhook('OLD-PENDING', 'PAYMENT.CAPTURE.PENDING')).status).toBe(204);
    expect((await buyer.get('/api/orders/' + order.id)).body.payment.status).toBe('COMPLETED');
  });
  it('stores unmatched events for PayPal redelivery and ignores unsupported events', async function () {
    expect((await webhook('EARLY')).status).toBe(503);
    expect((await pool.query('SELECT status FROM webhook_events')).rows[0].status).toBe(
      'UNMATCHED'
    );
    expect((await webhook('OTHER', 'CHECKOUT.ORDER.APPROVED')).status).toBe(204);
    const order = await payOrder();
    expect((await webhook('EARLY')).status).toBe(204);
    expect(
      (await pool.query("SELECT order_id FROM webhook_events WHERE provider_event_id='EARLY'"))
        .rows[0].order_id
    ).toBe(order.id);
  });
  it('checks refund eligibility and never issues duplicate refunds', async function () {
    const unpaid = await createOrder();
    expect((await refund(unpaid.id, randomUUID())).status).toBe(409);
    const order = await payOrder();
    const key = randomUUID();
    const results = await Promise.all([refund(order.id, key), refund(order.id, key)]);
    expect(results[0].status).toBe(202);
    expect(results[1].status).toBe(202);
    expect(provider.refund).toHaveBeenCalledTimes(1);
    expect((await refund(order.id, randomUUID())).status).toBe(409);
    expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('REFUNDED');
    await webhook('LATE-COMPLETED');
    expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('REFUNDED');
  });
  it('recovers a timed-out refund through verified webhook without repeating POST', async function () {
    const order = await payOrder();
    const originalRefund = provider.refund;
    vi.mocked(provider.refund).mockImplementationOnce(
      async function (captureId, savedOrder, refundId) {
        refundData = {
          id: 'REFUND-1',
          invoice_id: refundId,
          status: 'COMPLETED',
          amount: { value: '36.00', currency_code: 'USD' }
        };
        throw new Error('Refund timed out after provider processed it');
      }
    );
    await refund(order.id, randomUUID());
    expect((await buyer.get('/api/orders/' + order.id)).body.refund.status).toBe('UNKNOWN');
    await post(order.id, 'reconcile', randomUUID());
    expect(originalRefund).toHaveBeenCalledTimes(1);
    expect((await webhook('REFUND-EVENT', 'PAYMENT.CAPTURE.REFUNDED', 'REFUND-1')).status).toBe(
      204
    );
    const result = (await buyer.get('/api/orders/' + order.id)).body;
    expect(result.refund.status).toBe('COMPLETED');
    expect(result.status).toBe('REFUNDED');
  });
  it('reconciles pending refunds using GET', async function () {
    const order = await payOrder();
    vi.mocked(provider.refund).mockImplementationOnce(
      async function (captureId, savedOrder, refundId) {
        refundData = {
          id: 'REFUND-1',
          invoice_id: refundId,
          status: 'PENDING',
          amount: { value: '36.00', currency_code: 'USD' }
        };
        return refundData;
      }
    );
    await refund(order.id, randomUUID());
    refundData.status = 'COMPLETED';
    await post(order.id, 'reconcile', randomUUID());
    expect(provider.refund).toHaveBeenCalledTimes(1);
    expect(provider.getRefund).toHaveBeenCalledTimes(1);
    expect((await buyer.get('/api/orders/' + order.id)).body.refund.status).toBe('COMPLETED');
  });

  it('recovers an unknown refund from a merchant-supplied provider ID using GET only', async function () {
    const order = await payOrder();
    vi.mocked(provider.refund).mockImplementationOnce(
      async function (captureId, savedOrder, refundId) {
        refundData = {
          id: 'REFUND-1',
          invoice_id: refundId,
          status: 'COMPLETED',
          amount: { value: '36.00', currency_code: 'USD' }
        };
        throw new Error('Lost refund response');
      }
    );
    await refund(order.id, randomUUID());
    const response = await merchant
      .post('/api/orders/' + order.id + '/reconcile')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', merchantToken)
      .send({ providerRefundId: 'REFUND-1' });
    expect(response.status).toBe(200);
    expect(provider.refund).toHaveBeenCalledTimes(1);
    expect((await buyer.get('/api/orders/' + order.id)).body.refund.status).toBe('COMPLETED');
  });
  it('rejects a refund recovery ID belonging to a different local operation', async function () {
    const order = await payOrder();
    vi.mocked(provider.refund).mockRejectedValueOnce(new Error('Lost refund response'));
    await refund(order.id, randomUUID());
    refundData = {
      id: 'OTHER-REFUND',
      invoice_id: 'another-local-refund',
      status: 'COMPLETED',
      amount: { value: '36.00', currency_code: 'USD' }
    };
    const response = await merchant
      .post('/api/orders/' + order.id + '/reconcile')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', merchantToken)
      .send({ providerRefundId: 'OTHER-REFUND' });
    expect(response.status).toBe(502);
    expect((await buyer.get('/api/orders/' + order.id)).body.refund.status).toBe('UNKNOWN');
    const forbidden = await buyer
      .post('/api/orders/' + order.id + '/reconcile')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', token)
      .send({ providerRefundId: 'OTHER-REFUND' });
    expect(forbidden.status).toBe(403);
  });
  it.each(['currency', 'merchant', 'reference', 'order-id'])(
    'rejects mismatched provider %s',
    async function (field) {
      const order = await createOrder();
      await post(order.id, 'payment', randomUUID());
      const unit = data.purchase_units![0];
      if (field === 'currency') unit.amount.currency_code = 'EUR';
      if (field === 'merchant') unit.payee.merchant_id = 'ANOTHER-MERCHANT';
      if (field === 'reference') unit.custom_id = randomUUID();
      if (field === 'order-id') data.id = 'ANOTHER-PROVIDER-ORDER';
      expect((await post(order.id, 'capture', randomUUID())).status).toBe(502);
      expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('CREATED');
    }
  );
  it('rolls back webhook processing when the provider response fails validation', async function () {
    const order = await payOrder();
    data.purchase_units![0].amount.currency_code = 'EUR';
    expect((await webhook('BAD-PROVIDER')).status).toBe(502);
    expect(
      (await pool.query("SELECT status FROM webhook_events WHERE provider_event_id='BAD-PROVIDER'"))
        .rows[0].status
    ).toBe('RECEIVED');
    expect((await buyer.get('/api/orders/' + order.id)).body.status).toBe('PAID');
  });
  it('rejects changed financial payloads rather than silently reusing their keys', async function () {
    const order = await createOrder();
    const result = await buyer
      .post('/api/orders/' + order.id + '/payment')
      .set('Origin', config.origin)
      .set('X-CSRF-Token', token)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 1 });
    expect(result.status).toBe(400);
    expect(provider.create).not.toHaveBeenCalled();
  });
});
