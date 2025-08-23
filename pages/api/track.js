// pages/api/track.js
// Endpoint: /RestWS/api/eretail/v1/order/shipmentDetail (Case 1 - by order number(s))
// Usage examples:
//  - POST JSON: { "orderNumbers": ["7F6736867934","4105939108DC"], "orderLocation":"IBW" }
//  - POST JSON: { "orderNumber": "4105939108DC", "orderLocation":"IBW" }
//  - GET: /api/track?orderNumbers=7F6736867934,4105939108DC&orderLocation=IBW

const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
const SHIPMENT_DETAIL_URL = `${BASE}/v1/order/shipmentDetail`;

export default async function handler(req, res) {
  try {
    if (!["POST", "GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // --- Read inputs ---
    const body = req.method === "POST" ? (req.body || {}) : {};
    const q = req.query || {};

    // Accept single or multiple order numbers
    let orderNumbers = [];
    if (Array.isArray(body.orderNumbers)) {
      orderNumbers = body.orderNumbers;
    } else if (typeof body.orderNumber === "string") {
      orderNumbers = [body.orderNumber];
    } else if (typeof q.orderNumbers === "string") {
      orderNumbers = q.orderNumbers.split(",").map(s => s.trim()).filter(Boolean);
    } else if (typeof q.orderNumber === "string") {
      orderNumbers = [q.orderNumber.trim()];
    }

    if (!orderNumbers.length) {
      return res.status(400).json({
        error: "Provide at least one order number.",
        hint: "POST { orderNumber: \"4105939108DC\", orderLocation: \"IBW\" } or { orderNumbers: [\"7F6736867934\",\"4105939108DC\"], orderLocation: \"IBW\" }"
      });
    }

    const orderLocation =
      (typeof body.orderLocation === "string" && body.orderLocation.trim()) ||
      (typeof q.orderLocation === "string" && q.orderLocation.trim()) ||
      ""; // optional, but recommended (e.g., "IBW", "NWB", ...)

    // --- Env / headers ---
    const apiKey   = process.env.VINICULUM_API_KEY;
    const apiOwner = process.env.VINICULUM_API_OWNER; // "Suraj"
    const orgId    = process.env.VINICULUM_ORG_ID;    // "POKO"
    if (!apiKey || !apiOwner || !orgId) {
      return res.status(500).json({ error: "Missing VINICULUM_API_KEY / _API_OWNER / _ORG_ID" });
    }

    const headers = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      OrgId: orgId
    };

    // --- Build payload exactly like Swagger Case 1 example (by order numbers) ---
    const payload = {
      order_no: orderNumbers,     // array
      date_from: "",
      date_to: "",
      status: [],                 // empty array
      order_location: orderLocation,   // "" or a site like "IBW"
      fulfillmentLocation: "",
      pageNumber: "1",            // strings per your example
      filterBy: "1"
    };

    // --- Call Viniculum ---
    const upstream = await fetch(SHIPMENT_DETAIL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!upstream.ok) {
      // Non-2xx HTTP from upstream
      return res.status(upstream.status).json({
        error: "Upstream HTTP error",
        upstreamStatus: upstream.status,
        upstreamBody: data,
        sent: { url: SHIPMENT_DETAIL_URL, payload }
      });
    }

    if (typeof data.responseCode === "number" && data.responseCode !== 0) {
      // Viniculum JSON returned an error
      return res.status(400).json({
        error: data.responseMessage || "Viniculum rejected the request",
        details: data,
        sent: { url: SHIPMENT_DETAIL_URL, payload }
      });
    }

    // --- Normalize response for UI (orders[].shipDetail[] pattern) ---
    const firstOrder = Array.isArray(data?.orders) && data.orders.length ? data.orders[0] : null;
    const firstShip  = firstOrder && Array.isArray(firstOrder.shipDetail) && firstOrder.shipDetail.length
      ? firstOrder.shipDetail[0]
      : null;

    const events = [];
    if (firstShip) {
      if (firstShip.allocation_date) events.push({ date: firstShip.allocation_date, status: "Allocated" });
      if (firstShip.pick_date)      events.push({ date: firstShip.pick_date,      status: "Picked" });
      if (firstShip.pack_date)      events.push({ date: firstShip.pack_date,      status: "Packed" });
      if (firstShip.shipdate)       events.push({ date: firstShip.shipdate,       status: "Shipped" });
      if (firstShip.delivereddate)  events.push({ date: firstShip.delivereddate,  status: "Delivered" });
    }
    if (events.length === 0) {
      const fallbackDate =
        firstShip?.updated_date || firstOrder?.createdDate || null;
      const fallbackStatus =
        firstShip?.status || firstOrder?.status || data?.responseMessage || "Shipment created";
      events.push({
        date: fallbackDate,
        status: fallbackStatus,
        remarks: "Tracking will appear once the courier shares the first scan."
      });
    }
    events.sort((a,b)=> new Date(b.date || 0) - new Date(a.date || 0));

    const items = (firstShip?.items || []).map(it => ({
      sku: it.sku || it.itemCode || null,
      name: it.itemName || null,
      qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
      price: it.price || null,
      imageUrl: it.imageUrl || null
    }));

    return res.status(200).json({
      mode: "v1/shipmentDetail (Case 1)",
      requestedOrders: orderNumbers,
      orderLocation: orderLocation || firstOrder?.orderLocation || null,
      status: firstOrder?.status || firstShip?.status || data?.responseMessage || "Unknown",
      courier: firstShip?.transporter || firstShip?.obExtTransporterName || null,
      trackingNumber: firstShip?.tracking_number || null,
      trackingUrl: firstShip?.tracking_url || null,
      eta: firstShip?.expdeldate_max || firstShip?.expdeldate_min || null,
      events,
      items,
      _raw: data,
      _sent: payload
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
