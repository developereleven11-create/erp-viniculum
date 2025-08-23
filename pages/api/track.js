// pages/api/track.js
// Self-contained API for Pokonut Shopify tracking page.
// Calls Viniculum: /RestWS/api/eretail/v1/order/shipmentDetail (Case 1 - by order numbers)

const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
const SHIPMENT_DETAIL_URL = `${BASE}/v1/order/shipmentDetail`;

export default async function handler(req, res) {
  // ---------- CORS (permissive so it works from Shopify editor + storefront) ----------
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Origin, X-Requested-With"
  );
  if (req.method === "OPTIONS") return res.status(200).end();
  // -----------------------------------------------------------------------------------

  try {
    // Only GET/POST
    if (!["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Use GET or POST." });
    }

    // ---------- Read inputs ----------
    let body = req.method === "POST" ? (req.body ?? {}) : {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const q = req.query || {};

    // Accept: orderNumber (string) or orderNumbers (array or comma-separated)
    let orderNumbers = [];
    if (Array.isArray(body.orderNumbers)) orderNumbers = body.orderNumbers;
    else if (typeof body.orderNumber === "string") orderNumbers = [body.orderNumber];
    else if (typeof q.orderNumbers === "string")
      orderNumbers = q.orderNumbers.split(",").map(s => s.trim()).filter(Boolean);
    else if (typeof q.orderNumber === "string")
      orderNumbers = [q.orderNumber.trim()];

    if (!orderNumbers.length) {
      return res.status(400).json({
        error: "Provide at least one order number.",
        hint: "GET /api/track?orderNumber=4105939108DC or POST { orderNumber: \"410...\" }"
      });
    }

    const orderLocation =
      (typeof body.orderLocation === "string" && body.orderLocation.trim()) ||
      (typeof q.orderLocation === "string" && q.orderLocation.trim()) ||
      "";

    // ---------- Env / headers ----------
    const apiKey   = process.env.VINICULUM_API_KEY;
    const apiOwner = process.env.VINICULUM_API_OWNER; // e.g., "Suraj"
    const orgId    = process.env.VINICULUM_ORG_ID;    // e.g., "POKO"

    if (!apiKey || !apiOwner || !orgId) {
      return res.status(500).json({
        error: "Server not configured. Missing VINICULUM_API_KEY / VINICULUM_API_OWNER / VINICULUM_ORG_ID."
      });
    }

    const headers = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      OrgId: orgId
    };

    // ---------- Payload (Swagger: Case 1 by order number[s]) ----------
    const payload = {
      order_no: orderNumbers,   // array of order numbers
      date_from: "",
      date_to: "",
      status: [],
      order_location: orderLocation,  // "" or site (e.g. "IBW")
      fulfillmentLocation: "",
      pageNumber: "1",
      filterBy: "1"
    };

    // ---------- Call Viniculum ----------
    const upstream = await fetch(SHIPMENT_DETAIL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    let upstreamData;
    try { upstreamData = JSON.parse(text); } catch { upstreamData = { raw: text }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Upstream HTTP error",
        upstreamStatus: upstream.status,
        upstreamBody: upstreamData,
        sent: { url: SHIPMENT_DETAIL_URL, payload }
      });
    }

    if (typeof upstreamData.responseCode === "number" && upstreamData.responseCode !== 0) {
      return res.status(400).json({
        error: upstreamData.responseMessage || "Viniculum rejected the request",
        details: upstreamData,
        sent: { url: SHIPMENT_DETAIL_URL, payload }
      });
    }

    // ---------- Normalize ----------
    const parseNum = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const normalizeStatus = (s) => {
      if (!s) return null;
      const t = String(s).toLowerCase().replace(/\s+/g, "");
      if (t === "intransit" || t === "in_transit") return "In Transit";
      if (t === "shipped") return "Shipped";
      if (t === "shippedcomplete") return "Shipped complete";
      if (t === "delivered") return "Delivered";
      return String(s);
    };

    const orders = Array.isArray(upstreamData?.orders) ? upstreamData.orders : [];

    const normalizedOrders = orders.map((order) => {
      // shipDetail vs shipdetail
      const shipBlocks = Array.isArray(order.shipDetail) ? order.shipDetail
                       : Array.isArray(order.shipdetail) ? order.shipdetail
                       : [];

      const shipments = shipBlocks.map((s) => {
        const itemsRaw = Array.isArray(s.items) ? s.items
                      : Array.isArray(s.item)  ? s.item
                      : [];

        const items = itemsRaw.map(it => {
          const qty  = parseNum(it.order_qty ?? it.deliveryQty ?? it.shippedQty);
          const unit = parseNum(it.price);
          const lineTotal = (qty != null && unit != null) ? +(qty * unit).toFixed(2) : unit;
          return {
            sku: it.sku || it.itemCode || null,
            name: it.itemName || null,
            qty,
            unitPrice: unit,
            lineTotal,
            imageUrl: it.imageUrl || null
          };
        });

        // Timeline events
        const events = [];
        if (s.allocation_date) events.push({ date: s.allocation_date, status: "Allocated" });
        if (s.pick_date)       events.push({ date: s.pick_date,       status: "Picked" });
        if (s.pack_date)       events.push({ date: s.pack_date,       status: "Packed" });
        if (s.shipdate)        events.push({ date: s.shipdate,        status: "Shipped" });

        if (s.transporterstatus || s.transporterstatusremark || s.updated_date) {
          const readable =
            normalizeStatus(s.transporterstatus) ||
            normalizeStatus(s.status) ||
            "In Transit";
          events.push({
            date: s.updated_date || s.shipdate || null,
            status: readable,
            remarks: s.transporterstatusremark || null
          });
        }
        if (s.delivereddate)   events.push({ date: s.delivereddate,   status: "Delivered" });

        if (!events.length) {
          events.push({
            date: s.updated_date || order.createdDate || null,
            status: normalizeStatus(s.status || order.status || upstreamData?.responseMessage || "Shipment created"),
            remarks: "Tracking will appear once the courier shares the first scan."
          });
        }

        // Sort newest first
        events.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        return {
          deliveryNumber: s.deliveryNumber || null,
          fulfillmentLocation: s.fulfillmentLocation || null,
          courier: s.transporter || s.obExtTransporterName || null,  // courier partner
          trackingNumber: s.tracking_number || null,                  // AWB
          trackingUrl: s.tracking_url || null,
          etaMin: s.expdeldate_min || null,
          etaMax: s.expdeldate_max || null,
          status: normalizeStatus(s.status || s.transporterstatus || order.status || null),
          lastScanRemark: s.transporterstatusremark || null,
          events,
          items
        };
      });

      const primary = shipments[0] || {};

      return {
        extOrderNo: order.extOrderNo || order.extOrderNo || null,
        orderNo: order.orderNo || order.order_no || null,
        orderLocation: order.orderLocation || null,
        channelName: order.channelName || null,

        currentStatus: primary.status || normalizeStatus(order.status) || "Unknown",
        courier: primary.courier || null,
        trackingNumber: primary.trackingNumber || null,
        trackingUrl: primary.trackingUrl || null,
        etaMin: primary.etaMin || null,
        etaMax: primary.etaMax || null,

        productNames: (primary.items || []).map(i => i.name).filter(Boolean),
        products: primary.items || [],
        shipments,
        raw: order
      };
    });

    const first = normalizedOrders[0] || {};

    // ---------- Response your frontend/Shopify snippet expects ----------
    return res.status(200).json({
      mode: "v1/shipmentDetail (Case 1)",
      requestedOrders: orderNumbers,
      orderLocation: orderLocation || first.orderLocation || null,

      status: first.currentStatus || "Unknown",
      courier: first.courier || null,
      trackingNumber: first.trackingNumber || null,
      trackingUrl: first.trackingUrl || null,
      etaMin: first.etaMin || null,
      etaMax: first.etaMax || null,

      productNames: first.productNames || [],
      products: first.products || [],
      events: (first.shipments?.[0]?.events) || [],

      orders: normalizedOrders,  // full detail per order
      _raw: upstreamData,        // raw upstream (for debugging)
      _sent: payload             // payload we sent (for debugging)
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
