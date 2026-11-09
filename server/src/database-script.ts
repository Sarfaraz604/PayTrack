import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import argon2 from 'argon2';

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7812401)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const existing = await client.query('SELECT version FROM schema_migrations WHERE version=1');
    if (!existing.rows.length) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function seed(pool: Pool): Promise<void> {
  const products = [
    {
      id: 1,
      name: 'Everyday notebook',
      description: 'A quiet place for your next big idea. 160 dotted pages.',
      price: 1800
    },
    {
      id: 2,
      name: 'Studio mug',
      description: 'A little ritual for your desk. Matte ceramic, 350 ml.',
      price: 2400
    },
    {
      id: 3,
      name: 'Canvas tote',
      description: 'Your everyday carry. Natural cotton with reinforced handles.',
      price: 3200
    }
  ];
  for (const product of products) {
    await pool.query(
      'INSERT INTO products (id,name,description,price_minor) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [product.id, product.name, product.description, product.price]
    );
  }
  const password = process.env.MERCHANT_PASSWORD || '';
  const email = (process.env.MERCHANT_EMAIL || '').trim().toLowerCase();
  if (password.length < 12 || password.length > 128 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'Products seeded. To create a merchant, set a valid MERCHANT_EMAIL and MERCHANT_PASSWORD (12–128 characters).'
    );
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const result = await pool.query(
    `INSERT INTO users (id,email,password_hash,role) VALUES ($1,$2,$3,'merchant') ON CONFLICT DO NOTHING RETURNING id`,
    [randomUUID(), email, hash]
  );
  if (!result.rows.length)
    console.log('Merchant email already exists; its role and password were preserved.');
}

// Only run the CLI when this file is the entry point; tests import migrate safely.
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/database-script.ts')) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
    if (process.argv[2] === 'migrate') await migrate(pool);
    else if (process.argv[2] === 'seed') await seed(pool);
    else throw new Error('Use migrate or seed.');
    console.log('Database command completed.');
  } finally {
    await pool.end();
  }
}
