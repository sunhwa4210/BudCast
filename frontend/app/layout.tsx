import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BugCast — 서울 러브버그 위험도 예측",
  description: "서울시 자치구별 러브버그 출몰·민원 위험도 예측 및 지도 시각화",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
