// pages/api/track.js
// Endpoint: /RestWS/api/eretail/v1/order/shipmentDetail (Case 1 - by order number(s))
// Accepts:
//  - POST JSON: { "orderNumbers": [...], "orderLocation":"IBW" } OR { "orderNumber": "4105939108DC", "orderLocation":"IBW" }
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

    let orderNumbers = [];
    if (Array.isArray(body.orderNumbers)) orderNumbers = body.orderNumbers;
    else if (typeof body.orderNumber === "string") orderNumbers = [body.orderNumber];
    else if (typeof q.orderNumbers === "string") orderNumbers = q.orderNumbers.split(",").map(s => s.trim()).filter(Boolean);
    else if (typeof q.orderNumber === "string") orderNumbers = [q.orderNumber.trim()];

    if (!orderNumbers.length) {
      return res.status(400).json({
        error: "Provide at least one order number.",
        hint: "POST { orderNumber: \"4105939108DC\", orderLocation: \"IBW\" }"
      });
    }

    const orderLocation =
      (typeof body.orderLocation === "string" && body.orderLocation.trim()) ||
      (typeof q.orderLocation === "string" && q.orderLocation.trim()) ||
      "";

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

    // --- Build payload exactly like your Swagger Case 1 example ---
    const payload = {
      order_no: orderNumbers,
      date_from: "",
      date_to: "",
      status: [],
      order_location: orderLocation,   // "" or site like "IBW"
      fulfillmentLocation: "",
      pageNumber: "1",
      filterBy: "1"
    };

    const upstream = await fetch(SHIPMENT_DETAIL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Upstream HTTP error",
        upstreamStatus: upstream.status,
        upstreamBody: data,
        sent: { url: SHIPMENT_DETAIL_URL, payload }
      });
    }

    if (typeof data.responseCode === "number" && data.responseCode !== 0) {
      return res.status(400).json({
        error: data.responseMessage || "Viniculum rejected the request",
        details: data,
        sent: { url: SHIPMENT_DETAIL_URL, payload }
      });
    }

    // ---- Normalize ALL orders & shipments ----
    const orders = Array.isArray(data?.orders) ? data.orders : [];

    const normalizedOrders = orders.map((order) => {
      const shipBlocks = Array.isArray(order.shipDetail) ? order.shipDetail
                       : Array.isArray(order.shipdetail) ? order.shipdetail
                       : [];

      const shipments = shipBlocks.map((s) => {
        const itemsRaw = Array.isArray(s.items) ? s.items
                      : Array.isArray(s.item)  ? s.item
                      : [];
        const items = itemsRaw.map(it => ({
          sku: it.sku || it.itemCode || null,
          name: it.itemName || null,
          qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
          price: it.price || null,
          imageUrl: it.imageUrl || null
        }));

        // Build a timeline
        const events = [];
        if (s.allocation_date) events.push({ date: s.allocation_date, status: "Allocated" });
        if (s.pick_date)       events.push({ date: s.pick_date,       status: "Picked" });
        if (s.pack_date)       events.push({ date: s.pack_date,       status: "Packed" });
        if (s.shipdate)        events.push({ date: s.shipdate,        status: "Shipped" });
        if (s.delivereddate)   events.push({ date: s.delivereddate,   status: "Delivered" });
        if (events.length === 0) {
          events.push({
            date: s.updated_date || order.createdDate || null,
            status: s.status || order.status || data?.responseMessage || "Shipment created",
            remarks: "Tracking will appear once the courier shares the first scan."
          });
        }
        events.sort((a,b)=> new Date(b.date || 0) - new Date(a.date || 0));

        return {
          deliveryNumber: s.deliveryNumber || null,
          fulfillmentLocation: s.fulfillmentLocation || null,
          courier: s.transporter || s.obExtTransporterName || null,  // ← courier partner
          trackingNumber: s.tracking_number || null,                 // ← AWB
          trackingUrl: s.tracking_url || null,
          etaMin: s.expdeldate_min || null,                          // ← ETA (min/max)
          etaMax: s.expdeldate_max || null,
          status: s.status || order.status || null,
          events,
          items,
        };
      });

      // Convenience: pick first shipment’s quick fields for top-level
      const primary = shipments[0] || {};

      return {
        extOrderNo: order.extOrderNo || null,
        orderNo: order.orderNo || order.order_no || null,
        orderLocation: order.orderLocation || null,
        channelName: order.channelName || null,
        status: order.status || primary.status || data?.responseMessage || "Unknown",
        courier: primary.courier || null,
        trackingNumber: primary.trackingNumber || null,
        trackingUrl: primary.trackingUrl || null,
        etaMin: primary.etaMin || null,
        etaMax: primary.etaMax || null,
        productNames: (primary.items || []).map(i => i.name).filter(Boolean), // ← product names
        shipments,
        raw: order
      };
    });

    // Convenience top-level (first order for your current UI)
    const first = normalizedOrders[0] || {};

    return res.status(200).json({
      mode: "v1/shipmentDetail (Case 1)",
      requestedOrders: orderNumbers,
      orderLocation: orderLocation || first.orderLocation || null,
      status: first.status || "Unknown",
      courier: first.courier || null,
      trackingNumber: first.trackingNumber || null,
      trackingUrl: first.trackingUrl || null,
      etaMin: first.etaMin || null,
      etaMax: first.etaMax || null,
      productNames: first.productNames || [],           // ← surfaced for easy UI use
      orders: normalizedOrders,                         // full detail for all orders
      _raw: data,
      _sent: payload
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
