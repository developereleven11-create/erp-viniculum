// pages/api/track.js
// Accepts:
//  - POST JSON: { "orderNumber": "2025437433" }   ← preferred
//  - GET  query: ?orderNumber=2025437433
//
// Tenant base: pokonut.vineretail.com
// Primary endpoint: /v1/order/statusUpdate (order number)
// Fallback:         /v1/order/shipmentDetail (order number)

const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
const STATUS_UPDATE_URL   = `${BASE}/v1/order/statusUpdate`;
const SHIPMENT_DETAIL_URL = `${BASE}/v1/order/shipmentDetail`;

export default async function handler(req, res) {
  try {
    if (!["POST", "GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    const body = req.method === "POST" ? (req.body || {}) : {};
    const q    = req.query || {};
    const orderNumber =
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!orderNumber) {
      return res.status(400).json({
        error: "Missing 'orderNumber' (string).",
        hint: "Send { orderNumber: '2025437433' } in POST JSON, or use ?orderNumber=2025437433"
      });
    }

    const apiKey   = process.env.VINICULUM_API_KEY;
    const apiOwner = process.env.VINICULUM_API_OWNER || "Suraj";
    const orgId    = process.env.VINICULUM_ORG_ID || "POKO";

    if (!apiKey || !apiOwner || !orgId) {
      return res.status(500).json({
        error: "Server not configured. Missing one of VINICULUM_API_KEY / VINICULUM_API_OWNER / VINICULUM_ORG_ID."
      });
    }

    const headers = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      OrgId: orgId
    };

    // Helper
    const call = async (url, payload) => {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { http: r.status, ok: r.ok, json: j, sent: payload, url };
    };
    const isVinSuccess = d => typeof d?.responseCode === "number" ? d.responseCode === 0 : true;

    // 1) Try statusUpdate with EXACT body per your spec
    const suPayloads = [
      { label: "statusUpdate: orderNo", body: { orderNo: orderNumber } },
      // If tenant expects array form, uncomment next line:
      // { label: "statusUpdate: order_no[]", body: { order_no: [orderNumber] } },
      // If tenant expects wrapper, uncomment next line:
      // { label: "statusUpdate: request[]", body: { request: [{ orderNo: orderNumber }] } },
    ];

    const attempts = [];
    let successMode = null;
    let successData = null;

    for (const p of suPayloads) {
      const r = await call(STATUS_UPDATE_URL, p.body);
      attempts.push({ endpoint: p.label, http: r.http, responseCode: r.json?.responseCode, responseMessage: r.json?.responseMessage });
      if (r.ok && isVinSuccess(r.json)) {
        successMode = "statusUpdate";
        successData = r.json;
        break;
      }
    }

    // 2) Fallback to shipmentDetail if statusUpdate didn’t return success
    if (!successMode) {
      const r = await call(SHIPMENT_DETAIL_URL, { orderNo: orderNumber });
      attempts.push({ endpoint: "shipmentDetail: orderNo", http: r.http, responseCode: r.json?.responseCode, responseMessage: r.json?.responseMessage });
      if (r.ok && isVinSuccess(r.json)) {
        successMode = "shipmentDetail";
        successData = r.json;
      }
    }

    if (!successMode) {
      return res.status(400).json({
        error: "Upstream rejected or no matching payload succeeded.",
        orderNumber,
        tried: attempts
      });
    }

    // -------- Normalize both shapes --------

    if (successMode === "statusUpdate") {
      // Expected sample:
      // {
      //   "responseCode": 0, "responseMessage": "Success",
      //   "response": [{ "responseCode": 0, "responseMessage": "SUCCESS", "orderNo": "NWB110755", "invoiceNo": "", "orderStatus": "" }]
      // }
      const resp = successData;
      const line = Array.isArray(resp?.response) && resp.response.length ? resp.response[0] : null;

      const normalized = {
        mode: "v1/statusUpdate",
        orderNumber: line?.orderNo || orderNumber,
        invoiceNo: line?.invoiceNo || null,
        status: line?.orderStatus || resp?.responseMessage || line?.responseMessage || "Unknown",
        events: []
      };

      if (line?.orderStatus) {
        normalized.events.push({ status: line.orderStatus, date: null });
      } else {
        normalized.events.push({ status: "Status received", date: null, remarks: "No detailed timeline in statusUpdate." });
      }
      normalized._raw = resp;
      return res.status(200).json(normalized);
    }

    if (successMode === "shipmentDetail") {
      // Rich shipment detail shape (orders[].shipDetail[]…)
      const resp  = successData;
      const order = Array.isArray(resp?.orders) && resp.orders.length ? resp.orders[0] : null;
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
        const fallbackStatus = ship?.status || order?.status || resp?.responseMessage || "Shipment created";
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
        mode: "v1/shipmentDetail",
        orderNumber,
        status: order?.status || ship?.status || resp?.responseMessage || "Unknown",
        courier: ship?.transporter || ship?.obExtTransporterName || null,
        trackingNumber: ship?.tracking_number || null,
        trackingUrl: ship?.tracking_url || null,
        eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
        events,
        items,
        _raw: resp
      });
    }

    return res.status(500).json({ error: "Unexpected state" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
