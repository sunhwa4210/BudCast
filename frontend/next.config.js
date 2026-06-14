/** @type {import('next').NextConfig} */
// GitHub Pages 프로젝트 사이트는 https://<user>.github.io/<repo>/ 하위에서 서비스됨.
// 빌드시 BASE_PATH(예: /BudCast)를 주면 모든 정적경로가 그 하위로 맞춰진다.
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  // 정적 사이트로 빌드(out/) → GitHub Pages 등 어디서나 서빙 가능
  output: "export",
  images: { unoptimized: true },
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

module.exports = nextConfig;
