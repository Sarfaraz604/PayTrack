import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { AppError } from './errors.js';
import { Order } from './orders.js';
import { PaymentProvider, ProviderOrder, ProviderResource, checkAmount } from './paypal.js';

export interface Payment {
  id: string;
  order_id: string;
  create_key: string;
  capture_key: string | null;
  create_request_id: string;
  capture_request_id: string;
  provider_order_id: string | null;
  capture_id: string | null;
  approval_url: string | null;
  status: string;
  created_at: Date;
}
export interface Refund {
  id: string;
  payment_id: string;
  idempotency_key: string;
  request_id: string;
  provider_refund_id: string | null;
  status: string;
  created_at: Date;
}

function checkProviderOrder(
  order: Order,
  data: ProviderOrder,
  merchantId: string,
  expectedId?: string | null
): void {
  if (
    !data.id ||
    (expectedId && data.id !== expectedId) ||
    data.intent !== 'CAPTURE' ||
    data.purchase_units?.length !== 1
  ) {
    throw new AppError(502, 'Unexpected PayPal order. Reconciliation is required.');
  }
  const unit = data.purchase_units[0];
  if (
    unit.reference_id !== order.id ||
    unit.custom_id !== order.id ||
    unit.payee?.merchant_id !== merchantId
  ) {
    throw new AppError(502, 'PayPal order identifiers do not match.');
  }
  checkAmount(unit.amount, order.total_minor);
}

export async function startPayment(
  pool: Pool,
  provider: PaymentProvider,
  order: Order,
  key: string
): Promise<Payment> {
  const client = await pool.connect();
  let payment: Payment;
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
    const existing = await client.query('SELECT * FROM payment_attempts WHERE order_id = $1', [
      order.id
    ]);
    if (existing.rows.length) {
      payment = existing.rows[0];
      if (payment.create_key !== key)
        throw new AppError(409, 'This order already has a payment. Check its status.');
      await client.query('COMMIT');
      return payment;
    }
    if (locked.rows[0].status !== 'CREATED')
      throw new AppError(409, 'This order cannot be paid again.');
    const result = await client.query(
      `INSERT INTO payment_attempts (id,order_id,create_key,create_request_id,capture_request_id,status)
       VALUES ($1,$2,$3,$4,$5,'CREATING') RETURNING *`,
      [randomUUID(), order.id, key, randomUUID(), randomUUID()]
    );
    payment = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    const data = await provider.create(order, payment.create_request_id);
    await saveCreatedPayment(pool, provider, order, payment, data);
  } catch (error) {
    await pool.query(
      "UPDATE payment_attempts SET status = 'UNKNOWN' WHERE id = $1 AND status = 'CREATING'",
      [payment.id]
    );
    throw error;
  }
  return (await pool.query('SELECT * FROM payment_attempts WHERE id = $1', [payment.id])).rows[0];
}

async function saveCreatedPayment(
  pool: Pool,
  provider: PaymentProvider,
  order: Order,
  payment: Payment,
  data: ProviderOrder
): Promise<void> {
  checkProviderOrder(order, data, provider.merchantId, payment.provider_order_id);
  const link = data.links?.find(function (item) {
    return item.rel === 'payer-action' || item.rel === 'approve';
  });
  let approvalUrl: string | null = null;
  if (link) {
    const url = new URL(link.href);
    if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com') {
      throw new AppError(502, 'Unexpected PayPal approval address.');
    }
    approvalUrl = url.href;
  }
  await pool.query(
    `UPDATE payment_attempts SET provider_order_id=$2, approval_url=$3, status='APPROVAL_PENDING'
     WHERE id=$1 AND status IN ('CREATING','UNKNOWN') AND capture_key IS NULL`,
    [payment.id, data.id, approvalUrl]
  );
}

