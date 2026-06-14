// 브라우저에서 직접 위험도를 계산하는 엔진 (백엔드 scoring.py / weather.py 포팅).
// - 과거민원: ACRC 실데이터(번들), 공원: 서울 시정통계 실데이터(번들)
// - 날씨(live): Open-Meteo 브라우저 직접 호출(키 불필요, CORS 허용)
import { DistrictRisk, Reason, RiskResponse } from "./lib";
import districtsJson from "./_data/districts.json";
import complaintsJson from "./_data/complaints.json";
import parksJson from "./_data/parks.json";

interface DistrictRow {
  past_complaints: number;
  population: number;
  area_km2: number;
  green_ratio: number;
  park_area_rank: number;
  river_adjacent: number;
  region_weight: number;
}

const DISTRICTS = (districtsJson as any).districts as Record<string, DistrictRow>;
const GU_LIST = Object.keys(DISTRICTS);

// --- 데이터 출처 (실데이터 우선) ---
const RAW_COUNTS = (complaintsJson as any).counts as Record<string, number>;
const COUNTS: Record<string, number> = {};
for (const gu of GU_LIST) COUNTS[gu] = Math.round(RAW_COUNTS[gu] ?? 0);
export const COUNTS_SOURCE = "acrc-realdata";

const PARK_VALUES = (parksJson as any).values as Record<string, number>;
export const ENV_SOURCE = "seoul-opendata";

// 앙상블 가중치
const W_PAST = 0.45;
const W_WEATHER = 0.35;
const W_ENV = 0.2;

// 시즌 피크: 7월 2일(연중 183일) 중심
const SEASON_PEAK_DOY = 183;
const SEASON_SIGMA = 14.0;
const SEASON_FLOOR = 0.05;

const RAIN_THRESHOLD_MM = 0.5;

function minmax(values: Record<string, number>): Record<string, number> {
  const vals = Object.values(values);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo;
  const out: Record<string, number> = {};
  if (span === 0) {
    for (const k of Object.keys(values)) out[k] = 50.0;
    return out;
  }
  for (const k of Object.keys(values)) out[k] = ((values[k] - lo) / span) * 100.0;
  return out;
}

// 과거 민원 점수: 인구 1만명당 + log 정규화
function computePastScores(): Record<string, number> {
  const perCapita: Record<string, number> = {};
  for (const gu of GU_LIST) {
    perCapita[gu] = (COUNTS[gu] / DISTRICTS[gu].population) * 10000.0;
  }
  const logged: Record<string, number> = {};
  for (const gu of GU_LIST) logged[gu] = Math.log1p(perCapita[gu]);
  return minmax(logged);
}

// 환경 점수: 공원 실데이터 + 하천 인접
function computeEnvScores(): Record<string, number> {
  const present: Record<string, number> = {};
  for (const gu of GU_LIST) {
    if (gu in PARK_VALUES) present[gu] = Number(PARK_VALUES[gu]);
  }
  const presentVals = Object.values(present);
  const lo = presentVals.length ? Math.min(...presentVals) : 0.0;
  const raw: Record<string, number> = {};
  for (const gu of GU_LIST) raw[gu] = gu in present ? present[gu] : lo;
  const veg = minmax(raw);
  const out: Record<string, number> = {};
  for (const gu of GU_LIST) {
    const river = DISTRICTS[gu].river_adjacent * 100.0;
    out[gu] = 0.78 * veg[gu] + 0.22 * river;
  }
  return out;
}

const PAST_SCORES = computePastScores();
const ENV_SCORES = computeEnvScores();

function dayOfYear(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = Date.UTC(y, m - 1, d);
  const start = Date.UTC(y, 0, 0);
  return Math.floor((date - start) / 86400000);
}

function seasonWeight(dateStr: string): number {
  const doy = dayOfYear(dateStr);
  const w = Math.exp(-((doy - SEASON_PEAK_DOY) ** 2) / (2 * SEASON_SIGMA ** 2));
  return Math.max(SEASON_FLOOR, w);
}

function rainFactor(daysSinceRain: number): number {
  const table: Record<number, number> = { 0: 0.3, 1: 1.0, 2: 0.92, 3: 0.75, 4: 0.55, 5: 0.4 };
  if (daysSinceRain in table) return table[daysSinceRain];
  return 0.3;
}

function tempFactor(tempC: number): number {
  return Math.max(0.0, 1.0 - Math.abs(tempC - 27.0) / 15.0);
}

function humidityFactor(humidity: number): number {
  return Math.min(1.0, Math.max(0.0, (humidity - 40.0) / 45.0));
}

