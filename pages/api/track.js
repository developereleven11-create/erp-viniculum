// pages/api/track.js
// POST body: { "orderNumber": "4105939108DC" }
// Env vars (Vercel -> Project -> Settings -> Environment Variables):
//   VINICULUM_API_KEY     = your long key
//   VINICULUM_API_OWNER   = Suraj
//   VINICULUM_CLIENT_CODE = (optional, if your tenant needs it)

const V1_URL = "https://erp.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail";
const V4_URL = "https://erp.vineretail.com/RestWS/api/eretail/v4/order/status";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const { orderNumber } = req.body || {};
    if (!orderNumber || typeof orderNumber !== "string") {
      return res.status(400).json({ error: "Missing 'orderNumber' in request body" });
    }

    const apiKey = process.env.VINICULUM_API_KEY;
    const apiOwner = process.env.VINICULUM_API_OWNER;
    const clientCode = process.env.VINICULUM_CLIENT_CODE || undefined;

    if (!apiKey || !apiOwner) {
      return res.status(500).json({
        error: "Server not configured. Missing VINICULUM_API_KEY or VINICULUM_API_OWNER."
      });
    }

    // We’ll try a sequence of header variants commonly used by Vin-eRetail gateways.
    const headerVariants = [
      (k,o,c) => ({ "Content-Type":"application/json", "ApiKey": k, "ApiOwner": o, ...(c?{ "ClientCode": c }: {}) }),
      (k,o)   => ({ "Content-Type":"application/json", "APIKey": k, "ApiOwner": o }),
      (k,o)   => ({ "Content-Type":"application/json", "x-api-key": k, "ApiOwner": o }),
      (k,o)   => ({ "Content-Type":"application/json", "Authorization": `Bearer ${k}`, "ApiOwner": o }),
    ];

    // Helper to detect Vin-eRetail "success"
    const isSuccess = (data) => typeof data?.responseCode !== "undefined" ? Number(data.responseCode) === 0 : true;

    // Try a request, parse text safely
    async function tryFetch(url, headers, body) {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { ok: resp.ok, status: resp.status, data: json };
    }

    // Normalize v1/shipmentDetail response → your frontend shape
    function normalizeV1(orderNumber, payload) {
      const order = Array.isArray(payload?.orders) && payload.orders.length ? payload.orders[0] : null;
      const ship  = order && Array.isArray(order.shipDetail) && order.shipDetail.length ? order.shipDetail[0] : null;

      const events = [];
      if (ship) {
        if (ship.allocation_date) events.push({ date: ship.allocation_date, status: "Allocated" });
        if (ship.pick_date)      events.push({ date: ship.pick_date,      status: "Picked" });
        if (ship.pack_date)      events.push({ date: ship.pack_date,      status: "Packed" });
        if (ship.shipdate)       events.push({ date: ship.shipdate,       status: "Shipped" });
        if (ship.delivereddate)  events.push({ date: ship.delivereddate,  status: "Delivered" });
        events.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
      }

      const items = (ship?.items || []).map((it)=>({
        sku: it.sku || it.itemCode || null,
        name: it.itemName || null,
        qty:  it.order_qty || it.deliveryQty || it.shippedQty || null,
        price: it.price || null,
        imageUrl: it.imageUrl || null
      }));

      return {
        mode: "v1",
        orderNumber,
        status: order?.status || ship?.status || payload?.responseMessage || "Unknown",
        courier: ship?.transporter || ship?.obExtTransporterName || null,
        trackingNumber: ship?.tracking_number || null,
        trackingUrl: ship?.tracking_url || null,
        eta: ship?.expdeldate_max || ship?.expdeldate_min || null,
        events,
        items,
        _raw: payload
      };
    }

    // Normalize v4/status response (your sample structure)
    function normalizeV4(orderNumber, payload) {
      const line = Array.isArray(payload?.response) && payload.response.length ? payload.response[0] : null;
      return {
        mode: "v4",
        orderNumber: line?.order_no || orderNumber,
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
    }

    const attempts = [];
    // 1) Try v1/shipmentDetail with header variants
    for (const makeHeaders of headerVariants) {
      const headers = makeHeaders(apiKey, apiOwner, clientCode);
      const v1Body  = { orderNo: orderNumber };
      const r = await tryFetch(V1_URL, headers, v1Body);
      attempts.push({ endpoint: "v1/shipmentDetail", headers: Object.keys(headers), status: r.status, responseCode: r.data?.responseCode });
      if (r.ok && isSuccess(r.data)) {
        return res.status(200).json(normalizeV1(orderNumber, r.data));
      }
      // If explicit invalid creds code, continue to next variant
      if (Number(r.data?.responseCode) !== 11) {
        // If it failed for another reason (e.g., order not found), break and return
        if (r.ok) return res.status(404).json({ error: r.data?.responseMessage || "Order not found", details: r.data });
      }
    }

    // 2) Fallback: try v4/status (some tenants enable this instead)
    for (const makeHeaders of headerVariants) {
      const headers = makeHeaders(apiKey, apiOwner, clientCode);
      // Minimal v4 body using your order number; date range kept wide/empty if not required for single order lookup
      const v4Body = {
        order_no: [ orderNumber ],
        date_from: "",
        date_to: "",
        order_location: "",
        pageNumber: "",
        filterBy: 1
      };
      const r = await tryFetch(V4_URL, headers, v4Body);
      attempts.push({ endpoint: "v4/status", headers: Object.keys(headers), status: r.status, responseCode: r.data?.responseCode });
      if (r.ok && isSuccess(r.data)) {
        return res.status(200).json(normalizeV4(orderNumber, r.data));
      }
      if (Number(r.data?.responseCode) !== 11) {
        if (r.ok) return res.status(404).json({ error: r.data?.responseMessage || "Order not found", details: r.data });
      }
    }

    // Nothing worked: return compact debug to share with Viniculum support
    return res.status(401).json({
      error: "Invalid API credentials (all header patterns failed)",
      hint: "Ask Vin-eRetail to confirm which headers and endpoint version are enabled for your key.",
      tried: attempts
    });

  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
