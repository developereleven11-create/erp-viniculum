// pages/api/track.js
const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
const SHIP_DETAIL_URL     = `${BASE}/v1/order/shipDetail`;
const SHIPMENT_DETAIL_URL = `${BASE}/v1/order/shipmentDetail`;

export default async function handler(req, res) {
  try {
    if (!["POST","GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    const body = req.method === "POST" ? (req.body || {}) : {};
    const q    = req.query || {};
    const orderNumber =
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) || "";
    const orderLocation =
      (typeof body.orderLocation === "string" && body.orderLocation.trim()) ||
      (typeof q.orderLocation === "string" && q.orderLocation.trim()) ||
      process.env.VINICULUM_DEFAULT_ORDER_LOCATION || ""; // set this in Vercel if helpful (e.g., "NWB")

    if (!orderNumber) {
      return res.status(400).json({ error: "Missing 'orderNumber' (string)." });
    }

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

    const call = async (url, payload, label) => {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { label, http: r.status, ok: r.ok, json, text, sent: payload, url };
    };

    // 1) Try shipDetail (Case 2 by order number) — requires correct order_location for that order
    const shipPayload = {
      order_no: orderNumber,
      statuses: [],
      order_location: orderLocation, // empty allowed but many tenants require correct site code
      channel_code: [],
      date_from: "",
      date_to: "",
      pageNumber: ""
    };

    const r1 = await call(SHIP_DETAIL_URL, shipPayload, "shipDetail");
    if (r1.ok) {
      if (typeof r1.json.responseCode === "number" && r1.json.responseCode !== 0) {
        // upstream JSON error (like "Order not found")
        return res.status(400).json({ error: r1.json.responseMessage || "Rejected", details: r1.json, sent: { url: r1.url, payload: r1.sent } });
      }
      // normalize typical v1 shape (orders[].shipDetail[])
      const order = Array.isArray(r1.json?.orders) && r1.json.orders.length ? r1.json.orders[0] : null;
      const ship  = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

      const events = [];
      if (ship) {
        if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
        if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
        if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
        if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
        if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
      }
      if (events.length === 0) {
        const fallbackDate = ship?.updated_date || order?.createdDate || null;
        const fallbackStatus = ship?.status || order?.status || r1.json?.responseMessage || "Shipment created";
        events.push({ date: fallbackDate, status: fallbackStatus, remarks: "Tracking will appear once the courier shares the first scan." });
      }
      events.sort((a,b)=> new Date(b.date || 0) - new Date(a.date || 0));

      const items = (ship?.items || []).map(it => ({
        sku: it.sku || it.itemCode || null,
        name: it.itemName || null,
        qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
        price: it.price || null,
        imageUrl: it.imageUrl || null
      }));

      return res.status(200).json({
        mode: "v1/shipDetail",
        orderNumber,
        orderLocation: orderLocation || order?.orderLocation || null,
        status: order?.status || ship?.status || r1.json?.responseMessage || "Unknown",
        courier: ship?.transporter || ship?.obExtTransporterName || null,
        trackingNumber: ship?.tracking_number || null,
        trackingUrl: ship?.tracking_url || null,
        eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
        events,
        items,
        _raw: r1.json,
        _sent: r1.sent
      });
    }

    // 2) If shipDetail was a non-2xx (HTTP) error, fall back to shipmentDetail (enabled)
    const r2 = await call(SHIPMENT_DETAIL_URL, { orderNo: orderNumber }, "shipmentDetail");
    if (!r2.ok) {
      // Still non-2xx — surface exact status & text so we know why
      return res.status(r2.http).json({
        error: "Upstream HTTP error",
        upstreamStatus: r2.http,
        upstreamText: r2.text,
        sent: { shipDetail: { url: r1.url, http: r1.http, payload: r1.sent }, shipmentDetail: { url: r2.url, http: r2.http, payload: r2.sent } }
      });
    }
    if (typeof r2.json.responseCode === "number" && r2.json.responseCode !== 0) {
      return res.status(400).json({
        error: r2.json.responseMessage || "ShipmentDetail rejected",
        details: r2.json,
        sent: { url: r2.url, payload: r2.sent }
      });
    }

    // Normalize shipmentDetail response
    const order = Array.isArray(r2.json?.orders) && r2.json.orders.length ? r2.json.orders[0] : null;
    const ship  = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

    const events = [];
    if (ship) {
      if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
      if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
      if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
      if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
      if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
    }
    if (events.length === 0) {
      const fallbackDate = ship?.updated_date || order?.createdDate || null;
      const fallbackStatus = ship?.status || order?.status || r2.json?.responseMessage || "Shipment created";
      events.push({ date: fallbackDate, status: fallbackStatus, remarks: "Tracking will appear once the courier shares the first scan." });
    }
    events.sort((a,b)=> new Date(b.date || 0) - new Date(a.date || 0));

    const items = (ship?.items || []).map(it => ({
      sku: it.sku || it.itemCode || null,
      name: it.itemName || null,
      qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
      price: it.price || null,
      imageUrl: it.imageUrl || null
    }));

    return res.status(200).json({
      mode: "v1/shipmentDetail (fallback)",
      orderNumber,
      status: order?.status || ship?.status || r2.json?.responseMessage || "Unknown",
      courier: ship?.transporter || ship?.obExtTransporterName || null,
      trackingNumber: ship?.tracking_number || null,
      trackingUrl: ship?.tracking_url || null,
      eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
      events,
      items,
      _raw: r2.json,
      _sent: r2.sent
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
