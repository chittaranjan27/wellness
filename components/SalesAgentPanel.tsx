/**
 * SalesAgentPanel — Two-tab panel (Plan · Cart)
 *
 * Plan: Shows trial-duration-based bundle cards with Add to Cart
 * Cart: Order summary with payment badges + Shopify checkout
 *
 * IMPORTANT: Add to Cart now uses the same Shopify cart/add URL pattern
 * as the Offers/Products section: window.open(cart/add?id=<variantId>&quantity=1&return_to=/cart)
 */
"use client";

import { useState, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface BundleProduct {
  productId: string;
  productName: string;
  role: "primary" | "supporting";
  imageUrl: string | null;
  shopifyUrl: string | null;
  shopifyVariantId: string | null;
  price: number;
  quantity: number;      // how many of this pack to add (e.g. 2×30-day = 60 days)
  supplyDays: number;    // supply_days of the individual pack
  totalDays: number;     // effective days = supplyDays × quantity
  dosageInstructions: string | null;
  resultsTimeline: string | null;
}

interface Bundle {
  name: string;
  tagline: string;
  duration: number;
  durationLabel: string;
  products: BundleProduct[];
  totalPrice: number;
  perDayPrice: number;
  savingsLabel: string | null;
  expectedResults: string;
  recommended: boolean;
}

interface OrderMeta {
  paymentMethods: string[];
  shippingThreshold: number;
  shippingMessage: string;
  returnPolicy: string;
  guarantee: string;
}

interface SalesAgentPanelProps {
  agentId: string;
  concern: string;
  language: string;
  onAddToCart?: (url: string, quantity: number) => void;
  onClose?: () => void;
}

// ─── Payment icon helper ──────────────────────────────────────────────────────
function PaymentBadge({ method }: { method: string }) {
  return (
    <span className="wai-sales-payment-badge">
      {method}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function SalesAgentPanel({
  agentId,
  concern,
  language,
  onAddToCart,
  onClose,
}: SalesAgentPanelProps) {
  const [tab, setTab] = useState<"plan" | "cart">("plan");
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [salesResponse, setSalesResponse] = useState("");
  const [orderMeta, setOrderMeta] = useState<OrderMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBundle, setSelectedBundle] = useState<number | null>(null);
  const [expandedDosage, setExpandedDosage] = useState<string | null>(null);

  // Cart state — tracks which bundles have been added to the Shopify cart
  const [addedBundleNames, setAddedBundleNames] = useState<Set<string>>(new Set());
  const [addingBundleName, setAddingBundleName] = useState<string | null>(null);
  const [cartBundle, setCartBundle] = useState<Bundle | null>(null);

  // ── Load bundles on mount ───────────────────────────────────────────────
  useEffect(() => {
    async function loadBundles() {
      setLoading(true);
      try {
        const res = await fetch("/api/sales-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            concern,
            language,
            mode: "recommend",
          }),
        });
        const data = await res.json();
        if (res.ok && data.bundles) {
          setBundles(data.bundles);
          setSalesResponse(data.response || "");
          setOrderMeta(data.orderMeta || null);
          // Auto-select recommended bundle
          const recIdx = data.bundles.findIndex((b: Bundle) => b.recommended);
          setSelectedBundle(recIdx >= 0 ? recIdx : 1);
        }
      } catch (err) {
        console.error("[SalesAgentPanel] Failed to load bundles:", err);
      } finally {
        setLoading(false);
      }
    }
    loadBundles();
  }, [agentId, concern, language]);

  // ── Add to Cart: uses Shopify cart/add URL (same as Offers section) ────
  const handleAddToCart = (bundle: Bundle) => {
    if (addedBundleNames.has(bundle.name)) return;

    setAddingBundleName(bundle.name);

    // Build a single cart/add URL with all products at their correct quantities
    // Shopify supports adding multiple items via: /cart/add?items[][id]=X&items[][quantity]=Y
    // But the simplest reliable approach is the /cart/variantId:qty,variantId:qty URL
    const cartParts: string[] = [];
    let hasAddedAny = false;

    for (const prod of bundle.products) {
      const rawVariantId = prod.shopifyVariantId || '';
      // Extract numeric ID from Shopify GID (e.g. gid://shopify/ProductVariant/12345 → 12345)
      const numericId = rawVariantId.includes('/')
        ? rawVariantId.split('/').pop() || rawVariantId
        : rawVariantId;

      if (!numericId) {
        console.error('[SalesAgentPanel] No variant ID for product:', prod.productName);
        continue;
      }

      const qty = prod.quantity || 1;
      cartParts.push(`${numericId}:${qty}`);
      hasAddedAny = true;
    }

    if (hasAddedAny && cartParts.length > 0) {
      // Use Shopify's /cart/variantId:qty,variantId:qty URL to add all items at once
      const addToCartUrl = `https://stayonwellness.com/cart/${cartParts.join(',')}`;
      console.log(`[SalesAgentPanel Cart] Opening: ${addToCartUrl}`);
      window.open(addToCartUrl, '_blank');

      // Mark bundle as added
      setAddedBundleNames(prev => new Set([...prev, bundle.name]));
      setCartBundle(bundle);
    }

    // Clear "adding" state after brief delay for UI feedback
    setTimeout(() => setAddingBundleName(null), 1500);
  };

  // ── Shopify checkout URL builder ───────────────────────────────────────
  const buildCheckoutUrl = (bundle: Bundle): string => {
    const parts: string[] = [];
    for (const prod of bundle.products) {
      if (prod.shopifyVariantId) {
        // Extract numeric ID from GID if needed
        const rawId = prod.shopifyVariantId;
        const numericId = rawId.includes("/") ? rawId.split("/").pop() || rawId : rawId;
        const qty = prod.quantity || 1;
        parts.push(`${numericId}:${qty}`);
      }
    }
    if (parts.length === 0) return "https://stayonwellness.com/cart";
    return `https://stayonwellness.com/cart/${parts.join(",")}`;
  };

  // ── Compute cart totals ────────────────────────────────────────────────
  const subtotal = cartBundle?.totalPrice || 0;
  const shippingThreshold = orderMeta?.shippingThreshold || 999;
  const shippingFree = subtotal >= shippingThreshold;
  const shippingCost = shippingFree ? 0 : 49;
  const total = subtotal + shippingCost;

  return (
    <div className="wai-sales-panel">
      {/* ── Header ── */}
      <div className="wai-sales-header">
        <button type="button" className="wai-sales-back" onClick={onClose} title="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="wai-sales-header-text">
          <p className="wai-sales-title">🎯 Your Personalized Plan</p>
          <p className="wai-sales-subtitle">
            {loading ? "Building your plan..." : `${bundles.length} options curated for you`}
          </p>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="wai-sales-tabs">
        {(["plan", "cart"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`wai-sales-tab${tab === t ? " wai-sales-tab-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "plan" && "📋 Plan"}
            {t === "cart" && `🛒 Cart${cartBundle ? " (1)" : ""}`}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="wai-sales-content">
        {/* ════════════ PLAN TAB ════════════ */}
        {tab === "plan" && (
          <div className="wai-sales-plan-scroll">
            {loading ? (
              <div className="wai-sales-loading">
                <div className="wai-sales-spinner" />
                <p>Preparing your wellness plan…</p>
              </div>
            ) : (
              <>
                {/* AI response */}
                {salesResponse && (
                  <div className="wai-sales-ai-msg">
                    <div className="wai-sales-ai-avatar">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="8" r="4" fill="white" opacity="0.9" />
                        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                      </svg>
                    </div>
                    <p className="wai-sales-ai-text">{salesResponse}</p>
                  </div>
                )}

                {/* Bundle cards */}
                <div className="wai-sales-bundles">
                  {bundles.map((bundle, idx) => {
                    const isAdded = addedBundleNames.has(bundle.name);
                    const isAdding = addingBundleName === bundle.name;

                    return (
                    <div
                      key={bundle.name}
                      className={`wai-sales-bundle-card${selectedBundle === idx ? " wai-sales-bundle-selected" : ""}${bundle.recommended ? " wai-sales-bundle-rec" : ""}`}
                      onClick={() => setSelectedBundle(idx)}
                    >
                      {/* Recommended badge */}
                      {bundle.recommended && (
                        <span className="wai-sales-rec-badge">⭐ Recommended</span>
                      )}

                      {/* Header */}
                      <div className="wai-sales-bundle-header">
                        <h3 className="wai-sales-bundle-name">{bundle.name}</h3>
                        <p className="wai-sales-bundle-tagline">{bundle.tagline}</p>
                        <p className="wai-sales-bundle-duration">{bundle.durationLabel}</p>
                      </div>

                      {/* Products */}
                      <div className="wai-sales-bundle-products">
                        {bundle.products.map((prod) => {
                          const qty = prod.quantity || 1;
                          return (
                          <div key={prod.productId} className="wai-sales-bundle-prod">
                            <div className="wai-sales-prod-img-wrap">
                              {prod.imageUrl ? (
                                <img src={prod.imageUrl} alt={prod.productName} className="wai-sales-prod-img" />
                              ) : (
                                <span className="wai-sales-prod-icon">🌿</span>
                              )}
                            </div>
                            <div className="wai-sales-prod-info">
                              <p className="wai-sales-prod-name">
                                {qty > 1 ? `${qty}× ` : ''}{prod.productName}
                              </p>
                              <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                                <span className={`wai-sales-role-badge wai-sales-role-${prod.role}`}>
                                  {prod.role === "primary" ? "Primary" : "Supporting"}
                                </span>
                                {prod.price > 0 && (
                                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#6b7280' }}>
                                    ₹{qty > 1 ? `${prod.price} × ${qty} = ₹${prod.price * qty}` : prod.price}
                                  </span>
                                )}
                                {prod.totalDays > 0 && (
                                  <span style={{ fontSize: '9px', fontWeight: 600, color: '#9ca3af' }}>
                                    ({prod.totalDays}d supply)
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>

                      {/* Pricing */}
                      <div className="wai-sales-bundle-pricing">
                        <span className="wai-sales-price">₹{bundle.totalPrice}</span>
                        <span className="wai-sales-perday">₹{bundle.perDayPrice}/day</span>
                        {bundle.savingsLabel && (
                          <span className="wai-sales-savings">{bundle.savingsLabel}</span>
                        )}
                      </div>

                      {/* Expected results */}
                      <p className="wai-sales-expected">{bundle.expectedResults}</p>

                      {/* Dosage expand */}
                      {bundle.products.some(p => p.dosageInstructions) && (
                        <div className="wai-sales-dosage-section">
                          <button
                            type="button"
                            className="wai-sales-dosage-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedDosage(expandedDosage === bundle.name ? null : bundle.name);
                            }}
                          >
                            {expandedDosage === bundle.name ? "▾ Hide Dosage" : "▸ Dosage Instructions"}
                          </button>
                          {expandedDosage === bundle.name && (
                            <div className="wai-sales-dosage-content">
                              {bundle.products.map((prod) =>
                                prod.dosageInstructions ? (
                                  <div key={prod.productId} className="wai-sales-dosage-item">
                                    <strong>{prod.productName}:</strong>
                                    <p>{prod.dosageInstructions}</p>
                                  </div>
                                ) : null
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Add to cart button — uses same Shopify cart/add pattern as Offers */}
                      <button
                        type="button"
                        className={`wai-sales-add-btn${selectedBundle === idx ? " wai-sales-add-active" : ""}${isAdded ? " wai-sales-add-added" : ""}`}
                        disabled={isAdded || isAdding}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAddToCart(bundle);
                        }}
                      >
                        {isAdded ? (
                          <>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            {' '}Added to Cart
                          </>
                        ) : isAdding ? (
                          <>
                            <span className="wai-sales-btn-spinner" />
                            {' '}Adding...
                          </>
                        ) : (
                          <>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                              <line x1="3" y1="6" x2="21" y2="6" />
                              <path d="M16 10a4 4 0 01-8 0" />
                            </svg>
                            {' '}Add to Cart
                          </>
                        )}
                      </button>
                    </div>
                  );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════════════ CART TAB ════════════ */}
        {tab === "cart" && (
          <div className="wai-sales-cart-scroll">
            {!cartBundle ? (
              <div className="wai-sales-cart-empty">
                <span style={{ fontSize: "36px" }}>🛒</span>
                <p>Your cart is empty</p>
                <p style={{ fontSize: "11px", color: "#9ca3af" }}>Select a plan from the Plan tab to get started.</p>
                <button type="button" className="wai-sales-add-btn" style={{ maxWidth: "160px" }} onClick={() => setTab("plan")}>
                  ← Browse Plans
                </button>
              </div>
            ) : (
              <>
                {/* Order summary */}
                <div className="wai-sales-cart-section">
                  <h4 className="wai-sales-cart-heading">Order Summary</h4>
                  <div className="wai-sales-cart-bundle">
                    <div className="wai-sales-cart-bundle-header">
                      <span className="wai-sales-cart-bundle-name">{cartBundle.name} Plan</span>
                      <span className="wai-sales-cart-bundle-dur">{cartBundle.durationLabel}</span>
                    </div>
                    {cartBundle.products.map((prod) => {
                      const qty = prod.quantity || 1;
                      return (
                      <div key={prod.productId} className="wai-sales-cart-line">
                        <div className="wai-sales-cart-line-left">
                          {prod.imageUrl ? (
                            <img src={prod.imageUrl} alt={prod.productName} className="wai-sales-cart-img" />
                          ) : (
                            <span className="wai-sales-cart-icon">🌿</span>
                          )}
                          <div>
                            <p className="wai-sales-cart-prod-name">{prod.productName}</p>
                            <span className={`wai-sales-role-badge wai-sales-role-${prod.role}`} style={{ fontSize: "9px" }}>
                              {prod.role}
                            </span>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {prod.price > 0 && (
                            <span style={{ fontSize: '12px', fontWeight: 700, color: '#374151' }}>
                              ₹{qty > 1 ? prod.price * qty : prod.price}
                            </span>
                          )}
                          <span className="wai-sales-cart-qty" style={{ display: 'block' }}>× {qty}</span>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>

                {/* Totals */}
                <div className="wai-sales-cart-section wai-sales-cart-totals">
                  <div className="wai-sales-cart-row">
                    <span>Subtotal</span>
                    <span>₹{subtotal}</span>
                  </div>
                  <div className="wai-sales-cart-row">
                    <span>Shipping</span>
                    <span style={{ color: shippingFree ? "#059669" : "#6b7280" }}>
                      {shippingFree ? "FREE" : `₹${shippingCost}`}
                    </span>
                  </div>
                  {!shippingFree && (
                    <p className="wai-sales-cart-ship-note">
                      Add ₹{shippingThreshold - subtotal} more for free shipping
                    </p>
                  )}
                  <div className="wai-sales-cart-row wai-sales-cart-total-row">
                    <span>Total</span>
                    <span>₹{total}</span>
                  </div>
                  {cartBundle.savingsLabel && (
                    <div className="wai-sales-cart-savings-badge">
                      🎉 {cartBundle.savingsLabel} on this plan!
                    </div>
                  )}
                </div>

                {/* Payment methods */}
                {orderMeta && (
                  <div className="wai-sales-cart-section">
                    <h4 className="wai-sales-cart-heading">Payment Options</h4>
                    <div className="wai-sales-payment-grid">
                      {orderMeta.paymentMethods.map((m) => (
                        <PaymentBadge key={m} method={m} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Trust badges */}
                {orderMeta && (
                  <div className="wai-sales-cart-section wai-sales-trust">
                    <div className="wai-sales-trust-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2">
                        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                      </svg>
                      <span>{orderMeta.returnPolicy}</span>
                    </div>
                    <div className="wai-sales-trust-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      <span>{orderMeta.guarantee}</span>
                    </div>
                  </div>
                )}

                {/* Checkout button */}
                <div className="wai-sales-cart-checkout">
                  <a
                    href={buildCheckoutUrl(cartBundle)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wai-sales-checkout-btn"
                  >
                    Proceed to Checkout →
                  </a>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Styles ── */}
      <style>{`
        .wai-sales-panel {
          display: flex; flex-direction: column; height: 100%; overflow: hidden;
          background: linear-gradient(to bottom, #FAF5F2 0%, #FFF8F5 100%);
          font-family: 'Montserrat', 'Dosis', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .wai-sales-header {
          display: flex; align-items: center; gap: 12px;
          padding: 14px 16px 12px;
          background: rgba(255,255,255,0.85);
          border-bottom: 1px solid #f0ddd5;
          flex-shrink: 0; backdrop-filter: blur(8px);
        }
        .wai-sales-back {
          display: flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; border-radius: 50%;
          border: 1.5px solid #d1d5db; background: #fff;
          color: #6b7280; cursor: pointer; transition: all 0.15s; flex-shrink: 0;
        }
        .wai-sales-back:hover { border-color: #E35353; color: #E35353; }
        .wai-sales-header-text { flex: 1; }
        .wai-sales-title { margin: 0; font-size: 14px; font-weight: 800; color: #111827; }
        .wai-sales-subtitle { margin: 2px 0 0; font-size: 11px; color: #6b7280; }

        /* Tabs */
        .wai-sales-tabs {
          display: flex; gap: 0; flex-shrink: 0;
          border-bottom: 1px solid #f0ddd5;
          background: rgba(255,255,255,0.6);
        }
        .wai-sales-tab {
          flex: 1; padding: 10px 8px; border: none;
          background: none; font-size: 12px; font-weight: 700;
          color: #9ca3af; cursor: pointer;
          border-bottom: 2.5px solid transparent;
          transition: all 0.15s;
        }
        .wai-sales-tab:hover { color: #374151; }
        .wai-sales-tab-active {
          color: #E35353 !important;
          border-bottom-color: #E35353 !important;
        }

        /* Content */
        .wai-sales-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

        /* Plan scroll */
        .wai-sales-plan-scroll { flex: 1; overflow-y: auto; padding: 14px; }
        .wai-sales-plan-scroll::-webkit-scrollbar { width: 3px; }
        .wai-sales-plan-scroll::-webkit-scrollbar-thumb { background: #e8c9be; border-radius: 4px; }

        /* AI message */
        .wai-sales-ai-msg {
          display: flex; gap: 10px; align-items: flex-start;
          margin-bottom: 16px; animation: wai-msg-appear 0.3s ease-out;
        }
        .wai-sales-ai-avatar {
          width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
          background: #2C2C2C;
          display: flex; align-items: center; justify-content: center;
        }
        .wai-sales-ai-text {
          margin: 0; font-size: 12.5px; line-height: 1.6; color: #374151;
          background: #fff; border: 1px solid #E8E0D8; border-radius: 16px;
          padding: 10px 14px; max-width: 90%;
        }

        /* Bundle cards */
        .wai-sales-bundles { display: flex; flex-direction: column; gap: 12px; }
        .wai-sales-bundle-card {
          background: #fff; border-radius: 16px; padding: 16px;
          border: 1.5px solid #f0ddd5; cursor: pointer;
          transition: all 0.2s; position: relative; overflow: hidden;
        }
        .wai-sales-bundle-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(227,83,83,0.12); }
        .wai-sales-bundle-selected {
          border-color: #E35353 !important;
          box-shadow: 0 0 0 2px rgba(227,83,83,0.15), 0 4px 16px rgba(227,83,83,0.12) !important;
        }
        .wai-sales-bundle-rec { border-color: rgba(227,83,83,0.3); }
        .wai-sales-rec-badge {
          position: absolute; top: 0; right: 0;
          padding: 4px 12px; border-radius: 0 14px 0 14px;
          background: linear-gradient(135deg, #E35353, #c43a3a);
          color: #fff; font-size: 10px; font-weight: 800;
        }

        .wai-sales-bundle-header { margin-bottom: 12px; }
        .wai-sales-bundle-name { margin: 0; font-size: 15px; font-weight: 800; color: #111827; }
        .wai-sales-bundle-tagline { margin: 2px 0 0; font-size: 11px; color: #6b7280; }
        .wai-sales-bundle-duration {
          display: inline-block; margin-top: 4px;
          padding: 2px 8px; border-radius: 12px;
          background: rgba(227,83,83,0.08); color: #E35353;
          font-size: 10px; font-weight: 700;
        }

        /* Products in bundle */
        .wai-sales-bundle-products { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
        .wai-sales-bundle-prod { display: flex; gap: 10px; align-items: center; }
        .wai-sales-prod-img-wrap {
          width: 40px; height: 40px; border-radius: 10px; overflow: hidden;
          background: #fce8e4; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .wai-sales-prod-img { width: 100%; height: 100%; object-fit: cover; }
        .wai-sales-prod-icon { font-size: 20px; }
        .wai-sales-prod-info { flex: 1; }
        .wai-sales-prod-name { margin: 0; font-size: 12px; font-weight: 700; color: #1f2937; }
        .wai-sales-role-badge {
          display: inline-block; padding: 1px 6px; border-radius: 10px;
          font-size: 9.5px; font-weight: 700; margin-top: 2px;
        }
        .wai-sales-role-primary { background: rgba(227,83,83,0.1); color: #c43a3a; }
        .wai-sales-role-supporting { background: rgba(20,184,166,0.1); color: #0d7060; }

        /* Pricing */
        .wai-sales-bundle-pricing {
          display: flex; align-items: baseline; gap: 8px;
          margin-bottom: 8px; flex-wrap: wrap;
        }
        .wai-sales-price { font-size: 22px; font-weight: 900; color: #E35353; }
        .wai-sales-perday { font-size: 11px; font-weight: 600; color: #6b7280; }
        .wai-sales-savings {
          padding: 2px 8px; border-radius: 12px;
          background: rgba(5,150,105,0.1); color: #059669;
          font-size: 10px; font-weight: 800;
        }
        .wai-sales-expected { margin: 0 0 8px; font-size: 11.5px; color: #4b5563; line-height: 1.5; font-style: italic; }

        /* Dosage */
        .wai-sales-dosage-section { margin-bottom: 10px; }
        .wai-sales-dosage-toggle {
          background: none; border: none; padding: 0;
          font-size: 11px; font-weight: 700; color: #E35353;
          cursor: pointer; transition: color 0.15s;
        }
        .wai-sales-dosage-toggle:hover { color: #c43a3a; }
        .wai-sales-dosage-content {
          margin-top: 8px; padding: 10px; border-radius: 10px;
          background: rgba(247,243,238,0.8); border: 1px solid #f0ddd5;
        }
        .wai-sales-dosage-item { margin-bottom: 6px; }
        .wai-sales-dosage-item:last-child { margin-bottom: 0; }
        .wai-sales-dosage-item strong { font-size: 11px; color: #374151; }
        .wai-sales-dosage-item p { margin: 2px 0 0; font-size: 11px; color: #6b7280; line-height: 1.5; }

        /* Add to cart */
        .wai-sales-add-btn {
          width: 100%; padding: 10px; border-radius: 12px;
          border: 1.5px solid #d1d5db; background: #f9fafb;
          font-size: 12px; font-weight: 700; color: #374151;
          cursor: pointer; transition: all 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .wai-sales-add-btn:hover { border-color: #E35353; color: #E35353; background: rgba(227,83,83,0.04); }
        .wai-sales-add-active {
          background: linear-gradient(135deg, #1A1A1A, #E35353) !important;
          border-color: transparent !important; color: #fff !important;
          box-shadow: 0 2px 12px rgba(227,83,83,0.3);
        }
        .wai-sales-add-active:hover {
          background: linear-gradient(135deg, #1A1A1A, #c43a3a) !important;
        }
        .wai-sales-add-added {
          background: linear-gradient(135deg, #059669, #10b981) !important;
          border-color: transparent !important; color: #fff !important;
          cursor: default;
          box-shadow: 0 2px 8px rgba(5,150,105,0.3);
        }
        .wai-sales-btn-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: wai-spin 0.7s linear infinite;
          display: inline-block;
        }

        /* Loading */
        .wai-sales-loading {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 40px 20px; gap: 14px; color: #6b7280; font-size: 13px;
        }
        .wai-sales-spinner {
          width: 32px; height: 32px; border: 3px solid #f0ddd5;
          border-top-color: #E35353; border-radius: 50%;
          animation: wai-spin 0.8s linear infinite;
        }

        /* ── Cart tab ── */
        .wai-sales-cart-scroll { flex: 1; overflow-y: auto; padding: 14px; }
        .wai-sales-cart-scroll::-webkit-scrollbar { width: 3px; }
        .wai-sales-cart-scroll::-webkit-scrollbar-thumb { background: #e8c9be; border-radius: 4px; }
        .wai-sales-cart-empty {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 40px 20px; text-align: center; gap: 8px; color: #6b7280; font-size: 14px;
        }
        .wai-sales-cart-section {
          background: #fff; border-radius: 14px; padding: 14px;
          border: 1px solid #f0ddd5; margin-bottom: 12px;
        }
        .wai-sales-cart-heading {
          margin: 0 0 10px; font-size: 12px; font-weight: 800; color: #374151;
          text-transform: uppercase; letter-spacing: 0.04em;
        }
        .wai-sales-cart-bundle { }
        .wai-sales-cart-bundle-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #f0ddd5;
        }
        .wai-sales-cart-bundle-name { font-size: 14px; font-weight: 800; color: #111827; }
        .wai-sales-cart-bundle-dur {
          padding: 3px 10px; border-radius: 12px;
          background: rgba(227,83,83,0.08); color: #E35353;
          font-size: 10px; font-weight: 700;
        }
        .wai-sales-cart-line {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 0; border-bottom: 1px solid #faf5f2;
        }
        .wai-sales-cart-line:last-child { border-bottom: none; }
        .wai-sales-cart-line-left { display: flex; align-items: center; gap: 10px; }
        .wai-sales-cart-img {
          width: 36px; height: 36px; border-radius: 8px; object-fit: cover;
        }
        .wai-sales-cart-icon {
          width: 36px; height: 36px; border-radius: 8px; background: #fce8e4;
          display: flex; align-items: center; justify-content: center; font-size: 18px;
        }
        .wai-sales-cart-prod-name { margin: 0; font-size: 12px; font-weight: 700; color: #1f2937; }
        .wai-sales-cart-qty { font-size: 12px; font-weight: 600; color: #6b7280; }

        /* Totals */
        .wai-sales-cart-totals { background: #FFFBFA; }
        .wai-sales-cart-row {
          display: flex; justify-content: space-between; padding: 4px 0;
          font-size: 12.5px; color: #4b5563;
        }
        .wai-sales-cart-total-row {
          font-size: 15px !important; font-weight: 900 !important; color: #111827 !important;
          border-top: 1.5px solid #f0ddd5; margin-top: 6px; padding-top: 8px;
        }
        .wai-sales-cart-ship-note {
          margin: 2px 0 4px; font-size: 10px; color: #9ca3af; font-style: italic;
        }
        .wai-sales-cart-savings-badge {
          margin-top: 8px; padding: 6px 12px; border-radius: 10px;
          background: rgba(5,150,105,0.08); border: 1px solid rgba(5,150,105,0.2);
          color: #059669; font-size: 11px; font-weight: 700; text-align: center;
        }

        /* Payment badges */
        .wai-sales-payment-grid { display: flex; flex-wrap: wrap; gap: 6px; }
        .wai-sales-payment-badge {
          padding: 4px 10px; border-radius: 8px;
          background: #f3f4f6; border: 1px solid #e5e7eb;
          font-size: 10px; font-weight: 700; color: #374151;
        }

        /* Trust */
        .wai-sales-trust { background: rgba(5,150,105,0.03); border-color: rgba(5,150,105,0.15); }
        .wai-sales-trust-item {
          display: flex; align-items: center; gap: 8px;
          padding: 4px 0; font-size: 11px; color: #374151; font-weight: 600;
        }

        /* Checkout button */
        .wai-sales-cart-checkout { margin-top: 8px; }
        .wai-sales-checkout-btn {
          display: block; width: 100%; padding: 14px;
          border-radius: 14px; border: none; text-align: center;
          background: linear-gradient(135deg, #1A1A1A 0%, #E35353 100%);
          color: #fff; font-size: 14px; font-weight: 800;
          text-decoration: none;
          box-shadow: 0 4px 16px rgba(227,83,83,0.35);
          transition: all 0.2s;
        }
        .wai-sales-checkout-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 24px rgba(227,83,83,0.45);
        }

        @keyframes wai-spin { to { transform: rotate(360deg); } }
        @keyframes wai-msg-appear { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

        @media (max-width: 640px) {
          .wai-sales-bundles { gap: 10px; }
          .wai-sales-bundle-card { padding: 14px; }
          .wai-sales-price { font-size: 20px; }
        }
      `}</style>
    </div>
  );
}