function weatherScore(daysSinceRain: number, tempC: number, humidity: number): number {
  const rf = rainFactor(daysSinceRain);
  const tf = tempFactor(tempC);
  const hf = humidityFactor(humidity);
  return 100.0 * (0.45 * rf + 0.3 * tf + 0.25 * hf);
}

function level(score: number): DistrictRisk["level"] {
  if (score >= 75) return "위험";
  if (score >= 55) return "경고";
  if (score >= 35) return "주의";
  return "안전";
}

function buildReasons(
  gu: string,
  past: number,
  weather: number,
  env: number,
  sw: number,
  daysSinceRain: number,
  tempC: number,
  humidity: number
): Reason[] {
  let base = W_PAST * past + W_WEATHER * weather + W_ENV * env;
  base = base || 1.0;
  const d = DISTRICTS[gu];
  const cnt = COUNTS[gu];
  const perCapita = (cnt / d.population) * 10000.0;

  const reasons: Reason[] = [
    {
      factor: "과거 민원 다발 지역",
      contribution: round3((W_PAST * past) / base),
      detail: `러브버그 민원 ${cnt}건(실데이터) · 인구1만명당 ${perCapita.toFixed(2)}건`,
    },
    {
      factor: "날씨 조건",
      contribution: round3((W_WEATHER * weather) / base),
      detail: `강수 후 ${daysSinceRain}일 · 기온 ${tempC.toFixed(0)}℃ · 습도 ${humidity.toFixed(0)}%`,
    },
    {
      factor: "지역 환경(녹지/하천)",
      contribution: round3((W_ENV * env) / base),
      detail: `녹지비율 ${d.green_ratio}% · 하천인접 ${(d.river_adjacent * 100).toFixed(0)}%`,
    },
  ];
  reasons.sort((a, b) => b.contribution - a.contribution);
  if (sw < 0.4) {
    reasons.push({
      factor: "출몰 시즌 외",
      contribution: 0.0,
      detail: `시즌 가중치 ${(sw * 100).toFixed(0)}% (성수기는 6월말~7월초)`,
    });
  } else if (sw > 0.8) {
    reasons.push({ factor: "출몰 성수기", contribution: 0.0, detail: `시즌 가중치 ${(sw * 100).toFixed(0)}%` });
  }
  return reasons;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function computeRisk(
  targetDate: string,
  daysSinceRain: number,
  tempC: number,
  humidity: number,
  weatherByGu?: Record<string, WeatherAgg> | null
): DistrictRisk[] {
  const sw = seasonWeight(targetDate);
  const results: DistrictRisk[] = [];

  for (const gu of GU_LIST) {
    let dsr = daysSinceRain;
    let t = tempC;
    let h = humidity;
    if (weatherByGu && weatherByGu[gu]) {
      dsr = weatherByGu[gu].days_since_rain;
      t = weatherByGu[gu].temp;
      h = weatherByGu[gu].humidity;
    }
    const wscore = weatherScore(dsr, t, h);
    const past = PAST_SCORES[gu];
    const env = ENV_SCORES[gu];
    const base = W_PAST * past + W_WEATHER * wscore + W_ENV * env;
    const score = sw * base;
    results.push({
      gu,
      score: round1(score),
      level: level(score),
      rank: 0,
      weather: { days_since_rain: dsr, temp: t, humidity: h },
      components: {
        past: round1(past),
        weather: round1(wscore),
        env: round1(env),
        season_weight: round3(sw),
      },
      reasons: buildReasons(gu, past, wscore, env, sw, dsr, t, h),
    });
  }

  results.sort((a, b) => b.score - a.score);
  results.forEach((r, i) => (r.rank = i + 1));
  return results;
}

// ---------------- 날씨 (Open-Meteo, 브라우저 직접 호출) ----------------
export interface WeatherAgg {
  temp: number;
  humidity: number;
  days_since_rain: number;
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL = 600_000;

let _centroidsPromise: Promise<{ order: string[]; lats: number[]; lons: number[] }> | null = null;
let _rawCache: { at: number; data: any[] } | null = null;

function iterCoords(geom: any): number[][] {
  const out: number[][] = [];
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) for (const p of ring) out.push(p);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) for (const ring of poly) for (const p of ring) out.push(p);
  }
  return out;
}

