CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('customer', 'merchant')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor > 0 AND price_minor <= 1000000)
);
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  request_payload jsonb NOT NULL,
  total_minor integer NOT NULL CHECK (total_minor > 0 AND total_minor <= 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'REFUNDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user_created ON orders(user_id, created_at DESC);
CREATE TABLE order_items (
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id integer NOT NULL REFERENCES products(id),
  product_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor > 0),
  PRIMARY KEY (order_id, product_id)
);
-- One logical PayPal order and one capture per local order in this version.
CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  create_key text NOT NULL,
  capture_key text,
  create_request_id uuid NOT NULL UNIQUE,
  capture_request_id uuid NOT NULL UNIQUE,
  provider_order_id text UNIQUE,
  capture_id text UNIQUE,
  approval_url text,
  status text NOT NULL CHECK (status IN ('CREATING', 'APPROVAL_PENDING', 'CAPTURING', 'PENDING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REFUNDED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL UNIQUE REFERENCES payment_attempts(id),
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  provider_refund_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('REQUESTING', 'PENDING', 'UNKNOWN', 'COMPLETED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events (
  provider_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  resource_id text,
  provider_order_id text,
  order_id uuid REFERENCES orders(id),
  status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'UNMATCHED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_order ON webhook_events(order_id, created_at);
CREATE TABLE session (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp NOT NULL
);
CREATE INDEX session_expire ON session(expire);
