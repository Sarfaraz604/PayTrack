import { OrderDetails, User } from './types';
import { Badge } from './Badge';
import { money } from './api';

interface OrderDetailsProps {
  selected: OrderDetails;
  user: User | null;
  busy: boolean;
  recoveryRefundId: string;
  onClose(): void;
  onAction(action: string): void;
  onRecoveryIdChange(value: string): void;
}

export function OrderDetailsPanel({
  selected,
  user,
  busy,
  recoveryRefundId,
  onClose,
  onAction,
  onRecoveryIdChange
}: OrderDetailsProps) {
  return (
    <article className="detail-panel">
      <div className="section-heading">
        <h2>Order details</h2>
        <button
          className="text-button"
          onClick={function () {
            onClose();
          }}
        >
          Close
        </button>
      </div>
      <code>{selected.id}</code>
      <div className="detail-statuses">
        <span>
          Order <Badge status={selected.status} />
        </span>
        <span>
          Payment <Badge status={selected.payment?.status} />
        </span>
        <span>
          Refund <Badge status={selected.refund?.status} />
        </span>
      </div>
      <ul className="detail-items">
        {selected.items.map(function (item) {
          return (
            <li key={item.product_id}>
              {item.quantity} × {item.product_name}
              <strong>{money(item.quantity * item.unit_price_minor)}</strong>
            </li>
          );
        })}
      </ul>
      <p>
        <strong>Total: {money(selected.total_minor)}</strong>
      </p>
      {(selected.payment?.status === 'UNKNOWN' || selected.refund?.status === 'UNKNOWN') && (
        <p className="pending-note">
          The provider outcome is uncertain. Check provider status; a timeout does not mean failure.
          A refund without a provider ID awaits a verified webhook or Sandbox dashboard review.
        </p>
      )}
      {user?.role === 'merchant' &&
        selected.refund?.status === 'UNKNOWN' &&
        !selected.refund.provider_refund_id && (
          <label className="recovery-label">
            Refund ID from the Sandbox dashboard (optional)
            <input
              value={recoveryRefundId}
              onChange={function (event) {
                onRecoveryIdChange(event.target.value);
              }}
              placeholder="Enter refund ID, then check provider status"
            />
          </label>
        )}
      <div className="detail-actions">
        {user?.id === selected.user_id && selected.status === 'CREATED' && !selected.payment && (
          <button
            className="primary"
            disabled={busy}
            onClick={function () {
              onAction('payment');
            }}
          >
            Continue to PayPal Sandbox ↗
          </button>
        )}
        {user?.id === selected.user_id && selected.payment?.status === 'APPROVAL_PENDING' && (
          <>
            <button
              className="primary"
              disabled={busy}
              onClick={function () {
                onAction('payment');
              }}
            >
              Open PayPal Sandbox ↗
            </button>
            <button
              disabled={busy}
              onClick={function () {
                onAction('capture');
              }}
            >
              Confirm payment
            </button>
          </>
        )}
        {user?.role === 'merchant' &&
          selected.payment?.status === 'COMPLETED' &&
          !selected.refund && (
            <button
              className="primary"
              disabled={busy}
              onClick={function () {
                onAction('refund');
              }}
            >
              Issue full sandbox refund · {money(selected.total_minor)}
            </button>
          )}
        {selected.payment && (
          <button
            disabled={busy}
            onClick={function () {
              onAction('reconcile');
            }}
          >
            Check provider status
          </button>
        )}
      </div>
      {selected.payment?.provider_order_id && (
        <p className="provider-reference">
          PayPal order: {selected.payment.provider_order_id}
          <br />
          Capture: {selected.payment.capture_id || 'Not confirmed'}
        </p>
      )}
      {user?.role === 'merchant' && (
        <section className="event-history">
          <h3>Payment event history</h3>
          <p>
            Local operation statuses appear above. Verified PayPal webhook deliveries appear below.
          </p>
          {selected.events.length === 0 && <p>No verified webhook events linked yet.</p>}
          {selected.events.map(function (event) {
            return (
              <div key={event.provider_event_id}>
                <strong>{event.event_type}</strong>
                <small>
                  {event.status} · {new Date(event.created_at).toLocaleString()}
                </small>
              </div>
            );
          })}
        </section>
      )}
    </article>
  );
}
