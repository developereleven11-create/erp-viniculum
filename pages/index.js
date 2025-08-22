
import { useState } from 'react';

export default function Home() {
  const [orderNumber, setOrderNumber] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e){
    e.preventDefault();
    setError('');
    setData(null);
    if (!orderNumber) return setError('Please enter your Order Number.');
    setLoading(true);
    try {
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed');
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <h1 className="h1">Track your order</h1>
        <p className="p">Enter your Order Number to get live shipment details.</p>
        <form className="row" onSubmit={onSubmit}>
          <input className="input" placeholder="Order Number (e.g., 4105939108DC)" value={orderNumber} onChange={e=>setOrderNumber(e.target.value)} />
          <button className="button" disabled={loading}>{loading ? 'Fetching…' : 'Track'}</button>
        </form>
        {error && <div className="msg" style={{color:'#b00020'}}>{error}</div>}
        {data && (
          <div style={{marginTop:'14px'}}>
            <div className="summary">
              <div>
                <div><b>Order:</b> {data.orderNumber || '—'}</div>
                <div className="meta"><span className="badge">{data.status || '—'}</span></div>
              </div>
              <div style={{textAlign:'right'}}>
                <div className="meta">Courier: <b>{data.courier || '—'}</b></div>
                <div className="meta">AWB: <b>{data.trackingNumber || '—'}</b></div>
                <div className="meta">ETA: <b>{data.eta || '—'}</b></div>
                {data.trackingUrl && <div className="meta"><a href={data.trackingUrl} target="_blank" rel="noreferrer">Open carrier tracking ↗</a></div>}
              </div>
            </div>
            <hr style={{margin:'14px 0'}}/>
            <ol className="list">
              {(data.events||[]).length === 0 && <li className="item">No tracking events yet.</li>}
              {(data.events||[]).map((ev, i)=> (
                <li key={i} className="item">
                  <div><b>{ev.status || 'Update'}</b></div>
                  <small>{ev.location ? ev.location + ' • ' : ''}{ev.date || ''}</small>
                  {ev.remarks && <div><small>{ev.remarks}</small></div>}
                </li>
              ))}
            </ol>
            {Array.isArray(data.items) && data.items.length > 0 && (
              <div style={{marginTop:'14px'}}>
                <h3 className="h1" style={{fontSize:18}}>Items</h3>
                <ol className="list">
                  {data.items.map((it, idx)=> (
                    <li key={idx} className="item">
                      <div><b>{it.name || it.sku || 'Item'}</b> {it.qty ? `× ${it.qty}` : ''}</div>
                      {it.price && <small>Price: {it.price}</small>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <details style={{marginTop:'12px'}}>
              <summary>Raw response</summary>
              <pre>{JSON.stringify(data._raw || {}, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
