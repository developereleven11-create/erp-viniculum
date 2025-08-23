// pages/api/track.js
export default async function handler(req, res) {
  try {
    if (!["POST", "GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    const body = req.method === "POST" ? (req.body || {}) : {};
    const q = req.query || {};

    let orderNumbers = [];
    if (Array.isArray(body.orderNumbers)) orderNumbers = body.orderNumbers;
    else if (typeof body.orderNumber === "string") orderNumbers = [body.orderNumber];
    else if (typeof q.orderNumbers === "string") orderNumbers = q.orderNumbers.split(",").map(s => s.trim()).filter(Boolean);
    else if (typeof q.orderNumber === "string") orderNumbers = [q.orderNumber.trim()];

    if (!orderNumbers.length) {
      return res.status(400).json({ error: "Provide at least one order number." });
    }

    const orderLocation =
      (typeof body.orderLocation === "string" && body.orderLocation.trim()) ||
      (typeof q.orderLocation === "string" && q.orderLocation.trim()) ||
      "";

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

    const payload = {
      order_no: orderNumbers,
      date_from: "",
      date_to: "",
      status: [],
      order_location: orderLocation,
      fulfillmentLocation: "",
      pageNumber: "1",
      filterBy: "1"
    };

    const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
    const SHIPMENT_DETAIL_URL = `${BASE}/v1/order/shipmentDetail`;

    const upstream = await fetch(SHIPMENT_DETAIL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream HTTP error" });
    }

    if (typeof data.responseCode === "number" && data.responseCode !== 0) {
      return res.status(400).json({ error: data.responseMessage || "Viniculum rejected the request" });
    }

    const parseNum = (v) => {
      if (v === null || v === undefined) return null;
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

    const orders = Array.isArray(data?.orders) ? data.orders : [];

    const normalizedOrders = orders.map((order) => {
      const shipBlocks = Array.isArray(order.shipDetail) ? order.shipDetail
                       : Array.isArray(order.shipdetail) ? order.shipdetail
                       : [];

      const shipments = shipBlocks.map((s) => {
        const itemsRaw = Array.isArray(s.items) ? s.items
                       : Array.isArray(s.item)  ? s.item
                       : [];

        const items = itemsRaw.map(it => {
          const qty = parseNum(it.order_qty ?? it.deliveryQty ?? it.shippedQty);
          const unit = parseNum(it.price);
          const lineTotal = qty != null && unit != null ? +(qty * unit).toFixed(2) : unit;
          return {
            sku: it.sku || it.itemCode || null,
            name: it.itemName || null,
            qty,
            unitPrice: unit,
            lineTotal,
            imageUrl: it.imageUrl || null
          };
        });

        const events = [];
        if (s.allocation_date) events.push({ date: s.allocation_date, status: "Allocated" });
        if (s.pick_date)       events.push({ date: s.pick_date,       status: "Picked" });
        if (s.pack_date)       events.push({ date: s.pack_date,       status: "Packed" });
        if (s.shipdate)        events.push({ date: s.shipdate,        status: "Shipped" });
        if (s.transporterstatus || s.transporterstatusremark || s.updated_date) {
          events.push({
            date: s.updated_date || s.shipdate || null,
            status: normalizeStatus(s.transporterstatus || s.status) || "In Transit",
            remarks: s.transporterstatusremark || null
          });
        }
        if (s.delivereddate)   events.push({ date: s.delivereddate,   status: "Delivered" });

        events.sort((a,b)=> new Date(a.date || 0) - new Date(b.date || 0));

        return {
          deliveryNumber: s.deliveryNumber || null,
          courier: s.transporter || s.obExtTransporterName || null,
          trackingNumber: s.tracking_number || null,
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
        extOrderNo: order.extOrderNo || null,
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
        shipments
      };
    });

    const first = normalizedOrders[0] || {};

    return res.status(200).json({
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
      orders: normalizedOrders
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
