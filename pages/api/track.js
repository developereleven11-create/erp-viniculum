// pages/api/track.js
// Accepts:
//  - POST JSON: { "deliveryNo": "WH...", ... }  ← preferred
//  - POST JSON: { "orderNumber": "..." }        ← backward-compatible
//  - GET  query: ?deliveryNo=WH... or ?orderNumber=...
//
// Env vars in Vercel (Project → Settings → Environment Variables):
//  VINICULUM_API_KEY
//  VINICULUM_API_OWNER           (e.g., "Suraj")
//  VINICULUM_ORG_ID              (optional if your tenant requires it)
//  VINICULUM_CLIENT_CODE         (optional if your tenant requires it)

const URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/orderShip";

export default async function handler(req, res) {
  try {
    // Accept both POST and GET for convenience
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // Pull input from body or query; prefer deliveryNo if provided
    const body = (req.method === "POST" ? (req.body || {}) : {});
    const q = req.query || {};
    const deliveryNo =
      (typeof body.deliveryNo === "string" && body.deliveryNo.trim()) ||
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.deliveryNo === "string" && q.deliveryNo.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!deliveryNo) {
      return res.status(400).json({
        error: "Missing 'deliveryNo' (string).",
        hint: "Send { deliveryNo: 'WH2766812322' } in POST JSON, or ?deliveryNo=WH2766812322 as a query param."
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
      ...(clientCode ? { ClientCode: clientCode } : {})
    };

    // EXACT body shape Vin-eRetail expects for this endpoint:
    const payload = {
      request: [
        { deliveryNo }
      ]
    };

    const upstream = await fetch(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream HTTP error", details: data });
    }

    // Vin-eRetail usually uses responseCode===0 for success
    if (typeof data.responseCode !== "undefined" && Number(data.responseCode) !== 0) {
      return res.status(400).json({
        error: data?.responseMessage || "Vin-eRetail rejected the request",
        details: data
      });
    }

    // You can return raw or normalize. For now, return as-is plus echo.
    return res.status(200).json({
      deliveryNo,
      ...data
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
