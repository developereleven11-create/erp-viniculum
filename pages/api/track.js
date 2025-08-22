// pages/api/track.js
// Accepts:
//   POST JSON: { "orderNumber": "NWB110755" }
//   GET:       ?orderNumber=NWB110755
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   VINICULUM_API_KEY      (required)
//   VINICULUM_API_OWNER    (required; e.g., "Suraj")
//   VINICULUM_ORG_ID       (optional)
//   VINICULUM_CLIENT_CODE  (optional)

const STATUS_UPDATE_URL   = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/statusUpdate";
const SHIPMENT_DETAIL_URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";

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
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!orderNumber) {
      return res.status(400).json({
        error: "Missing 'orderNumber' (string).",
        hint: "Send { orderNumber: 'NWB110755' } or use ?orderNumber=NWB110755"
      });
    }

    const apiKey     = process.env.VINICULUM_API_KEY;
    const apiOwner   = process.env.VINICULUM_API_OWNER;
    const orgId      = process.env.VINICULUM_ORG_ID;
    const clientCode = process.env.VINICULUM_CLIENT_CODE;

    if (!apiKey || !apiOwner) {
      return res.status(500).json({ error: "Server not configured. Missing VINICULUM_API_KEY or VINICULUM_API_OWNER." });
    }

    const headers = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      ...(orgId ? { OrgId: orgId } : {}),
      ...(clientCode ? { ClientCode: clientCode } : {}),
    };

    // Helper to call endpoint and parse JSON
    const call = async (url, payload, label) => {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { http: r.status, ok: r.ok, json: j, sent: payload, label };
    };
    const isVinSuccess = d => typeof d?.responseCode === "number" ? d.responseCode === 0 : true;

    // ---- Try MANY statusUpdate shapes (tenants vary) ----
    const statusPayloads = [
      { label: "orderNo",            body: { orderNo: orderNumber } },
      { label: "order_no[]",         body: { order_no: [orderNumber] } },
      { label: "request[orderNo]",   body: { request: [ { orderNo: orderNumber } ] } },
      { label: "request[order_no]",  body: { request: [ { order_no: orderNumber } ] } },
      // some tenants require a wrapper + status placeholder
      { label: "request[orderNo,status]",  body: { request: [ { orderNo: orderNumber, status: "" } ] } },
      // occasionally a minimal paging scaffold is required (copy from v2 style)
      { label: "with paging fields", body: { order_no: [orderNumber], date_from: "", date_to: "", order_location: "", pageNumber: "", filterBy: 1 } },
    ];

    const attempts = [];
    let success = null;

    for (const p of statusPayloads) {
      const r = await call(STATUS_UPDATE_URL, p.body, p.label);
      attempts.push({
        endpoint: "v1/statusUpdate",
        shape: p.label,
        http: r.http,
        responseCode: r.json?.responseCode,
        responseMessage: r.json?.responseMessage
      });
      if (r.ok && isVinSuccess(r.json)) {
        success = { mode: "statusUpdate", data: r.json };
        break;
      }
    }

    // If none of the statusUpdate shapes worked, fall back to shipmentDetail so you still get data
    if (!success) {
      const r = await call(SHIPMENT_DETAIL_URL, { orderNo: orderNumber }, "shipmentDetail");
      attempts.push({
        endpoint: "v1/shipmentDetail",
        shape: "orderNo",
        http: r.http,
        responseCode: r.json?.responseCode,
        responseMessage: r.json?.responseMessage
      });
      if (r.ok && isVinSuccess(r.json)) {
        success = { mode: "shipmentDetail", data: r.json };
      }
    }

    if (!success) {
      return res.status(400).json({
        error: "Upstream rejected or no matching payload shape succeeded.",
        endpoint: STATUS_UPDATE_URL,
        fallback: SHIPMENT_DETAIL_URL,
        tried: attempts
      });
    }

    // ---- Normalize both shapes into a simple object ----
    if (success.mode === "statusUpdate") {
      // Your sample:
      // {
      //   responseCode: 0,
      //   responseMessage: "Success",
      //   response: [{ responseCode: 0, responseMessage: "SUCCESS", orderNo: "NWB110755", invoiceNo: "", orderStatus: "" }]
      // }
      const resp = success.data;
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
        normalized.events.push({ status: "Status received", date: null, remarks: "No detailed timeline provided by statusUpdate." });
      }
      normalized._raw = resp;
      return res.status(200).json(normalized);
    }

    if (success.mode === "shipmentDetail") {
      const resp = success.data;
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

    // Should never reach here
    return res.status(500).json({ error: "Unexpected state" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
