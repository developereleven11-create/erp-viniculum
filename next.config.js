module.exports = { reactStrictMode: true };
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Let your Shopify storefront frame this app
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://pokonut.com",
          },
          // optional but fine to keep
          { key: "Referrer-Policy", value: "no-referrer-when-downgrade" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
