// pages/api/track.js
// Accepts:
//  - POST JSON: { "orderNumber": "4105939108DC" }  ← preferred
//  - GET  query: ?orderNumber=4105939108DC
//
// Vercel Env Vars (Project → Settings → Environment Variables):
//  VINICULUM_API_KEY      = <your key>         (required)
//  VINICULUM_API_OWNER    = Suraj              (required)
//  VINICULUM_ORG_ID       = <optional>         (only if your tenant requires it)
//  VINICULUM_CLIENT_CODE  = <optional>         (only if your tenant requires it)

const URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";

export default async function handler(req, res) {
  try {
    if (!["POST","GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // read input from POST body or GET query
    const body = req.method === "POST" ? (req.body || {}) : {};
    const q    = req.query || {};
    const orderNumber =
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!orderNumber) {
      return res.status(400).json({
        error: "Missing 'orderNumber' (string).",
        hint: "Send { orderNumber: '4105939108DC' } in POST JSON, or use ?orderNumber=4105939108DC"
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

    // EXACT body per Viniculum docs for this endpoint
    const payload = { orderNo: orderNumber };

    const upstream = await fetch(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const raw = await upstream.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream HTTP error", details: data });
    }

    // Viniculum success convention: responseCode === 0
    if (typeof data.responseCode !== "undefined" && Number(data.responseCode) !== 0) {
      return res.status(400).json({
        error: data?.responseMessage || "Rejected by Viniculum",
        details: data,
        sent: { url: URL, headers: Object.keys(headers), payload }
      });
    }

    // ---- Normalize for your UI ----
    const order = Array.isArray(data?.orders) && data.orders.length ? data.orders[0] : null;
    const ship  = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

    // Build timeline
    const events = [];
    if (ship) {
      if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
      if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
      if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
      if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
      if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
    }
    if (events.length === 0) {
      const fallbackDate =
        ship?.updated_date ||
        order?.createdDate ||
        null;
      const fallbackStatus =
        ship?.status || order?.status || data?.responseMessage || "Shipment created";
      events.push({
        date: fallbackDate,
        status: fallbackStatus,
        remarks: "Tracking will appear once the courier shares the first scan."
      });
    }
    events.sort((a,b)=> new Date(b.date || 0) - new Date(a.date || 0));

    // Items
    const items = (ship?.items || []).map(it => ({
      sku: it.sku || it.itemCode || null,
      name: it.itemName || null,
      qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
      price: it.price || null,
      imageUrl: it.imageUrl || null
    }));

    const normalized = {
      mode: "v1/shipmentDetail",
      orderNumber,
      status: order?.status || ship?.status || data?.responseMessage || "Unknown",
      courier: ship?.transporter || ship?.obExtTransporterName || null,
      trackingNumber: ship?.tracking_number || null,
      trackingUrl: ship?.tracking_url || null,
      eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
      events,
      items,
      _raw: data // keep while testing; remove later if you prefer
    };

    return res.status(200).json(normalized);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
