import { Pool } from 'pg';
import { AppError } from './errors.js';
import { Order } from './orders.js';
import { PaymentProvider, WebhookEvent, ProviderResource } from './paypal.js';
import { Payment, Refund, applyPayment, applyRefund } from './payments.js';

export async function processWebhook(
  pool: Pool,
  provider: PaymentProvider,
  headers: Record<string, string>,
  input: unknown
): Promise<void> {
  const event = input as WebhookEvent | null;
  if (
    !event ||
    typeof event.id !== 'string' ||
    event.id.length > 100 ||
    typeof event.event_type !== 'string' ||
    !event.resource ||
    typeof event.resource.id !== 'string' ||
    event.resource.id.length > 100
  ) {
    throw new AppError(400, 'Malformed webhook.');
  }
  const required = [
    'paypal-auth-algo',
    'paypal-cert-url',
    'paypal-transmission-id',
    'paypal-transmission-sig',
    'paypal-transmission-time'
  ];
  for (const header of required) {
    if (!headers[header]) throw new AppError(400, 'Missing webhook signature headers.');
  }
  if (!(await provider.verify(headers, event)))
    throw new AppError(400, 'Invalid webhook signature.');
  const previous = await pool.query(
    'SELECT status FROM webhook_events WHERE provider_event_id=$1',
    [event.id]
  );
  if (previous.rows[0]?.status === 'PROCESSED' || previous.rows[0]?.status === 'IGNORED') return;

  const related = event.resource.supplementary_data?.related_ids;
  const providerOrderId = related?.order_id || null;
  const captureId = related?.capture_id || event.resource.id;
  // Provider IDs are stored, not whole webhook payloads containing customer information.
  await pool.query(
    `INSERT INTO webhook_events (provider_event_id,event_type,resource_id,provider_order_id,status)
     VALUES ($1,$2,$3,$4,'RECEIVED') ON CONFLICT DO NOTHING`,
    [event.id, event.event_type, event.resource.id, providerOrderId]
  );
  const supported = [
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.REFUNDED',
    'PAYMENT.REFUND.PENDING',
    'PAYMENT.REFUND.FAILED'
  ];
  if (!supported.includes(event.event_type)) {
    await pool.query("UPDATE webhook_events SET status='IGNORED' WHERE provider_event_id=$1", [
      event.id
    ]);
    return;
  }
  const payment: Payment = (
    await pool.query(
      `SELECT payment_attempts.* FROM payment_attempts LEFT JOIN refunds ON refunds.payment_id=payment_attempts.id
     WHERE provider_order_id=$1 OR capture_id=$2 OR refunds.provider_refund_id=$3 OR refunds.id::text=$4`,
      [providerOrderId, captureId, event.resource.id, event.resource.invoice_id || null]
    )
  ).rows[0];
  if (!payment) {
    await pool.query("UPDATE webhook_events SET status='UNMATCHED' WHERE provider_event_id=$1", [
      event.id
    ]);
    throw new AppError(503, 'Payment is not linked yet. Retry webhook delivery.');
  }
  const order: Order = (await pool.query('SELECT * FROM orders WHERE id=$1', [payment.order_id]))
    .rows[0];
  // Read current provider state: event arrival order must never determine payment state.
  const providerOrder = await provider.getOrder(payment.provider_order_id!);
  const refund: Refund = (
    await pool.query('SELECT * FROM refunds WHERE payment_id=$1', [payment.id])
  ).rows[0];
  let providerRefund: ProviderResource | undefined;
  if (
    event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ||
    event.event_type.startsWith('PAYMENT.REFUND.')
  ) {
    if (refund) providerRefund = await provider.getRefund(event.resource.id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM webhook_events WHERE provider_event_id=$1 FOR UPDATE',
      [event.id]
    );
    if (locked.rows[0].status !== 'PROCESSED') {
      if (refund && providerRefund)
        await applyRefund(client, order, payment, refund, providerRefund);
      await applyPayment(client, provider, order, payment, providerOrder);
      await client.query(
        "UPDATE webhook_events SET status='PROCESSED', order_id=$2 WHERE provider_event_id=$1",
        [event.id, order.id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
