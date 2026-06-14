// 프로덕션(단일 서비스): NEXT_PUBLIC_API_BASE="" 로 빌드 → 같은 출처(/api/*) 호출
// 개발: 미설정 시 로컬 백엔드(:8000) 사용
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export interface Reason {
  factor: string;
  contribution: number;
  detail: string;
}

export interface Weather {
  days_since_rain: number;
  temp: number;
  humidity: number;
}

export interface DistrictRisk {
  gu: string;
  score: number;
  level: "위험" | "경고" | "주의" | "안전";
  rank: number;
  weather: Weather;
  components: { past: number; weather: number; env: number; season_weight: number };
  reasons: Reason[];
}

export interface RiskResponse {
  date: string;
  mode: string;
  weather_source: string;
  weather_note: string | null;
  complaints_source: string;
  env_source: string;
  params: { days_since_rain: number; temp: number; humidity: number };
  results: DistrictRisk[];
}

export function levelColor(level: string): string {
  switch (level) {
    case "위험":
      return "#d73027";
    case "경고":
      return "#fc8d59";
    case "주의":
      return "#fee08b";
    default:
      return "#1a9850";
  }
}

export function scoreColor(score: number): string {
  if (score >= 75) return "#d73027";
  if (score >= 55) return "#fc8d59";
  if (score >= 35) return "#fee08b";
  return "#1a9850";
}
