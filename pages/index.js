import { useState, useMemo } from "react";

export default function OrderTrackerPage() {
  const [orderNumber, setOrderNumber] = useState("");
  const [orderLocation, setOrderLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setData(null);
    if (!orderNumber.trim()) {
      setError("Please enter your order number.");
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("orderNumber", orderNumber.trim());
      if (orderLocation.trim()) params.set("orderLocation", orderLocation.trim());
      const res = await fetch(`/api/track?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error || "Something went wrong");
      }
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const primary = useMemo(() => {
    if (!data) return null;
    return {
      status: data.status,
      courier: data.courier,
      trackingNumber: data.trackingNumber,
      trackingUrl: data.trackingUrl,
      etaMin: data.etaMin,
      etaMax: data.etaMax,
      productNames: data.productNames || [],
      products: data.products || [],
      events: data.events || [],
      orderLocation: data.orderLocation || "",
    };
  }, [data]);

  return (
    <div className="page">
      <div className="container">
        <h1 className="title">Track your order</h1>
        <p className="subtitle">Enter your Order Number to get live shipment details.</p>

        <form onSubmit={handleSubmit} className="card form">
          <div className="field-row">
            <div className="field">
              <label>Order Number</label>
              <input
                type="text"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="e.g. 2025436652 or 4105939108DC"
              />
            </div>
            <div className="field">
              <label>Order Location (optional)</label>
              <input
                type="text"
                value={orderLocation}
                onChange={(e) => setOrderLocation(e.target.value)}
                placeholder="e.g. IBW / NWB / M06"
              />
            </div>
            <div className="actions">
              <button type="submit" disabled={loading}>{loading ? "Tracking…" : "Track"}</button>
            </div>
          </div>
          {error && <p className="error">{error}</p>}
        </form>

        {data && (
          <div className="grid">
            <section className="card summary">
              <div className="summary-header">
                <div>
                  <div className="summary-title">Order</div>
                  <div className=\"summary-value\">{(data?.requestedOrders?.[0]) || "—"}</div>
                <StatusBadge status={primary?.status} />
              </div>
              </div>

              <div className="info-grid">
                <Info label="Courier" value={primary?.courier || "—"} />
                <Info label="AWB" value={primary?.trackingNumber || "—"} copyable />
                <Info label="ETA" value={formatEta(primary?.etaMin, primary?.etaMax)} />
                <Info label="Order Location" value={primary?.orderLocation || "—"} />
              </div>

              <div className="links">
                {primary?.trackingUrl && (
                  <a className="btn secondary" href={primary.trackingUrl} target="_blank" rel="noreferrer">
                    View tracking page
                  </a>
                )}
                <button className="btn ghost" onClick={() => setShowRaw(v => !v)}>
                  {showRaw ? "Hide raw" : "Show raw"}
                </button>
              </div>
            </section>

            <section className="card">
              <h3 className="section-title">Items</h3>
              {(!primary?.products?.length) ? (
                <Empty>Items will appear once the shipment is packed.</Empty>
              ) : (
                <table className="items">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">Qty</th>
                      <th className="num">Unit</th>
                      <th className="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {primary.products.map((it, idx) => (
                      <tr key={idx}>
                        <td className="prod">
                          {it.imageUrl && <img src={it.imageUrl} alt="" />}
                          <div className="prod-info">
                            <div className="name">{it.name || it.sku || "—"}</div>
                            {it.sku && <div className="sku">SKU: {it.sku}</div>}
                          </div>
                        </td>
                        <td className="num">{it.qty ?? "—"}</td>
                        <td className="num">{formatMoney(it.unitPrice)}</td>
                        <td className="num strong">{formatMoney(it.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <h3 className="section-title">Timeline</h3>
              {(!primary?.events?.length) ? (
                <Empty>No tracking events yet.</Empty>
              ) : (
                <ol className="timeline">
                  {primary.events.map((ev, idx) => (
                    <li key={idx} className="tl-item">
                      <div className={`dot ${statusTone(ev.status)}`} />
                      <div className="content">
                        <div className="row">
                          <span className="label">{ev.status || "Update"}</span>
                          <span className="date">{formatDate(ev.date)}</span>
                        </div>
                        {ev.remarks && <div className="remarks">{ev.remarks}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {showRaw && (
              <section className="card">
                <h3 className="section-title">Raw response</h3>
                <pre className="pre">{JSON.stringify(data?._raw ?? data, null, 2)}</pre>
              </section>
            )}
          </div>
        )}
      </div>

      <style jsx>{`
        :root {
          --bg: #ffffff;
          --card: #ffffff;
          --muted: #555;
          --text: #111;
          --accent: #111111;
          --border: #e5e7eb;
        }
        .page { min-height: 100vh; background: var(--bg); color: var(--text); }
        .container { max-width: 960px; margin: 0 auto; padding: 32px 20px 60px; }
        .title { font-size: 32px; font-weight: 800; }
        .subtitle { color: var(--muted); margin: 6px 0 20px; }

        .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 18px 20px; box-shadow: 0 4px 12px rgba(0,0,0,.08); }
        .form { margin-bottom: 20px; }
        .field-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; }
        .field label { display:block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
        .field input { width: 100%; background: #fff; color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; outline: none; }
        .actions button, .btn { background: #111; color: #fff; border: none; border-radius: 12px; padding: 10px 16px; font-weight: 700; cursor: pointer; }
        .actions button[disabled] { opacity: .7; cursor: default; }
        .btn.secondary { background: #fff; color: #111; border: 1px solid #111; }
        .btn.ghost { background: transparent; color: #555; border: 1px solid var(--border); }
        .error { color: red; margin-top: 10px; }

        .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
        @media (min-width: 900px) { .grid { grid-template-columns: 1.2fr 1fr; } }

        .summary-header { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; margin-bottom: 10px; }
        .summary-title { font-size: 12px; color: var(--muted); }
        .summary-value { font-size: 24px; font-weight: 800; line-height: 1.2; word-break: break-word; }

        .info-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; margin-top: 10px; }
        .info { background: #f9fafb; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; }
        .info .label { color: var(--muted); font-size: 12px; }
        .info .value { font-weight: 700; margin-top: 2px; word-break: break-all; }

        .links { display: flex; gap: 10px; margin-top: 14px; }

        .section-title { font-size: 16px; font-weight: 800; margin-bottom: 12px; }
        .items { width: 100%; border-collapse: collapse; }
        .items th, .items td { border-bottom: 1px solid var(--border); padding: 10px; }
        .items th { color: var(--muted); font-weight: 600; text-align: left; }
        .items .num { text-align: right; }
        .items .strong { font-weight: 800; }
        .prod { display: flex; gap: 10px; align-items: center; }
        .prod img { width: 42px; height: 42px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
        .prod-info .name { font-weight: 700; }
        .prod-info .sku { color: var(--muted); font-size: 12px; }

        .timeline { list-style: none; margin: 0; padding: 0 0 0 22px; position: relative; }
        .timeline::before { content: ""; position: absolute; left: 9px; top: 0; bottom: 0; width: 3px; background: #16a34a; }
        .tl-item { position: relative; margin: 0 0 20px; }
        .tl-item:last-child { margin-bottom: 0; }
        .dot { position: absolute; left: -2px; top: 4px; width: 14px; height: 14px; border-radius: 50%; border: 2px solid #fff; }
        .dot.shipped { background: #f59e0b; }
        .dot.intransit { background: #2563eb; }
        .dot.delivered { background: #16a34a; }
        .dot.pending { background: #9ca3af; }
        .content { background: #f9fafb; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; }
        .row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
        .label { font-weight: 800; }
        .date { font-size: 12px; color: var(--muted); }
        .remarks { margin-top: 6px; color: var(--muted); }

        .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; font-weight: 800; font-size: 12px; border: 1px solid var(--border); white-space: nowrap; }
        .badge.shipped { background: #fef3c7; color: #92400e; border-color: #fde68a; }
        .badge.intransit { background: #dbeafe; color: #1e3a8a; border-color: #bfdbfe; }
        .badge.delivered { background: #dcfce7; color: #14532d; border-color: #86efac; }
        .badge.pending { background: #f3f4f6; color: #374151; border-color: #e5e7eb; }
        .pre { white-space: pre-wrap; word-break: break-word; background: #f9fafb; border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
      `}</style>
    </div>
  );
}

function Info({ label, value, copyable }) {
  return (
    <div className="info">
      <div className="label">{label}</div>
      <div className="value">
        {String(value ?? "—")} {copyable && value ? <Copy text={String(value)} /> : null}
      </div>
    </div>
  );
}

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copy"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch {}
      }}
      title="Copy"
    >
      {ok ? "✓" : "Copy"}
      <style jsx>{`
        .copy { margin-left: 8px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; }
      `}</style>
    </button>
  );
}

function StatusBadge({ status }) {
  const tone = statusTone(status);
  return <span className={`badge ${tone}`}>{status || "—"}</span>;
}

function statusTone(status) {
  if (!status) return "pending";
  const t = String(status).toLowerCase().replace(/\s+/g, "");
  if (t.includes("deliver")) return "delivered";
  if (t.includes("intransit") || t.includes("transit")) return "intransit";
  if (t.includes("ship")) return "shipped";
  return "pending";
}

function formatEta(min, max) {
  if (!min && !max) return "—";
  if (min && max) return `${min} – ${max}`;
  return min || max || "—";
}

function formatDate(raw) {
  if (!raw) return "—";
  try {
    const [d, t] = String(raw).split(" ");
    const [dd, mm, yyyy] = d.split("/").map(Number);
    const [HH, MM] = (t || "00:00:00").split(":");
    const date = new Date(yyyy, (mm || 1) - 1, dd, Number(HH || 0), Number(MM || 0));
    return date.toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    });
  } catch {
    return String(raw);
  }
}

function formatMoney(v) {
  if (v == null || v === "") return "—";
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(n);
}

function Empty({ children }) {
  return <div className="empty">{children}<style jsx>{`
    .empty { color: var(--muted); border: 1px dashed var(--border); border-radius: 12px; padding: 14px; text-align: center; }
  `}</style></div>;
}
