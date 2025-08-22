// pages/api/track.js
// Accepts:
//  - POST JSON: { "deliveryNo": "WH2766812322" }  ← preferred
//  - POST JSON: { "orderNumber": "4105939108DC" } ← also accepted
//  - GET query:  ?deliveryNo=... or ?orderNumber=...
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//  VINICULUM_API_KEY
//  VINICULUM_API_OWNER     (e.g., "Suraj")
//  VINICULUM_ORG_ID        (optional if your tenant needs it)
//  VINICULUM_CLIENT_CODE   (optional if your tenant needs it)

const ORDER_SHIP_URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/orderShip";
const V1_STATUS_URL  = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";
const V2_STATUS_URL  = "https://pokonut.vineretail.com/RestWS/api/eretail/v2/order/status";

export default async function handler(req, res) {
  try {
    if (!["POST","GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // Grab input from body or query; allow both names
    const body = req.method === "POST" ? (req.body || {}) : {};
    const q    = req.query || {};
    const rawInput =
      (typeof body.deliveryNo === "string" && body.deliveryNo.trim()) ||
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.deliveryNo === "string" && q.deliveryNo.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!rawInput) {
      return res.status(400).json({
        error: "Provide a Delivery No or Order No.",
        hint: "Send { deliveryNo: 'WH2766812322' } or { orderNumber: '4105939108DC' }"
      });
    }

    const apiKey     = process.env.VINICULUM_API_KEY;
    const apiOwner   = process.env.VINICULUM_API_OWNER;
    const orgId      = process.env.VINICULUM_ORG_ID;
    const clientCode = process.env.VINICULUM_CLIENT_CODE;

    if (!apiKey || !apiOwner) {
      return res.status(500).json({ error: "Server not configured. Missing VINICULUM_API_KEY or VINICULUM_API_OWNER." });
    }

    const baseHeaders = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      ...(orgId ? { OrgId: orgId } : {}),
      ...(clientCode ? { ClientCode: clientCode } : {})
    };

    // Helper to call and parse JSON safely
    const call = async (url, payload) => {
      const r = await fetch(url, { method: "POST", headers: baseHeaders, body: JSON.stringify(payload) });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok, status: r.status, json: j };
    };
    const okVin = d => typeof d?.responseCode === "undefined" ? true : Number(d.responseCode) === 0;

    // Normalizers
    const normalizeOrderShip = (data, deliveryNo) => {
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

      return {
        mode: "orderShip",
        input: rawInput,
        deliveryNo,
        status: order?.status || ship?.status || data?.responseMessage || "Unknown",
        courier: ship?.transporter || ship?.obExtTransporterName || null,
        trackingNumber: ship?.tracking_number || null,
        trackingUrl: ship?.tracking_url || null,
        eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
        events,
        items,
        _raw: data
      };
    };

    const normalizeStatusLine = (payload, mode) => {
      const line = Array.isArray(payload?.response) && payload.response.length ? payload.response[0] : null;
      return {
        mode,
        input: rawInput,
        orderNumber: line?.order_no || null,
        status: line?.transporterStatus || line?.line_status || payload?.responseMessage || "Unknown",
        courier: line?.transporterName || null,
        trackingNumber: line?.awbno || null,
        trackingUrl: null,
        eta: null,
        events: [
          ...(line?.shipdate ? [{ date: line.shipdate, status: "Shipped" }] : []),
          ...(line?.delivereddate ? [{ date: line.delivereddate, status: "Delivered" }] : []),
        ],
        items: line ? [{ sku: line?.sku || null, name: null, qty: line?.shipped_Qty || null }] : [],
        _raw: payload
      };
    };

    const attempts = [];

    // 1) Treat input as a Delivery No (exact)
    const tryExactDelivery = async () => {
      const payload = { request: [{ deliveryNo: rawInput }] };
      const r = await call(ORDER_SHIP_URL, payload);
      attempts.push({ where: "orderShip exact", payload, status: r.status, code: r.json?.responseCode, msg: r.json?.responseMessage });
      if (r.ok && okVin(r.json)) return normalizeOrderShip(r.json, rawInput);
      return null;
    };

    // 2) If input is all digits, try common prefixes: WH / IBW / NWB
    const tryPrefixedDelivery = async () => {
      if (!/^\d+$/.test(rawInput)) return null;
      const prefixes = ["WH","IBW","NWB"];
      for (const p of prefixes) {
        const dn = p + rawInput;
        const payload = { request: [{ deliveryNo: dn }] };
        const r = await call(ORDER_SHIP_URL, payload);
        attempts.push({ where: `orderShip ${p}+digits`, payload, status: r.status, code: r.json?.responseCode, msg: r.json?.responseMessage });
        if (r.ok && okVin(r.json)) return normalizeOrderShip(r.json, dn);
      }
      return null;
    };

    // 3) Try v1/shipmentDetail with orderNo (some inputs are actually order numbers)
    const tryV1OrderNo = async () => {
      const payload = { orderNo: rawInput };
      const r = await call(V1_STATUS_URL, payload);
      attempts.push({ where: "v1 shipmentDetail orderNo", payload, status: r.status, code: r.json?.responseCode, msg: r.json?.responseMessage });
      if (r.ok && okVin(r.json)) {
        // reuse normalizer
        const normalized = normalizeOrderShip(r.json, null);
        normalized.mode = "v1/shipmentDetail";
        return normalized;
      }
      return null;
    };

    // 4) Try v2/order/status with order_no array
    const tryV2OrderStatus = async () => {
      const payload = { order_no: [rawInput], date_from: "", date_to: "", order_location: "", pageNumber: "", filterBy: 1 };
      const r = await call(V2_STATUS_URL, payload);
      attempts.push({ where: "v2 order/status", payload, status: r.status, code: r.json?.responseCode, msg: r.json?.responseMessage });
      if (r.ok && okVin(r.json)) return normalizeStatusLine(r.json, "v2");
      return null;
    };

    // Run attempts in order
    let result =
      (await tryExactDelivery()) ||
      (await tryPrefixedDelivery()) ||
      (await tryV1OrderNo()) ||
      (await tryV2OrderStatus());

    if (result) return res.status(200).json(result);

    // Nothing worked → tell the user exactly what we tried
    return res.status(404).json({
      error: "Not found in this tenant with the given identifier.",
      input: rawInput,
      attempts
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
