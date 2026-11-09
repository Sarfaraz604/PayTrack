import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AppError } from './errors.js';

export interface CartItem {
  productId: number;
  quantity: number;
}
export interface Product {
  id: number;
  name: string;
  description: string;
  price_minor: number;
}
export interface User {
  id: string;
  email: string;
  role: string;
}
export interface Order {
  id: string;
  user_id: string;
  total_minor: number;
  currency: string;
  status: string;
  created_at: string;
}

export function readKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) {
    throw new AppError(
      400,
      'Send an Idempotency-Key containing 16–80 letters, numbers or hyphens.'
    );
  }
  return value;
}

export function validateCart(input: unknown): CartItem[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) {
    throw new AppError(400, 'Choose between 1 and 20 different products.');
  }
  const items: CartItem[] = [];
  for (const item of input) {
    if (
      !item ||
      !Number.isSafeInteger(item.productId) ||
      item.productId < 1 ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10
    ) {
      throw new AppError(400, 'Each product needs an integer quantity between 1 and 10.');
    }
    if (
      items.find(function (existing) {
        return existing.productId === item.productId;
      })
    ) {
      throw new AppError(400, 'Each product must appear only once.');
    }
    items.push({ productId: item.productId, quantity: item.quantity });
  }
  items.sort(function (first, second) {
    return first.productId - second.productId;
  });
  return items;
}

export function calculateTotal(items: CartItem[], products: Product[]): number {
  let total = 0;
  for (const item of items) {
    const product = products.find(function (candidate) {
      return candidate.id === item.productId;
    });
    if (!product) throw new AppError(400, 'A selected product is unavailable.');
    total += product.price_minor * item.quantity;
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total > 100000000) {
    throw new AppError(400, 'The order total is outside the allowed range.');
  }
  return total;
}

export async function createOrder(
  pool: Pool,
  user: User,
  key: string,
  input: unknown
): Promise<Order> {
  const items = validateCart(input);
  const payload = JSON.stringify(items);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializes concurrent creates from this user; PostgreSQL releases the lock at commit.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    const existing = await client.query(
      'SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2',
      [user.id, key]
    );
    if (existing.rows.length > 0) {
      const previousItems = validateCart(existing.rows[0].request_payload);
      if (JSON.stringify(previousItems) !== payload) {
        throw new AppError(409, 'This idempotency key was already used for a different cart.');
      }
      await client.query('COMMIT');
      return existing.rows[0];
    }
    const productIds = items.map(function (item) {
      return item.productId;
    });
    const products = await client.query(
      'SELECT * FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE',
      [productIds]
    );
    const total = calculateTotal(items, products.rows);
    const result = await client.query(
      'INSERT INTO orders (id, user_id, idempotency_key, request_payload, total_minor) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [randomUUID(), user.id, key, payload, total]
    );
    for (const item of items) {
      const product = products.rows.find(function (candidate: Product) {
        return candidate.id === item.productId;
      });
      await client.query(
        'INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_minor) VALUES ($1,$2,$3,$4,$5)',
        [result.rows[0].id, product.id, product.name, item.quantity, product.price_minor]
      );
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getOrder(pool: Pool, id: string, user: User): Promise<Order> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AppError(404, 'Order not found.');
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const order = result.rows[0];
  if (!order || (user.role !== 'merchant' && order.user_id !== user.id)) {
    throw new AppError(404, 'Order not found.');
  }
  return order;
}