export async function capturePayment(
  pool: Pool,
  provider: PaymentProvider,
  order: Order,
  key: string
): Promise<void> {
  // The conditional update is an atomic claim. Only its winner calls PayPal.
  const claimed = await pool.query(
    `UPDATE payment_attempts SET capture_key=$2, status='CAPTURING'
     WHERE order_id=$1 AND status='APPROVAL_PENDING' AND capture_key IS NULL RETURNING *`,
    [order.id, key]
  );
  if (!claimed.rows.length) {
    const existing = (
      await pool.query('SELECT * FROM payment_attempts WHERE order_id=$1', [order.id])
    ).rows[0];
    if (!existing) throw new AppError(409, 'Start a payment first.');
    if (existing.capture_key && existing.capture_key !== key)
      throw new AppError(409, 'Capture already requested with another key.');
    if (!existing.capture_key)
      throw new AppError(409, 'Check the pending payment before capturing.');
    return;
  }
  const payment: Payment = claimed.rows[0];
  try {
    const data = await provider.capture(payment.provider_order_id!, payment.capture_request_id);
    await applyPayment(pool, provider, order, payment, data);
  } catch (error) {
    await pool.query(
      "UPDATE payment_attempts SET status='UNKNOWN' WHERE id=$1 AND status='CAPTURING'",
      [payment.id]
    );
    throw error;
  }
}

// Accepts either a Pool or an existing transaction, so webhook updates commit together.
export async function applyPayment(
  db: Pool | PoolClient,
  provider: PaymentProvider,
  order: Order,
  payment: Payment,
  data: ProviderOrder
): Promise<void> {
  checkProviderOrder(order, data, provider.merchantId, payment.provider_order_id);
  const captures = data.purchase_units![0].payments?.captures || [];
  if (captures.length > 1) throw new AppError(502, 'Multiple captures require manual review.');
  if (captures.length === 0) return;
  const capture = captures[0];
  if (!capture.id || (payment.capture_id && capture.id !== payment.capture_id))
    throw new AppError(502, 'Unexpected capture identifier.');
  checkAmount(capture.amount, order.total_minor);
  let status = 'PENDING';
  if (capture.status === 'COMPLETED') status = 'COMPLETED';
  else if (capture.status === 'DECLINED' || capture.status === 'FAILED') status = 'FAILED';
  else if (capture.status === 'REFUNDED') status = 'REFUNDED';
  else if (capture.status !== 'PENDING')
    throw new AppError(502, 'Unsupported capture status requires review.');

  // A single statement atomically updates both payment and order, even outside a transaction.
  await db.query(
    `WITH changed AS (
       UPDATE payment_attempts SET capture_id=$2, status=$3 WHERE id=$1
       AND (capture_id IS NULL OR capture_id=$2)
       AND status <> 'REFUNDED' AND (status <> 'COMPLETED' OR $3 IN ('COMPLETED','REFUNDED'))
       AND (status <> 'FAILED' OR $3 IN ('FAILED','COMPLETED','REFUNDED'))
       RETURNING order_id, status
     ) UPDATE orders SET status = CASE WHEN changed.status='REFUNDED' THEN 'REFUNDED' ELSE 'PAID' END
       FROM changed WHERE orders.id=changed.order_id AND changed.status IN ('COMPLETED','REFUNDED') AND orders.status <> 'REFUNDED'`,
    [payment.id, capture.id, status]
  );
}

export async function startRefund(
  pool: Pool,
  provider: PaymentProvider,
  order: Order,
  key: string
): Promise<Refund> {
  const client = await pool.connect();
  let refund: Refund;
  let payment: Payment;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM payment_attempts WHERE order_id=$1 FOR UPDATE',
      [order.id]
    );
    payment = result.rows[0];
    if (!payment) throw new AppError(409, 'There is no completed payment to refund.');
    const existing = await client.query('SELECT * FROM refunds WHERE payment_id=$1', [payment.id]);
    if (existing.rows.length) {
      refund = existing.rows[0];
      if (refund.idempotency_key !== key)
        throw new AppError(409, 'A refund already exists. Check its status.');
      await client.query('COMMIT');
      return refund;
    }
    if (payment.status !== 'COMPLETED' || !payment.capture_id)
      throw new AppError(409, 'Only completed payments can be refunded.');
    refund = (
      await client.query(
        "INSERT INTO refunds (id,payment_id,idempotency_key,request_id,status) VALUES ($1,$2,$3,$4,'REQUESTING') RETURNING *",
        [randomUUID(), payment.id, key, randomUUID()]
      )
    ).rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  try {
    const data = await provider.refund(payment.capture_id!, order, refund.id, refund.request_id);
    await applyRefund(pool, order, payment, refund, data);
  } catch (error) {
    await pool.query("UPDATE refunds SET status='UNKNOWN' WHERE id=$1 AND status='REQUESTING'", [
      refund.id
    ]);
    throw error;
  }
  return (await pool.query('SELECT * FROM refunds WHERE id=$1', [refund.id])).rows[0];
}

