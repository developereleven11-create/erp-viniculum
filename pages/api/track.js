// pages/api/track.js
// Accepts:
//  - POST JSON: { "deliveryNo": "WH..." }  ← preferred
//  - POST JSON: { "orderNumber": "..." }   ← backward-compatible (used as deliveryNo)
//  - GET  query: ?deliveryNo=WH... or ?orderNumber=...
//
// Env vars in Vercel (Project → Settings → Environment Variables):
//  VINICULUM_API_KEY
//  VINICULUM_API_OWNER           (e.g., "Suraj")
//  VINICULUM_ORG_ID              (optional if your tenant requires it)
//  VINICULUM_CLIENT_CODE         (optional if your tenant requires it)

const URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/orderShip";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // Pull input from body or query; prefer deliveryNo if provided
    const body = req.method === "POST" ? (req.body || {}) : {};
    const q = req.query || {};
    const deliveryNo =
      (typeof body.deliveryNo === "string" && body.deliveryNo.trim()) ||
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.deliveryNo === "string" && q.deliveryNo.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!deliveryNo) {
      return res.status(400).json({
        error: "Missing 'deliveryNo' (string).",
        hint: "Send { deliveryNo: 'WH2766812322' } in POST JSON, or ?deliveryNo=WH2766812322 as a query param."
      });
    }

    const apiKey     = process.env.VINICULUM_API_KEY;
    const apiOwner   = process.env.VINICULUM_API_OWNER;
    const orgId      = process.env.VINICULUM_ORG_ID;
    const clientCode = process.env.VINICULUM_CLIENT_CODE;

    if (!apiKey || !apiOwner) {
      return res.status(500).json({ error: "Server not configured. Missing VINICULUM_API_KEY or VINICULUM_API_OWNER." });
    }

    const headers = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      ...(orgId ? { OrgId: orgId } : {}),
      ...(clientCode ? { ClientCode: clientCode } : {})
    };

    const payload = {
      request: [{ deliveryNo }]
    };

    const upstream = await fetch(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream HTTP error", details: data });
    }

    // Vin-eRetail convention: responseCode === 0 => success
    if (typeof data.responseCode !== "undefined" && Number(data.responseCode) !== 0) {
      return res.status(400).json({
        error: data?.responseMessage || "Vin-eRetail rejected the request",
        details: data
      });
    }

    // ----- Normalize for your frontend with a fallback event -----
    // Expecting shape similar to your earlier sample:
    // { orders: [ { status, createdDate, shipDetail: [ { transporter, tracking_number, tracking_url, shipdate, updated_date, delivereddate, items: [...] } ] } ] }
    const order = Array.isArray(data?.orders) && data.orders.length ? data.orders[0] : null;
    const ship  = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

    const events = [];
    if (ship) {
      if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
      if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
      if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
      if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
      if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
    }

    // ⭐ Fallback event if no events returned
    if (events.length === 0) {
      const fallbackDate =
        ship?.updated_date ||
        order?.createdDate ||
        null;

      const fallbackStatus =
        ship?.status ||
        order?.status ||
        data?.responseMessage ||
        "Shipment created";

      events.push({
        date: fallbackDate,
        status: fallbackStatus || "Shipment created",
        remarks: "Tracking will appear once the courier shares the first scan."
      });
    }

    // newest first
    events.sort((a,b)=> new Date(b.date || 0) - new Date(a.date || 0));

    const items = (ship?.items || []).map(it => ({
      sku: it.sku || it.itemCode || null,
      name: it.itemName || null,
      qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
      price: it.price || null,
      imageUrl: it.imageUrl || null
    }));

    const normalized = {
      deliveryNo,
      status: order?.status || ship?.status || data?.responseMessage || "Unknown",
      courier: ship?.transporter || ship?.obExtTransporterName || null,
      trackingNumber: ship?.tracking_number || null,
      trackingUrl: ship?.tracking_url || null,
      eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
      events,
      items,
      _raw: data // keep for debugging; remove later if you want
    };

    return res.status(200).json(normalized);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
