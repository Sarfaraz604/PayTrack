import { Config } from './config.js';
import { AppError } from './errors.js';
import { Order } from './orders.js';

export interface ProviderAmount {
  value: string;
  currency_code: string;
}
export interface ProviderResource {
  id: string;
  status: string;
  amount?: ProviderAmount;
  custom_id?: string;
  invoice_id?: string;
  payee?: { merchant_id: string };
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
  links?: { rel: string; href: string }[];
}
export interface ProviderOrder {
  id: string;
  status: string;
  intent?: string;
  links?: { rel: string; href: string }[];
  purchase_units?: {
    reference_id: string;
    custom_id: string;
    amount: ProviderAmount;
    payee: { merchant_id: string };
    payments?: { captures?: ProviderResource[] };
  }[];
}
export interface WebhookEvent {
  id: string;
  event_type: string;
  resource: ProviderResource;
}

// USD has two decimal places. All application arithmetic stays in integer cents.
export function paypalAmount(minor: number): string {
  return (minor / 100).toFixed(2);
}
export function checkAmount(amount: ProviderAmount | undefined, total: number): void {
  if (!amount || amount.currency_code !== 'USD' || amount.value !== paypalAmount(total)) {
    throw new AppError(
      502,
      'PayPal returned an unexpected amount or currency. Reconcile this order.'
    );
  }
}

export interface PaymentProvider {
  merchantId: string;
  create(order: Order, requestId: string): Promise<ProviderOrder>;
  capture(providerId: string, requestId: string): Promise<ProviderOrder>;
  getOrder(providerId: string): Promise<ProviderOrder>;
  refund(
    captureId: string,
    order: Order,
    refundId: string,
    requestId: string
  ): Promise<ProviderResource>;
  getRefund(refundId: string): Promise<ProviderResource>;
  verify(headers: Record<string, string>, event: WebhookEvent): Promise<boolean>;
}

export class PayPal implements PaymentProvider {
  merchantId: string;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.merchantId = config.paypalMerchantId;
  }

  private async request(
    method: string,
    path: string,
    body?: object,
    requestId?: string
  ): Promise<unknown> {
    if (!this.config.paypalClientId || !this.config.paypalSecret || !this.merchantId) {
      throw new AppError(503, 'PayPal Sandbox is not configured. Your order is saved.');
    }
    // A timeout aborts our wait, not the provider's operation. Callers preserve UNKNOWN.
    const tokenResponse = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(this.config.paypalClientId + ':' + this.config.paypalSecret).toString(
            'base64'
          ),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    if (!tokenResponse.ok) throw new AppError(502, 'PayPal authentication is unavailable.');
    const token = (await tokenResponse.json()) as { access_token: string };
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + token.access_token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const response = await fetch('https://api-m.sandbox.paypal.com' + path, {
      method,
      headers,
      signal: AbortSignal.timeout(15000),
      body: body ? JSON.stringify(body) : undefined
    });
    // Even an HTTP error can need investigation (for example ORDER_ALREADY_CAPTURED).
    if (!response.ok)
      throw new AppError(
        502,
        'PayPal could not confirm the operation. Check status before retrying.'
      );
    return response.json();
  }

  async create(order: Order, requestId: string): Promise<ProviderOrder> {
    return (await this.request(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: order.id,
            custom_id: order.id,
            payee: { merchant_id: this.merchantId },
            amount: { currency_code: 'USD', value: paypalAmount(order.total_minor) }
          }
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'PayTrack Sandbox',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: this.config.origin + '/?approved=' + order.id,
              cancel_url: this.config.origin + '/?cancelled=' + order.id
            }
          }
        }
      },
      requestId
    )) as ProviderOrder;
  }
  async capture(providerId: string, requestId: string): Promise<ProviderOrder> {
    return (await this.request(
      'POST',
      '/v2/checkout/orders/' + encodeURIComponent(providerId) + '/capture',
      {},
      requestId
    )) as ProviderOrder;
  }
  async getOrder(providerId: string): Promise<ProviderOrder> {
    return (await this.request(
      'GET',
      '/v2/checkout/orders/' + encodeURIComponent(providerId)
    )) as ProviderOrder;
  }
  async refund(
    captureId: string,
    order: Order,
    refundId: string,
    requestId: string
  ): Promise<ProviderResource> {
    return (await this.request(
      'POST',
      '/v2/payments/captures/' + encodeURIComponent(captureId) + '/refund',
      {
        amount: { currency_code: 'USD', value: paypalAmount(order.total_minor) },
        invoice_id: refundId
      },
      requestId
    )) as ProviderResource;
  }
  async getRefund(refundId: string): Promise<ProviderResource> {
    return (await this.request(
      'GET',
      '/v2/payments/refunds/' + encodeURIComponent(refundId)
    )) as ProviderResource;
  }
  async verify(headers: Record<string, string>, event: WebhookEvent): Promise<boolean> {
    if (!this.config.paypalWebhookId)
      throw new AppError(503, 'Sandbox webhook verification is not configured.');
    const result = (await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: this.config.paypalWebhookId,
      webhook_event: event
    })) as { verification_status: string };
    return result.verification_status === 'SUCCESS';
  }
}