async function getCentroids() {
  if (!_centroidsPromise) {
    _centroidsPromise = fetch(`${BASE_PATH}/seoul.geojson`)
      .then((r) => r.json())
      .then((gj) => {
        const order: string[] = [];
        const lats: number[] = [];
        const lons: number[] = [];
        for (const feat of gj.features) {
          const name = feat.properties?.name as string;
          const pts = iterCoords(feat.geometry);
          if (!pts.length) continue;
          const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
          const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
          order.push(name);
          lats.push(Math.round(lat * 1e4) / 1e4);
          lons.push(Math.round(lon * 1e4) / 1e4);
        }
        return { order, lats, lons };
      });
  }
  return _centroidsPromise;
}

async function fetchRaw(): Promise<{ order: string[]; data: any[] }> {
  const { order, lats, lons } = await getCentroids();
  const now = Date.now();
  if (_rawCache && now - _rawCache.at < CACHE_TTL) {
    return { order, data: _rawCache.data };
  }
  const url =
    `${OPEN_METEO}?latitude=${lats.join(",")}&longitude=${lons.join(",")}` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation` +
    `&past_days=7&forecast_days=16&timezone=Asia%2FSeoul`;
  const resp = await fetch(url);
  let data = await resp.json();
  if (!Array.isArray(data)) data = [data];
  _rawCache = { at: now, data };
  return { order, data };
}

function aggregate(hourly: any, target: string): WeatherAgg | null {
  const times: string[] = hourly.time;
  const temps: (number | null)[] = hourly.temperature_2m;
  const hums: (number | null)[] = hourly.relative_humidity_2m;
  const precs: (number | null)[] = hourly.precipitation;

  const ref = `${target}T12:00`;
  const dayTemps: number[] = [];
  const dayHums: number[] = [];
  let lastRain: string | null = null;

  for (let i = 0; i < times.length; i++) {
    const ts = times[i];
    const datePart = ts.slice(0, 10);
    const hour = Number(ts.slice(11, 13));
    if (precs[i] != null && (precs[i] as number) >= RAIN_THRESHOLD_MM && ts <= ref) {
      if (lastRain === null || ts > lastRain) lastRain = ts;
    }
    if (datePart === target && hour >= 11 && hour <= 18) {
      if (temps[i] != null) dayTemps.push(temps[i] as number);
      if (hums[i] != null) dayHums.push(hums[i] as number);
    }
  }

  if (!dayTemps.length) return null;

  let daysSinceRain: number;
  if (lastRain === null) {
    daysSinceRain = 14;
  } else {
    const diff = (new Date(ref).getTime() - new Date(lastRain).getTime()) / 86400000;
    daysSinceRain = Math.min(14, Math.max(0, Math.floor(diff)));
  }

  return {
    temp: round1(dayTemps.reduce((s, v) => s + v, 0) / dayTemps.length),
    humidity: Math.round(dayHums.reduce((s, v) => s + v, 0) / dayHums.length),
    days_since_rain: daysSinceRain,
  };
}

async function getWeatherByGu(target: string): Promise<Record<string, WeatherAgg>> {
  const { order, data } = await fetchRaw();
  const out: Record<string, WeatherAgg> = {};
  for (let idx = 0; idx < order.length; idx++) {
    if (idx >= data.length) break;
    const agg = aggregate(data[idx].hourly, target);
    if (agg) out[order[idx]] = agg;
  }
  return out;
}

// ---------------- 공개 API ----------------
export interface RiskParams {
  mode: "live" | "manual";
  date: string;
  daysSinceRain: number;
  temp: number;
  humidity: number;
}

export async function getRisk(p: RiskParams): Promise<RiskResponse> {
  let weatherByGu: Record<string, WeatherAgg> | null = null;
  let weatherSource = "manual";
  let weatherNote: string | null = null;

  if (p.mode === "live") {
    try {
      weatherByGu = await getWeatherByGu(p.date);
      if (weatherByGu && Object.keys(weatherByGu).length) {
        weatherSource = "open-meteo";
      } else {
        weatherByGu = null;
        weatherSource = "manual";
        weatherNote = "해당 날짜가 실데이터 범위(과거 7일~예보 16일) 밖이라 기본값을 사용했습니다.";
      }
    } catch (e: any) {
      weatherByGu = null;
      weatherSource = "manual";
      weatherNote = `실시간 날씨 호출 실패로 기본값 사용: ${e?.message ?? e}`;
    }
  }

  const results = computeRisk(p.date, p.daysSinceRain, p.temp, p.humidity, weatherByGu);

  return {
    date: p.date,
    mode: p.mode,
    weather_source: weatherSource,
    weather_note: weatherNote,
    complaints_source: COUNTS_SOURCE,
    env_source: ENV_SOURCE,
    params: { days_since_rain: p.daysSinceRain, temp: p.temp, humidity: p.humidity },
    results,
  };
}
