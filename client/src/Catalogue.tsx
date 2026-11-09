import { Product } from './types';
import { money } from './api';

interface CatalogueProps {
  products: Product[];
  quantities: Record<number, number>;
  busy: boolean;
  onQuantityChange(productId: number, quantity: number): void;
  onCheckout(): void;
}

export function Catalogue({
  products,
  quantities,
  busy,
  onQuantityChange,
  onCheckout
}: CatalogueProps) {
  let total = 0;
  let count = 0;
  for (const product of products) {
    const quantity = quantities[product.id] || 0;
    total += product.price_minor * quantity;
    count += quantity;
  }

  return (
    <>
      <section className="intro-strip">
        <div className="strip-icon" aria-hidden="true">
          ↗
        </div>
        <div>
          <strong>Small collection. Thoughtful essentials.</strong>
          <p>Choose your favourites and try a secure sandbox checkout.</p>
        </div>
        <span>USD COLLECTION</span>
      </section>
      <div className="shop-layout">
        <section aria-label="Product catalogue">
          <div className="section-heading">
            <h2>
              The essentials <span>{products.length} products</span>
            </h2>
            <span>Made for the everyday</span>
          </div>
          <div className="product-grid">
            {products.map(function (product, index) {
              return (
                <article className="product-card" key={product.id}>
                  <div className={'product-art art-' + product.id} aria-hidden="true">
                    <span className="product-index">0{index + 1}</span>
                    <div className="object" />
                    <span className="art-caption">PAYTRACK ESSENTIALS</span>
                  </div>
                  <div className="product-copy">
                    <div className="product-title">
                      <h3>{product.name}</h3>
                      <strong>{money(product.price_minor)}</strong>
                    </div>
                    <p>{product.description}</p>
                    <label className="quantity">
                      Quantity
                      <select
                        aria-label={product.name + ' quantity'}
                        value={quantities[product.id] || 0}
                        onChange={function (event) {
                          onQuantityChange(product.id, Number(event.target.value));
                        }}
                      >
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (number) {
                          return (
                            <option key={number} value={number}>
                              {number}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
          {products.length === 0 && (
            <div className="empty-state">No products yet. Run the database seed command.</div>
          )}
        </section>
        <aside className="order-summary">
          <div className="summary-heading">
            <h2>Your selection</h2>
            <span>{count} items</span>
          </div>
          {count === 0 ? (
            <div className="cart-empty">
              <span aria-hidden="true">＋</span>
              <strong>A little room for good things.</strong>
              <p>Choose a quantity to start your order.</p>
            </div>
          ) : (
            <div className="cart-lines">
              {products
                .filter(function (product) {
                  return quantities[product.id] > 0;
                })
                .map(function (product) {
                  return (
                    <div key={product.id}>
                      <span>
                        {product.name}
                        <small>Qty {quantities[product.id]}</small>
                      </span>
                      <strong>{money(product.price_minor * quantities[product.id])}</strong>
                    </div>
                  );
                })}
            </div>
          )}
          <div className="summary-total">
            <span>
              Estimated total<small>USD · server verified at checkout</small>
            </span>
            <strong>{money(total)}</strong>
          </div>
          <button
            className="primary checkout-button"
            disabled={busy || count === 0}
            onClick={onCheckout}
          >
            {busy ? 'Saving order…' : 'Create order'} <span aria-hidden="true">→</span>
          </button>
          <p className="secure-caption">PayPal Sandbox approval follows</p>
          <div className="summary-footnote">
            <span aria-hidden="true">◇</span> Your card details stay with PayPal.
          </div>
        </aside>
      </div>
      <div className="trust-row">
        <div>
          <span aria-hidden="true">01</span>
          <strong>Choose your essentials</strong>
          <p>Simple products, transparent prices.</p>
        </div>
        <div>
          <span aria-hidden="true">02</span>
          <strong>Approve in Sandbox</strong>
          <p>Use a PayPal test buyer account.</p>
        </div>
        <div>
          <span aria-hidden="true">03</span>
          <strong>Track every step</strong>
          <p>Verified payments and clear refunds.</p>
        </div>
      </div>
    </>
  );
}
