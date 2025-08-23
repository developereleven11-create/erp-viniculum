module.exports = { reactStrictMode: true };
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Apply to all routes
        source: "/:path*",
        headers: [
          // Allow Shopify to frame this site (storefront + theme editor).
          // Add your custom domain too if you embed from there.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "connect-src 'self'",
              "frame-ancestors 'self' https://pokonut.myshopify.com https://admin.shopify.com https://www.pokonut.com https://pokonut.com"
            ].join("; ")
          },
          // Optional/harmless
          { key: "Referrer-Policy", value: "no-referrer-when-downgrade" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;

