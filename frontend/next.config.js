/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // FastAPI가 서빙할 정적 사이트로 빌드(out/)
  output: "export",
  images: { unoptimized: true },
};

module.exports = nextConfig;
