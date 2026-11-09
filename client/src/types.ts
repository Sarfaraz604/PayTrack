export interface User {
  id: string;
  email: string;
  role: string;
}
export interface Product {
  id: number;
  name: string;
  description: string;
  price_minor: number;
}
export interface OrderSummary {
  id: string;
  total_minor: number;
  status: string;
  created_at: string;
  payment_status: string | null;
  refund_status: string | null;
}
export interface OrderDetails extends OrderSummary {
  user_id: string;
  items: { product_id: number; product_name: string; quantity: number; unit_price_minor: number }[];
  payment: {
    status: string;
    approval_url: string | null;
    provider_order_id: string;
    capture_id: string;
  } | null;
  refund: { status: string; provider_refund_id: string } | null;
  events: { provider_event_id: string; event_type: string; status: string; created_at: string }[];
}
export interface SessionResult {
  user: User | null;
  csrfToken: string;
}
