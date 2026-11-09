import { useEffect, useState, FormEvent } from 'react';
import { api, money, operationKey, saveCsrfToken } from './api';
import { User, Product, OrderSummary, OrderDetails, SessionResult } from './types';
import { Badge, statusLabel } from './Badge';
import { Catalogue } from './Catalogue';
import { OrderDetailsPanel } from './OrderDetailsPanel';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [selected, setSelected] = useState<OrderDetails | null>(null);
  const [page, setPage] = useState('shop');
  const [authMode, setAuthMode] = useState('login');
  const [showAuth, setShowAuth] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recoveryRefundId, setRecoveryRefundId] = useState('');

  useEffect(function () {
    async function load() {
      try {
        const session = (await api('/session')) as SessionResult;
        saveCsrfToken(session.csrfToken);
        setUser(session.user);
        setProducts((await api('/products')) as Product[]);
        if (session.user) {
          setOrders((await api('/orders')) as OrderSummary[]);
          if (session.user.role === 'merchant') setPage('orders');
        }
        const query = new URLSearchParams(window.location.search);
        const orderId = query.get('approved') || query.get('cancelled');
        if (orderId) {
          setPage('orders');
          if (session.user)
            setSelected((await api('/orders/' + encodeURIComponent(orderId))) as OrderDetails);
          else setShowAuth(true);
          if (query.has('approved'))
            setNotice(
              'Approval received. Select “Confirm payment” to capture and verify it on the server.'
            );
          else setNotice('Checkout was cancelled. Your order is saved; no payment is assumed.');
          window.history.replaceState({}, '', '/');
        }
      } catch (error) {
        setError(errorMessage(error));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Something went wrong. Please refresh the order status.';
  }

  async function refreshOrders(id?: string) {
    setOrders((await api('/orders')) as OrderSummary[]);
    if (id) setSelected((await api('/orders/' + id)) as OrderDetails);
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = (await api('/' + authMode, 'POST', { email, password })) as SessionResult;
      saveCsrfToken(result.csrfToken);
      setUser(result.user);
      setPassword('');
      setShowAuth(false);
      await refreshOrders();
      if (result.user?.role === 'merchant') setPage('orders');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await api('/logout', 'POST');
      const result = (await api('/session')) as SessionResult;
      saveCsrfToken(result.csrfToken);
      setUser(null);
      setOrders([]);
      setSelected(null);
      setPage('shop');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    if (!user) {
      setShowAuth(true);
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const items = [];
      for (const product of products) {
        if (quantities[product.id])
          items.push({ productId: product.id, quantity: quantities[product.id] });
      }
      const cartName = 'cart:' + user.id + ':' + JSON.stringify(items);
      const order = (await api(
        '/orders',
        'POST',
        { items },
        operationKey(cartName)
      )) as OrderSummary;
      setPage('orders');
      await refreshOrders(order.id);
      sessionStorage.removeItem(cartName);
      setQuantities({});
      setNotice('Order saved. Continue to PayPal Sandbox when you are ready.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function orderAction(action: string) {
    if (!selected) return;
    const id = selected.id;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let body = {};
      if (action === 'reconcile' && user?.role === 'merchant' && recoveryRefundId.trim()) {
        body = { providerRefundId: recoveryRefundId.trim() };
      }
      const result = (await api(
        '/orders/' + id + '/' + action,
        'POST',
        body,
        operationKey(action + ':' + id)
      )) as { approval_url?: string };
      await refreshOrders(id);
      if (action === 'payment' && result.approval_url) {
        // The backend validates this URL; check again before leaving the application.
        const url = new URL(result.approval_url);
        if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com')
          throw new Error('Unexpected approval URL.');
        window.location.assign(url.href);
        return;
      }
      setNotice('Status refreshed. Pending or unknown operations may still need reconciliation.');
    } catch (error) {
      setError(errorMessage(error));
      try {
        await refreshOrders(id);
      } catch {
        /* Keep the original actionable error. */
      }
    } finally {
      setBusy(false);
    }
  }

  async function openOrder(id: string) {
    setBusy(true);
    setError('');
    try {
      setSelected((await api('/orders/' + id)) as OrderDetails);
      setRecoveryRefundId('');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="PayTrack home">
          <span className="brand-mark">
            p<span>↗</span>
          </span>
          PayTrack<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={page === 'shop' ? 'nav-item active' : 'nav-item'}
            onClick={function () {
              setPage('shop');
              setSelected(null);
            }}
          >
            <span aria-hidden="true">▦</span> Catalogue
          </button>
          <button
            className={page === 'orders' ? 'nav-item active' : 'nav-item'}
            onClick={function () {
              setPage('orders');
            }}
          >
            <span aria-hidden="true">▤</span>{' '}
            {user?.role === 'merchant' ? 'All orders' : 'My orders'}
            <span className="nav-count">{orders.length}</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="live-dot" /> Sandbox workspace
          <p>A safe place to explore checkout, payments and refunds.</p>
          <small>No real money moves here.</small>
        </div>
        <div className="account">
          <div className="avatar">{user ? user.email[0].toUpperCase() : 'G'}</div>
          <div>
            <strong>{user ? user.role : 'Guest account'}</strong>
            <small>{user ? user.email : 'Log in to save your orders'}</small>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>
            Workspace <span className="breadcrumb">/</span>{' '}
            <strong>{page === 'shop' ? 'Catalogue' : 'Orders'}</strong>
          </span>
          <div className="topbar-actions">
            <span className="sandbox-pill">
              <span className="live-dot" /> SANDBOX
            </span>
            {user ? (
              <button className="text-button" disabled={busy} onClick={logout}>
                Log out
              </button>
            ) : (
              <button
                className="text-button"
                onClick={function () {
                  setShowAuth(true);
                }}
              >
                Log in <span aria-hidden="true">↗</span>
              </button>
            )}
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">CHECKOUT, WITH CLARITY</div>
              <h1>
                {page === 'shop' ? 'Good things, simply chosen.' : 'Every order. Every update.'}
              </h1>
              <p>
                {page === 'shop'
                  ? 'A few everyday essentials. One straightforward checkout.'
                  : 'Follow payments and refunds from request to confirmation.'}
              </p>
            </div>
            <span className="page-number">
              {page === 'shop' ? '01 / CATALOGUE' : '02 / ORDERS'}
            </span>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="alert notice" role="status">
              {notice}
            </div>
          )}
          {loading && (
            <div className="empty-state" role="status">
              Loading your workspace…
            </div>
          )}
          {showAuth && (
            <section className="auth-panel" aria-label="Account access">
              <div>
                <h2>{authMode === 'login' ? 'Welcome back.' : 'Make yourself at home.'}</h2>
                <p>Use your PayTrack account. PayPal Sandbox has a separate login.</p>
              </div>
              <form onSubmit={authenticate}>
                <label>
                  Email
                  <input
                    autoComplete="email"
                    type="email"
                    value={email}
                    required
                    onChange={function (event) {
                      setEmail(event.target.value);
                    }}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    required
                    minLength={12}
                    maxLength={128}
                    onChange={function (event) {
                      setPassword(event.target.value);
                    }}
                  />
                  <small>12–128 characters</small>
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? 'Please wait…' : statusLabel(authMode)}
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={function () {
                    setAuthMode(authMode === 'login' ? 'register' : 'login');
                  }}
                >
                  {authMode === 'login' ? 'Create an account' : 'Already have an account?'}
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={function () {
                    setShowAuth(false);
                  }}
                >
                  Close
                </button>
              </form>
            </section>
          )}
          {!loading && page === 'shop' && (
            <Catalogue
              products={products}
              quantities={quantities}
              busy={busy}
              onQuantityChange={function (productId, quantity) {
                setQuantities({ ...quantities, [productId]: quantity });
              }}
              onCheckout={checkout}
            />
          )}
          {!loading && page === 'orders' && (
            <section>
              <div className="section-heading">
                <h2>
                  {user?.role === 'merchant' ? 'Merchant orders' : 'Your orders'}{' '}
                  <span>Latest 100</span>
                </h2>
                {user && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={async function () {
                      setBusy(true);
                      try {
                        await refreshOrders(selected?.id);
                      } catch (error) {
                        setError(errorMessage(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Refresh ↻
                  </button>
                )}
              </div>
              {!user && (
                <div className="empty-state">
                  Log in to view your orders.
                  <br />
                  <button
                    className="primary"
                    onClick={function () {
                      setShowAuth(true);
                    }}
                  >
                    Log in
                  </button>
                </div>
              )}
              {user && orders.length === 0 && (
                <div className="empty-state">Your first order starts in the catalogue.</div>
              )}
              {orders.length > 0 && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Placed</th>
                        <th>Total</th>
                        <th>Order status</th>
                        <th>Payment</th>
                        <th>Refund</th>
                        <th>
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map(function (order) {
                        return (
                          <tr key={order.id}>
                            <td className="order-id">{order.id.slice(0, 8)}</td>
                            <td>{new Date(order.created_at).toLocaleDateString()}</td>
                            <td>{money(order.total_minor)}</td>
                            <td>
                              <Badge status={order.status} />
                            </td>
                            <td>
                              <Badge status={order.payment_status} />
                            </td>
                            <td>
                              <Badge status={order.refund_status} />
                            </td>
                            <td>
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={function () {
                                  void openOrder(order.id);
                                }}
                              >
                                View →
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {selected && (
                <OrderDetailsPanel
                  selected={selected}
                  user={user}
                  busy={busy}
                  recoveryRefundId={recoveryRefundId}
                  onClose={function () {
                    setSelected(null);
                  }}
                  onAction={function (action) {
                    void orderAction(action);
                  }}
                  onRecoveryIdChange={setRecoveryRefundId}
                />
              )}
            </section>
          )}
          <footer>
            <span>
              PayTrack <span className="footer-dot">·</span> Checkout & refund management
            </span>
            <span>Built for learning. Sandbox only.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
