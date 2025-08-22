// pages/api/track.js
// Uses: /RestWS/api/eretail/v1/order/shipDetail  (tenant: pokonut)
// Accepts:
//  - POST JSON (recommended for your form), or GET query params
//    • Case 2 (by order): { orderNumber: "806678", orderLocation: "NWH" }
//    • Case 1 (filters):  { statuses: ["Shipped","Delivered"], orderLocation: "NWH", channelCode: ["M01"], dateFrom: "DD/MM/YYYY HH:mm:ss", dateTo: "DD/MM/YYYY HH:mm:ss", pageNumber: 1, filterBy: 1 }
//
// GET supports comma-separated lists, e.g. ?statuses=Shipped,Delivered&channelCode=M01

const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
const SHIP_DETAIL_URL = `${BASE}/v1/order/shipDetail`;

export default async function handler(req, res) {
  try {
    if (!["POST","GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // ---- Read input (from POST body or GET query) ----
    const body = req.method === "POST" ? (req.body || {}) : {};
    const q    = req.query || {};

    // Single order lookup (Case 2)
    const orderNumber =
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    // Optional fields (both cases)
    const orderLocation =
      (typeof body.orderLocation === "string" && body.orderLocation.trim()) ||
      (typeof q.orderLocation === "string" && q.orderLocation.trim()) ||
      ""; // e.g., "NWH"

    // Case 1 arrays: accept array or comma-separated string
    const readList = (v) => Array.isArray(v)
      ? v
      : (typeof v === "string" && v.trim())
      ? v.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    const statuses    = readList(body.statuses ?? q.statuses);          // ["Shipped","Delivered"]
    const channelCode = readList(body.channelCode ?? q.channelCode);    // ["M01"]

    // Dates must be exactly "DD/MM/YYYY HH:mm:ss" per Swagger (pass-through)
    const dateFrom = typeof body.dateFrom === "string" ? body.dateFrom :
                     typeof q.dateFrom === "string"    ? q.dateFrom    : "";
    const dateTo   = typeof body.dateTo   === "string" ? body.dateTo   :
                     typeof q.dateTo   === "string"    ? q.dateTo      : "";

    // Pagination / filter flag (optional)
    const pageNumber = body.pageNumber ?? q.pageNumber ?? "";
    const filterBy   = body.filterBy   ?? body.filterby ?? q.filterBy ?? q.filterby ?? "";

    // ---- Build payload per Swagger cases ----
    // Case 2: by order number (preferred for storefront)
    let payload;
    if (orderNumber) {
      payload = {
        order_no: orderNumber,
        statuses: [],
        order_location: orderLocation || "",  // Swagger shows "NWH"; empty allowed
        channel_code: [],
        date_from: "",
        date_to: "",
        pageNumber: ""
      };
    } else {
      // Case 1: by filter
      payload = {
        order_no: "",
        statuses,
        order_location: orderLocation || "",
        channel_code: channelCode,
        date_from: dateFrom,
        date_to: dateTo,
        pageNumber: pageNumber === "" ? "" : Number(pageNumber),
        filterby: filterBy === "" ? "" : Number(filterBy)
      };
    }

    // ---- Auth headers from Vercel env ----
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

    // ---- Call Viniculum ----
    const upstream = await fetch(SHIP_DETAIL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const raw = await upstream.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream HTTP error", details: data, sent: { url: SHIP_DETAIL_URL, payload } });
    }

    // Success convention: responseCode === 0
    if (typeof data.responseCode === "number" && data.responseCode !== 0) {
      return res.status(400).json({
        error: data.responseMessage || "Viniculum rejected the request",
        details: data,
        sent: { url: SHIP_DETAIL_URL, payload }
      });
    }

    // ---- Normalize (handle typical v1 order/shipDetail shape) ----
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
    if (events.length === 0) {
      const fallbackDate =
        ship?.updated_date || order?.createdDate || null;
      const fallbackStatus =
        ship?.status || order?.status || data?.responseMessage || "Shipment created";
      events.push({
        date: fallbackDate,
        status: fallbackStatus,
        remarks: "Tracking will appear once the courier shares the first scan."
      });
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
      inputMode: orderNumber ? "order" : "filter",
      orderNumber: orderNumber || null,
      orderLocation: orderLocation || order?.orderLocation || null,
      status: order?.status || ship?.status || data?.responseMessage || "Unknown",
      courier: ship?.transporter || ship?.obExtTransporterName || null,
      trackingNumber: ship?.tracking_number || null,
      trackingUrl: ship?.tracking_url || null,
      eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
      events,
      items,
      _raw: data,      // keep while testing; remove later if desired
      _sent: payload   // echo to verify payload shape
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