export async function applyRefund(
  db: Pool | PoolClient,
  order: Order,
  payment: Payment,
  refund: Refund,
  data: ProviderResource
): Promise<void> {
  if (
    !data.id ||
    (refund.provider_refund_id && data.id !== refund.provider_refund_id) ||
    data.invoice_id !== refund.id
  ) {
    throw new AppError(502, 'Unexpected PayPal refund identifiers.');
  }
  checkAmount(data.amount, order.total_minor);
  const captureLink = data.links?.find(function (link) {
    return link.rel === 'up';
  });
  if (captureLink) {
    const url = new URL(captureLink.href);
    if (url.pathname !== '/v2/payments/captures/' + payment.capture_id) {
      throw new AppError(502, 'Refund refers to a different capture.');
    }
  }
  let status = 'PENDING';
  if (data.status === 'COMPLETED') status = 'COMPLETED';
  else if (data.status === 'FAILED' || data.status === 'CANCELLED') status = 'FAILED';
  else if (data.status !== 'PENDING') throw new AppError(502, 'Unexpected refund status.');
  await db.query(
    `WITH changed AS (
       UPDATE refunds SET provider_refund_id=$2, status=$3 WHERE id=$1 AND status <> 'COMPLETED'
       AND (status <> 'FAILED' OR $3 IN ('FAILED','COMPLETED')) RETURNING payment_id,status
     ), paid AS (
       UPDATE payment_attempts SET status='REFUNDED' FROM changed
       WHERE payment_attempts.id=changed.payment_id AND changed.status='COMPLETED' RETURNING order_id
     ) UPDATE orders SET status='REFUNDED' FROM paid WHERE orders.id=paid.order_id`,
    [refund.id, data.id, status]
  );
}

export async function reconcileOrder(
  pool: Pool,
  provider: PaymentProvider,
  order: Order,
  recoveryRefundId?: string
): Promise<void> {
  const payment: Payment = (
    await pool.query('SELECT * FROM payment_attempts WHERE order_id=$1', [order.id])
  ).rows[0];
  if (!payment) return;
  if (!payment.provider_order_id) {
    // Conservative window below Orders API's documented six-hour default retention.
    const age = Date.now() - new Date(payment.created_at).getTime();
    if (age < 60000)
      throw new AppError(409, 'Allow one minute for the original request to settle.');
    if (age > 5 * 60 * 60 * 1000)
      throw new AppError(
        409,
        'Creation recovery window expired. Review this request in the Sandbox dashboard.'
      );
    const data = await provider.create(order, payment.create_request_id);
    await saveCreatedPayment(pool, provider, order, payment, data);
  } else {
    const data = await provider.getOrder(payment.provider_order_id);
    await applyPayment(pool, provider, order, payment, data);
    // A GET showing no capture still cannot prove the original request stopped.
    if (
      data.status === 'APPROVED' &&
      !data.purchase_units?.[0].payments?.captures?.length &&
      payment.status === 'UNKNOWN'
    ) {
      // Keep the original capture key/request ID; no automatic financial retry is made.
      throw new AppError(
        409,
        'Capture is still uncertain. Review in Sandbox; this app will not repeat it automatically.'
      );
    }
  }
  const refund: Refund = (
    await pool.query('SELECT * FROM refunds WHERE payment_id=$1', [payment.id])
  ).rows[0];
  if (!refund || refund.status === 'COMPLETED') return;
  const refundId = refund.provider_refund_id || recoveryRefundId;
  if (refundId) {
    const data = await provider.getRefund(refundId);
    if (data.id !== refundId) throw new AppError(502, 'Unexpected refund lookup identifier.');
    await applyRefund(pool, order, payment, refund, data);
  }
  // Without a refund ID, a verified webhook or merchant dashboard lookup can recover it.
  // We deliberately never POST another refund during reconciliation.
}
