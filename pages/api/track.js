
// pages/api/track.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { orderNumber } = req.body || {};
    if (!orderNumber || typeof orderNumber !== "string") {
      return res.status(400).json({ error: "Missing 'orderNumber' in body" });
    }

    const apiKey = process.env.VINICULUM_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Server not configured. Missing VINICULUM_API_KEY." });
    }

    const vinUrl = "https://erp.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";

    const vinResp = await fetch(vinUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Viniculum provided header key; HTTP headers are case-insensitive but we mirror their label
        "ApiKey": apiKey
      },
      body: JSON.stringify({ orderNo: orderNumber })
    });

    let vinDataText = await vinResp.text();
    let vinData;
    try { vinData = JSON.parse(vinDataText); } catch { vinData = { raw: vinDataText }; }

    if (!vinResp.ok) {
      return res.status(vinResp.status).json({ error: "Upstream error", details: vinData });
    }

    // Viniculum sample structure:
    // { responseCode, orders: [ { status, shipDetail: [ { transporter, tracking_number, tracking_url, status, shipdate, updated_date, delivereddate, items: [...] } ] } ] }
    const order = Array.isArray(vinData?.orders) && vinData.orders.length ? vinData.orders[0] : null;
    const ship = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

    const events = [];
    if (ship) {
      if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
      if (ship.pick_date) events.push({ date: ship.pick_date, status: "Picked" });
      if (ship.pack_date) events.push({ date: ship.pack_date, status: "Packed" });
      if (ship.shipdate) events.push({ date: ship.shipdate, status: "Shipped" });
      if (ship.delivereddate) events.push({ date: ship.delivereddate, status: "Delivered" });
      // Sort newest first
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

    // Viniculum uses responseCode 0 for success per sample
    if (typeof vinData?.responseCode !== "undefined" && Number(vinData.responseCode) !== 0) {
      return res.status(404).json({ error: vinData.responseMessage || "Order not found", details: normalized });
    }

    return res.status(200).json(normalized);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
