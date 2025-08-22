// pages/api/track.js
// Accepts:
//   POST JSON: { "orderNumber": "2025437433" }
//   GET query: ?orderNumber=2025437433
//
// Tenant: pokonut.vineretail.com
// Endpoint: /RestWS/api/eretail/v1/order/statusUpdate
//
// Vercel env vars required (Project → Settings → Environment Variables):
//   VINICULUM_API_KEY   = <your key>
//   VINICULUM_API_OWNER = Suraj
//   VINICULUM_ORG_ID    = POKO

const BASE = "https://pokonut.vineretail.com/RestWS/api/eretail";
const STATUS_UPDATE_URL = `${BASE}/v1/order/statusUpdate`;

export default async function handler(req, res) {
  try {
    if (!["POST", "GET"].includes(req.method)) {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Use POST or GET." });
    }

    const body = req.method === "POST" ? (req.body || {}) : {};
    const q = req.query || {};
    const orderNumber =
      (typeof body.orderNumber === "string" && body.orderNumber.trim()) ||
      (typeof q.orderNumber === "string" && q.orderNumber.trim()) ||
      "";

    if (!orderNumber) {
      return res.status(400).json({
        error: "Missing 'orderNumber' (string).",
        hint: "Send { orderNumber: '2025437433' } in POST JSON or use ?orderNumber=2025437433"
      });
    }

    const apiKey = process.env.VINICULUM_API_KEY;
    const apiOwner = process.env.VINICULUM_API_OWNER || "Suraj";
    const orgId = process.env.VINICULUM_ORG_ID || "POKO";

    if (!apiKey || !apiOwner || !orgId) {
      return res.status(500).json({
        error:
          "Server not configured. Missing one of VINICULUM_API_KEY / VINICULUM_API_OWNER / VINICULUM_ORG_ID."
      });
    }

    const headers = {
      accept: "application/json",
      "Content-Type": "application/json",
      ApiKey: apiKey,
      ApiOwner: apiOwner,
      OrgId: orgId
    };

    const call = async (payload, label) => {
      const r = await fetch(STATUS_UPDATE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      return { ok: r.ok, http: r.status, json, sent: payload, label };
    };

    const isVinSuccess = d =>
      typeof d?.responseCode === "number" ? d.responseCode === 0 : true;

    // Try most common payload shapes for v1/statusUpdate
    const payloads = [
      { label: "request[order_no]", body: { request: [{ order_no: orderNumber }] } },
      { label: "order_no[]", body: { order_no: [orderNumber] } },
      { label: "orderNo", body: { orderNo: orderNumber } }
    ];

    const attempts = [];
    for (const p of payloads) {
      const resp = await call(p.body, p.label);
      attempts.push({
        shapeTried: p.label,
        http: resp.http,
        responseCode: resp.json?.responseCode,
        responseMessage: resp.json?.responseMessage
      });

      if (resp.ok && isVinSuccess(resp.json)) {
        // Normalize your provided shape:
        // {
        //   "responseCode": 0, "responseMessage": "Success",
        //   "responselist": [
        //     { "order_location":"CHE", "order_no":"CHE14401",
        //       "status":"Success", "remarks":"Order status updated successfully", "hold_status":"Unhold" }
        //   ]
        // }
        const line =
          Array.isArray(resp.json?.responselist) && resp.json.responselist.length
            ? resp.json.responselist[0]
            : null;

        // If tenant returned `response[]` (alternate), support that too
        const altLine =
          Array.isArray(resp.json?.response) && resp.json.response.length
            ? resp.json.response[0]
            : null;

        const pick = line || altLine || {};
        const normalized = {
          mode: "v1/statusUpdate",
          orderNumber: pick.order_no || pick.orderNo || orderNumber,
          orderLocation: pick.order_location || null,
          status: pick.status || pick.orderStatus || resp.json?.responseMessage || "Unknown",
          remarks:
            pick.remarks ||
            pick.responseMessage ||
            (pick.status ? `Status: ${pick.status}` : null),
          holdStatus: pick.hold_status || null,
          // Single timeline entry (statusUpdate is a “summary” endpoint)
          events: [
            {
              status:
                pick.status || pick.orderStatus || resp.json?.responseMessage || "Status received",
              date: null
            }
          ],
          _raw: resp.json // keep raw while validating
        };

        return res.status(200).json(normalized);
      }
    }

    // None of the shapes succeeded
    return res.status(400).json({
      error: "Upstream rejected or payload shape not accepted for this tenant.",
      orderNumber,
      endpoint: STATUS_UPDATE_URL,
      tried: attempts
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
