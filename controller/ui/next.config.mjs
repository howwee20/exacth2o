/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/owner-health/:path*",
        destination: "http://health_svc:8767/:path*",
      },
    ];
  },
};

export default nextConfig;
