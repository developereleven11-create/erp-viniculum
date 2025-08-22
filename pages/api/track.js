// pages/api/track.js
// POST body (from your frontend): { "deliveryNo": "WH2766812322" }

const URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/orderShip";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  try {
    const { deliveryNo } = req.body || {};
    if (!deliveryNo || typeof deliveryNo !== "string") {
      return res.status(400).json({ error: "Missing 'deliveryNo' (string)" });
    }

    const apiKey     = process.env.VINICULUM_API_KEY;
    const apiOwner   = process.env.VINICULUM_API_OWNER;
    const orgId      = process.env.VINICULUM_ORG_ID;
    const clientCode = process.env.VINICULUM_CLIENT_CODE;

    if (!apiKey || !apiOwner) {
      return res.status(500).json({ error: "Missing VINICULUM_API_KEY or VINICULUM_API_OWNER" });
    }

    const headers = {
      "accept": "application/json",
      "Content-Type": "application/json",
      "ApiKey": apiKey,
      "ApiOwner": apiOwner,
      ...(orgId ? { "OrgId": orgId } : {}),
      ...(clientCode ? { "ClientCode": clientCode } : {})
    };

    const body = {
      request: [
        {
          deliveryNo
        }
      ]
    };

    const upstream = await fetch(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const raw = await upstream.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream HTTP error", details: json });
    }

    if (typeof json.responseCode !== "undefined" && Number(json.responseCode) !== 0) {
      return res.status(400).json({
        error: json?.responseMessage || "Rejected by Viniculum",
        details: json
      });
    }

    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
