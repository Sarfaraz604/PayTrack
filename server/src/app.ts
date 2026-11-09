import { randomUUID } from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { Config } from './config.js';
import { AppError } from './errors.js';
import {
  requireUser,
  requireMerchant,
  checkCsrf,
  csrfToken,
  readCredentials,
  startSession
} from './auth.js';
import { createOrder, getOrder, readKey } from './orders.js';
import { PaymentProvider } from './paypal.js';
import { startPayment, capturePayment, startRefund, reconcileOrder } from './payments.js';
import { processWebhook } from './webhooks.js';

export function createApp(pool: Pool, config: Config, provider: PaymentProvider) {
  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));
  app.get('/api/health', async function (request, response) {
    await pool.query('SELECT 1');
    response.json({ status: 'ok', environment: 'PayPal Sandbox only' });
  });
  // PayPal authenticates this route by signature, not a browser session/CSRF token.
  app.post('/api/webhooks/paypal', async function (request, response) {
    const headers: Record<string, string> = {};
    for (const name of [
      'paypal-auth-algo',
      'paypal-cert-url',
      'paypal-transmission-id',
      'paypal-transmission-sig',
      'paypal-transmission-time'
    ]) {
      headers[name] = request.get(name) || '';
    }
    await processWebhook(pool, provider, headers, request.body);
    response.sendStatus(204);
  });
  const PgSession = connectPgSimple(session);
  app.use(
    session({
      store: new PgSession({ pool, createTableIfMissing: false }),
      name: 'paytrack.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.production,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000
      }
    })
  );
  app.use('/api', function (request, response, next) {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) checkCsrf(request, config.origin);
    next();
  });
  app.get('/api/session', function (request, response) {
    response.json({
      user: request.session.user || null,
      csrfToken: csrfToken(request),
      sandbox: true
    });
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many login attempts. Please try again later.' },
    skip: function () {
      return process.env.NODE_ENV === 'test';
    }
  });
  app.post('/api/register', authLimiter, async function (request, response) {
    const credentials = readCredentials(request.body);
    const hash = await argon2.hash(credentials.password, { type: argon2.argon2id });
    const result = await pool.query(
      `INSERT INTO users (id,email,password_hash,role) VALUES ($1,$2,$3,'customer')
       ON CONFLICT (email) DO NOTHING RETURNING id,email,role`,
      [randomUUID(), credentials.email, hash]
    );
    if (!result.rows.length)
      throw new AppError(409, 'Unable to register with these details. Try logging in.');
    await startSession(request, result.rows[0]);
    response.status(201).json({ user: request.session.user, csrfToken: csrfToken(request) });
  });
  app.post('/api/login', authLimiter, async function (request, response) {
    const credentials = readCredentials(request.body);
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [credentials.email]);
    const user = result.rows[0];
    if (!user || !(await argon2.verify(user.password_hash, credentials.password)))
      throw new AppError(401, 'Email or password is incorrect.');
    await startSession(request, { id: user.id, email: user.email, role: user.role });
    response.json({ user: request.session.user, csrfToken: csrfToken(request) });
  });
  app.post('/api/logout', requireUser, async function (request, response) {
    await new Promise<void>(function (resolve, reject) {
      request.session.destroy(function (error) {
        if (error) reject(error);
        else resolve();
      });
    });
    response.clearCookie('paytrack.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production
    });
    response.sendStatus(204);
  });
  app.get('/api/products', async function (request, response) {
    response.json((await pool.query('SELECT * FROM products ORDER BY id')).rows);
  });
  app.use('/api/orders', requireUser);
  app.get('/api/orders', async function (request, response) {
    const user = request.session.user!;
    const result = await pool.query(
      `SELECT orders.*, payment_attempts.status AS payment_status, refunds.status AS refund_status
       FROM orders LEFT JOIN payment_attempts ON payment_attempts.order_id=orders.id
       LEFT JOIN refunds ON refunds.payment_id=payment_attempts.id
       WHERE ($1='merchant' OR orders.user_id=$2) ORDER BY orders.created_at DESC LIMIT 100`,
      [user.role, user.id]
    );
    response.json(result.rows);
  });
  app.post('/api/orders', async function (request, response) {
    const order = await createOrder(
      pool,
      request.session.user!,
      readKey(request.get('Idempotency-Key')),
      request.body?.items
    );
    response.status(201).json(order);
  });
  app.get('/api/orders/:id', async function (request, response) {
    const order = await getOrder(pool, String(request.params.id), request.session.user!);
    const items = await pool.query(
      'SELECT * FROM order_items WHERE order_id=$1 ORDER BY product_id',
      [order.id]
    );
    const payment = (
      await pool.query(
        'SELECT id,provider_order_id,capture_id,status,approval_url FROM payment_attempts WHERE order_id=$1',
        [order.id]
      )
    ).rows[0];
    const refund = (
      await pool.query(
        'SELECT refunds.id,refunds.status,refunds.provider_refund_id FROM refunds JOIN payment_attempts ON payment_attempts.id=refunds.payment_id WHERE payment_attempts.order_id=$1',
        [order.id]
      )
    ).rows[0];
    let events: object[] = [];
    if (request.session.user!.role === 'merchant') {
      events = (
        await pool.query(
          'SELECT * FROM webhook_events WHERE order_id=$1 ORDER BY created_at DESC',
          [order.id]
        )
      ).rows;
    }
    response.json({
      ...order,
      items: items.rows,
      payment: payment || null,
      refund: refund || null,
      events
    });
  });
  app.post('/api/orders/:id/payment', async function (request, response) {
    requireEmptyBody(request);
    const order = await getOrder(pool, String(request.params.id), request.session.user!);
    if (order.user_id !== request.session.user!.id)
      throw new AppError(403, 'Only the buyer may start checkout.');
    const payment = await startPayment(
      pool,
      provider,
      order,
      readKey(request.get('Idempotency-Key'))
    );
    response.json({ status: payment.status, approval_url: payment.approval_url });
  });
  app.post('/api/orders/:id/capture', async function (request, response) {
    requireEmptyBody(request);
    const order = await getOrder(pool, String(request.params.id), request.session.user!);
    if (order.user_id !== request.session.user!.id)
      throw new AppError(403, 'Only the buyer may capture checkout.');
    await capturePayment(pool, provider, order, readKey(request.get('Idempotency-Key')));
    response
      .status(202)
      .json({ message: 'Payment checked. Refresh the order to see its verified status.' });
  });
  app.post('/api/orders/:id/refund', requireMerchant, async function (request, response) {
    requireEmptyBody(request);
    const order = await getOrder(pool, String(request.params.id), request.session.user!);
    const refund = await startRefund(
      pool,
      provider,
      order,
      readKey(request.get('Idempotency-Key'))
    );
    response.status(202).json({ status: refund.status });
  });
  app.post('/api/orders/:id/reconcile', async function (request, response) {
    const order = await getOrder(pool, String(request.params.id), request.session.user!);
    const refundId = request.body?.providerRefundId;
    if (refundId !== undefined) {
      if (request.session.user!.role !== 'merchant')
        throw new AppError(403, 'Only merchants may supply a refund recovery ID.');
      if (typeof refundId !== 'string' || !/^[A-Z0-9-]{1,100}$/.test(refundId))
        throw new AppError(400, 'Enter a valid Sandbox refund ID.');
    }
    await reconcileOrder(pool, provider, order, refundId);
    response.json({
      message: 'Provider status checked. Unknown operations may still need dashboard review.'
    });
  });
  app.use(function (request, response) {
    response.status(404).json({ message: 'Page not found.' });
  });
  app.use(function (error: unknown, request: Request, response: Response, next: NextFunction) {
    if (error instanceof AppError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ message: 'Invalid JSON request.' });
      return;
    }
    // Do not print provider responses, credentials, passwords or session data.
    console.error('Request failed:', request.method, request.path);
    response.status(500).json({
      message: 'The operation could not be confirmed. Refresh its status before retrying.'
    });
  });
  return app;
}

function requireEmptyBody(request: Request): void {
  // These operations have fixed payloads: the route identifies the whole order.
  if (request.body && Object.keys(request.body).length !== 0) {
    throw new AppError(400, 'This operation does not accept amounts or other request fields.');
  }
}
