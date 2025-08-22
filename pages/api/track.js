// pages/api/track.js
// POST body: { "orderNumber": "4105939108DC" }
//
// Vercel → Project → Settings → Environment Variables (add these):
//   VINICULUM_API_KEY     = <your key>       (required)
//   VINICULUM_API_OWNER   = Suraj            (required)
//   VINICULUM_ORG_ID      = <your OrgId>     (required per your tenant)
//   VINICULUM_CLIENT_CODE = <optional>       (some tenants need this)
//
// What this file does:
// - Tries multiple header casings/variants (ApiKey/APIKey/x-api-key/Authorization Bearer; ApiOwner/APIOwner; OrgId/OrgID/ORGID)
// - Tries v1/shipmentDetail first, then v4/status
// - Returns first success; otherwise returns a compact debug report of every attempt.

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

    const apiKey     = process.env.VINICULUM_API_KEY;
    const apiOwner   = process.env.VINICULUM_API_OWNER;
    const orgId      = process.env.VINICULUM_ORG_ID;
    const clientCode = process.env.VINICULUM_CLIENT_CODE || undefined;

    if (!apiKey || !apiOwner || !orgId) {
      return res.status(500).json({
        error: "Server not configured. Missing VINICULUM_API_KEY or VINICULUM_API_OWNER or VINICULUM_ORG_ID."
      });
    }

    // Build header variants
    const keyVariants   = [
      (k) => ({ "ApiKey": k }),
      (k) => ({ "APIKey": k }),
      (k) => ({ "x-api-key": k }),
      (k) => ({ "Authorization": `Bearer ${k}` }),
    ];
    const ownerVariants = [
      (o) => ({ "ApiOwner": o }),
      (o) => ({ "APIOwner": o }),
      (o) => ({ "apiowner": o }),
    ];
    const orgVariants   = [
      (g) => ({ "OrgId": g }),
      (g) => ({ "OrgID": g }),
      (g) => ({ "ORGID": g }),
      (g) => ({ "orgId": g }),
    ];

    // Combine all variants (cartesian)
    const headerCombos = [];
    for (const k of keyVariants) {
      for (const o of ownerVariants) {
        for (const g of orgVariants) {
          const base = { "Content-Type": "application/json", ...k(apiKey), ...o(apiOwner), ...g(orgId) };
          headerCombos.push(clientCode ? { ...base, "ClientCode": clientCode } : base);
        }
      }
    }

    const attempts = [];

    // Helpers
    const parse = async (resp) => {
      const text = await resp.text();
      try { return { text, json: JSON.parse(text) }; } catch { return { text, json: { raw: text } }; }
    };
    const okVin = (d) => typeof d?.responseCode === "undefined" ? true : Number(d.responseCode) === 0;

    const normalizeV1 = (payload) => {
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
    };

    const normalizeV4 = (payload) => {
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
    };

    // 1) Try V1 with all header combos
    for (const headers of headerCombos) {
      const resp = await fetch(V1_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ orderNo: orderNumber })
      });
      const { json } = await parse(resp);

      attempts.push({
        endpoint: "v1/shipmentDetail",
        status: resp.status,
        responseCode: json?.responseCode,
        headersTried: Object.keys(headers)
      });

      if (resp.ok && okVin(json)) {
        return res.status(200).json(normalizeV1(json));
      }
      // If not explicit invalid creds (11), but upstream okay, likely data issue → return
      if (resp.ok && Number(json?.responseCode) !== 11) {
        return res.status(400).json({ error: json?.responseMessage || "Viniculum rejected the request", details: json });
      }
    }

    // 2) Fallback to V4 (some tenants enable this instead)
    for (const headers of headerCombos) {
      const v4Body = {
        order_no: [ orderNumber ],
        date_from: "",
        date_to: "",
        order_location: "",
        pageNumber: "",
        filterBy: 1
      };

      const resp = await fetch(V4_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(v4Body)
      });
      const { json } = await parse(resp);

      attempts.push({
        endpoint: "v4/order/status",
        status: resp.status,
        responseCode: json?.responseCode,
        headersTried: Object.keys(headers)
      });

      if (resp.ok && okVin(json)) {
        return res.status(200).json(normalizeV4(json));
      }
      if (resp.ok && Number(json?.responseCode) !== 11) {
        return res.status(400).json({ error: json?.responseMessage || "Viniculum rejected the request", details: json });
      }
    }

    // All failed with credential errors
    return res.status(401).json({
      error: "Invalid API credentials (all variants tried).",
      hint: "Share 'tried' with Vin-eRetail to confirm exact header names and endpoint enablement.",
      tried: attempts
    });

  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
