// pages/api/track.js
// Expects a POST with JSON body: { "orderNumber": "4105939108DC" }
// Requires Vercel env vars:
//   VINICULUM_API_KEY   = your long API key
//   VINICULUM_API_OWNER = "Suraj"

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

    const apiKey = process.env.VINICULUM_API_KEY;
    const apiOwner = process.env.VINICULUM_API_OWNER;

    if (!apiKey || !apiOwner) {
      return res.status(500).json({ error: "Server not configured. Missing VINICULUM_API_KEY or VINICULUM_API_OWNER." });
    }

    // Use the shipmentDetail endpoint (per your working spec)
    const vinUrl = "https://erp.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";

    const vinResp = await fetch(vinUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header names must match exactly as required by Viniculum:
        "ApiKey": apiKey,
        "ApiOwner": apiOwner
      },
      // For v1/shipmentDetail the body field is typically `orderNo`
      body: JSON.stringify({ orderNo: orderNumber })
    });

    const text = await vinResp.text();
    let vinData;
    try {
      vinData = JSON.parse(text);
    } catch {
      vinData = { raw: text };
    }

    // Handle upstream HTTP errors
    if (!vinResp.ok) {
      return res.status(vinResp.status).json({
        error: "Upstream error",
        details: vinData
      });
    }

    // Viniculum convention: responseCode === 0 => success
    if (typeof vinData?.responseCode !== "undefined" && Number(vinData.responseCode) !== 0) {
      // Bubble up Viniculum's message to help with debugging credentials or input
      return res.status(401).json({
        error: vinData?.responseMessage || "Viniculum rejected the request",
        details: vinData
      });
    }

    // Normalize the payload for your frontend
    // Expected shapes (from your samples):
    // vinData.orders[0].status
    // vinData.orders[0].shipDetail[0].{transporter, tracking_number, tracking_url, ...}
    const order = Array.isArray(vinData?.orders) && vinData.orders.length ? vinData.orders[0] : null;
    const ship = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

    // Build a simple event timeline from available dates
    const events = [];
    if (ship) {
      if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
      if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
      if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
      if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
      if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
      // newest first
      events.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    }

    const items = (ship?.items || []).map((it) => ({
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
      _raw: vinData // keep raw for debugging in UI (you can remove later)
    };

    return res.status(200).json(normalized);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
