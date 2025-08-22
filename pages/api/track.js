// pages/api/track.js
// POST body: { "orderNumber": "4105939108DC" }
// Env needed on Vercel:
//   VINICULUM_API_KEY
//   VINICULUM_API_OWNER
//   VINICULUM_ORG_ID          ← NEW (required by Viniculum)
//   VINICULUM_CLIENT_CODE     ← optional (some tenants need it)

const V1_URL = "https://erp.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const { orderNumber } = req.body || {};
    if (!orderNumber || typeof orderNumber !== "string") {
      return res.status(400).json({ error: "Missing 'orderNumber' in request body" });
    }

    const apiKey    = process.env.VINICULUM_API_KEY;
    const apiOwner  = process.env.VINICULUM_API_OWNER;
    const orgId     = process.env.VINICULUM_ORG_ID;        // ← REQUIRED
    const clientCode= process.env.VINICULUM_CLIENT_CODE || undefined; // optional

    if (!apiKey || !apiOwner || !orgId) {
      return res.status(500).json({
        error: "Server not configured. Missing one of: VINICULUM_API_KEY, VINICULUM_API_OWNER, VINICULUM_ORG_ID."
      });
    }

    const headers = {
      "Content-Type": "application/json",
      "ApiKey": apiKey,
      "ApiOwner": apiOwner,
      "OrgId": orgId,                 // ← send OrgId
      ...(clientCode ? { "ClientCode": clientCode } : {})
    };

    const vinResp = await fetch(V1_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ orderNo: orderNumber })
    });

    const text = await vinResp.text();
    let vinData;
    try { vinData = JSON.parse(text); } catch { vinData = { raw: text }; }

    if (!vinResp.ok) {
      return res.status(vinResp.status).json({ error: "Upstream error", details: vinData });
    }

    // Viniculum success is usually responseCode === 0
    if (typeof vinData?.responseCode !== "undefined" && Number(vinData.responseCode) !== 0) {
      return res.status(400).json({ error: vinData?.responseMessage || "Viniculum rejected the request", details: vinData });
    }

    // Normalize for frontend
    const order = Array.isArray(vinData?.orders) && vinData.orders.length ? vinData.orders[0] : null;
    const ship  = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

    const events = [];
    if (ship) {
      if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
      if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
      if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
      if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
      if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
      events.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
    }

    const items = (ship?.items || []).map(it => ({
      sku: it.sku || it.itemCode || null,
      name: it.itemName || null,
      qty: it.order_qty || it.deliveryQty || it.shippedQty || null,
      price: it.price || null,
      imageUrl: it.imageUrl || null
    }));

    const normalized = {
      orderNumber,
      status: order?.status || ship?.status || vinData?.responseMessage || "Unknown",
      courier: ship?.transporter || ship?.obExtTransporterName || null,
      trackingNumber: ship?.tracking_number || null,
      trackingUrl: ship?.tracking_url || null,
      eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
      events,
      items,
      _raw: vinData
    };

    return res.status(200).json(normalized);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
