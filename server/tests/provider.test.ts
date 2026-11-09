import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayPal } from '../src/paypal.js';
import { Config } from '../src/config.js';
import { Order } from '../src/orders.js';

const config: Config = {
  databaseUrl: '',
  sessionSecret: '',
  origin: 'http://localhost:5173',
  production: false,
  paypalClientId: 'fake-client',
  paypalSecret: 'fake-secret',
  paypalMerchantId: 'fake-merchant',
  paypalWebhookId: 'fake-webhook'
};
const order: Order = {
  id: 'local-order',
  user_id: 'buyer',
  total_minor: 3600,
  currency: 'USD',
  status: 'CREATED',
  created_at: ''
};

afterEach(function () {
  vi.unstubAllGlobals();
});

describe('PayPal HTTP adapter (mocked fetch, no credentials)', function () {
  function mockFetch(result: object) {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'fake-token' }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  it('creates sandbox orders with authoritative USD amounts and stable request IDs', async function () {
    const fetchMock = mockFetch({ id: 'provider-order' });
    await new PayPal(config).create(order, 'stable-create-id');
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(options.headers['PayPal-Request-Id']).toBe('stable-create-id');
    const body = JSON.parse(options.body);
    expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '36.00' });
    expect(body.purchase_units[0].custom_id).toBe('local-order');
    expect(body.payment_source.paypal.experience_context.return_url).toBe(
      config.origin + '/?approved=local-order'
    );
  });
  it('captures the expected provider order using its persisted request ID', async function () {
    const fetchMock = mockFetch({ id: 'provider-order' });
    await new PayPal(config).capture('provider-order', 'stable-capture-id');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api-m.sandbox.paypal.com/v2/checkout/orders/provider-order/capture'
    );
    expect(fetchMock.mock.calls[1][1].headers['PayPal-Request-Id']).toBe('stable-capture-id');
  });
  it('sends a full refund tied to the local refund record', async function () {
    const fetchMock = mockFetch({ id: 'refund' });
    await new PayPal(config).refund('capture', order, 'local-refund', 'stable-refund-id');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      amount: { value: '36.00', currency_code: 'USD' },
      invoice_id: 'local-refund'
    });
  });
  it('posts signature data and the original parsed event to official verification', async function () {
    const fetchMock = mockFetch({ verification_status: 'SUCCESS' });
    const event = {
      id: 'event',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'capture', status: 'COMPLETED' }
    };
    const verified = await new PayPal(config).verify(
      { 'paypal-transmission-id': 'transmission', 'paypal-transmission-sig': 'signature' },
      event
    );
    expect(verified).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.webhook_id).toBe('fake-webhook');
    expect(body.webhook_event).toEqual(event);
    expect(body.transmission_sig).toBe('signature');
  });
  it('surfaces a transport timeout instead of inventing a failed financial result', async function () {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'fake-token' }), { status: 200 })
    );
    fetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new PayPal(config).capture('provider-order', 'stable-key')).rejects.toThrow(
      'Timed out'
    );
  });
});
