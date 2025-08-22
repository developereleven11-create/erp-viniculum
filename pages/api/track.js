// pages/api/track.js
// Accepts:
//  - POST JSON: { "orderNumber": "NWB110755" }  ← preferred
//  - GET  query: ?orderNumber=NWB110755
//
// Vercel Env Vars (Project → Settings → Environment Variables):
//  VINICULUM_API_KEY      = <your key>         (required)
//  VINICULUM_API_OWNER    = Suraj              (required)
//  VINICULUM_ORG_ID       = <optional>         (only if your tenant requires it)
//  VINICULUM_CLIENT_CODE  = <optional>         (only if your tenant requires it)

const URL = "https://pokonut.vineretail.com/RestWS/api/eretail/v1/order/statusUpdate";

export default async function handler(req, res) {
  try {
    if (!["POST", "GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    // read input from POST body or GET query
    const body = req.method === "POST" ? (req.body || {}) : {};
    const q    = req.query || {};
    const orderNumber =
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!orderNumber) {
      return res.status(400).json({
        error: "Missing 'orderNumber' (string).",
        hint: "Send { orderNumber: 'NWB110755' } in POST JSON, or use ?orderNumber=NWB110755"
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

    // Helper to call and parse JSON safely
    const call = async (payload) => {
      const r = await fetch(URL, { method: "POST", headers, body: JSON.stringify(payload) });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok, status: r.status, json: j, sent: payload };
    };

    // Try the common payload shapes for statusUpdate (based on various tenant specs)
    const payloads = [
      { kind: "orderNo",    body: { orderNo: orderNumber } },
      { kind: "order_no[]", body: { order_no: [orderNumber] } },
      { kind: "request[]",  body: { request: [ { orderNo: orderNumber } ] } }
    ];

    const attempts = [];
    let success = null;

    for (const p of payloads) {
      const resp = await call(p.body);
      attempts.push({
        kind: p.kind,
        http: resp.status,
        responseCode: resp.json?.responseCode,
        responseMessage: resp.json?.responseMessage
      });
      // Viniculum success: top-level responseCode === 0
      if (resp.ok && Number(resp.json?.responseCode) === 0) {
        success = resp.json;
        break;
      }
    }

    if (!success) {
      return res.status(400).json({
        error: "Upstream rejected or no matching payload shape succeeded.",
        tried: attempts,
        endpoint: URL
      });
    }

    // ---- Normalize your provided sample shape ----
    // Sample:
    // {
    //   "responseCode": 0,
    //   "responseMessage": "Success",
    //   "response": [
    //     { "responseCode": 0, "responseMessage": "SUCCESS", "orderNo": "NWB110755", "invoiceNo": "", "orderStatus": "" }
    //   ]
    // }
    const line = Array.isArray(success?.response) && success.response.length ? success.response[0] : null;

    const normalized = {
      mode: "v1/statusUpdate",
      orderNumber: line?.orderNo || orderNumber,
      invoiceNo: line?.invoiceNo || null,
      status: line?.orderStatus || success?.responseMessage || "Unknown",
      events: []
    };

    // Build a minimal timeline: if orderStatus is present, add it as the latest event
    if (line?.orderStatus) {
      normalized.events.push({ status: line.orderStatus, date: null });
    } else {
      // Friendly fallback so UI never looks empty
      normalized.events.push({
        status: success?.responseMessage || "Status received",
        date: null,
        remarks: "Detailed courier scans may appear on shipment detail endpoints."
      });
    }

    // include raw for debugging while you test
    normalized._raw = success;

    return res.status(200).json(normalized);

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
