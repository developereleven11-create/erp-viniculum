
# Viniculum Order Tracking (Next.js + Vercel)

This project creates a public tracking page where customers enter their **Order Number**.
The backend calls Viniculum's **shipmentDetail** endpoint securely using your API Key.

## 1) What you must set on Vercel
Project Settings → Environment Variables:
- `VINICULUM_API_KEY` = **your key** (e.g., 62f9...8038 from CSV)

## 2) Deploy steps (no coding)
1. Create a GitHub repo (e.g., `viniculum-tracker-nextjs`).
2. Upload **all files in this folder** to that repo.
3. On Vercel → New Project → Import your GitHub repo → Deploy.
4. In Vercel Project Settings → Environment Variables, add the key above and redeploy.

## 3) Test
Open your deployed URL. Enter a real order number (e.g., `4105939108DC`).

## 4) Add to Shopify
Create a Page "Track Order" and embed:
```
<iframe src="https://YOUR-VERCEL-APP.vercel.app" style="width:100%;min-height:700px;border:0;"></iframe>
```
Replace `YOUR-VERCEL-APP` with your actual Vercel URL.

---

### Endpoint used
POST https://erp.vineretail.com/RestWS/api/eretail/v1/order/shipmentDetail
Headers: `Content-Type: application/json`, `ApiKey: <from env>`
Body: `{ "orderNo": "<customer order number>" }`

### Note
- We **do not** expose the API key on the frontend; it lives on the server (Vercel) only.
- If Viniculum changes required headers, update `/pages/api/track.js` accordingly.
