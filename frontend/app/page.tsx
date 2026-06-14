"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  API_BASE,
  DistrictRisk,
  RiskResponse,
  levelColor,
} from "./lib";

const MapView = dynamic(() => import("../components/MapView"), {
  ssr: false,
  loading: () => <div className="empty">지도를 불러오는 중…</div>,
});

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function Page() {
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [date, setDate] = useState(todayStr());
  const [daysSinceRain, setDaysSinceRain] = useState(2);
  const [temp, setTemp] = useState(29);
  const [humidity, setHumidity] = useState(82);

  const [data, setData] = useState<RiskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({
        mode,
        date,
        days_since_rain: String(daysSinceRain),
        temp: String(temp),
        humidity: String(humidity),
      });
      fetch(`${API_BASE}/api/risk?${qs}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d: RiskResponse) => setData(d))
        .catch((e) => {
          if (e.name !== "AbortError") setError("백엔드(API) 연결 실패 — 8000 포트 확인");
        })
        .finally(() => setLoading(false));
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [mode, date, daysSinceRain, temp, humidity]);

  const riskByGu = useMemo(() => {
    const m: Record<string, DistrictRisk> = {};
    data?.results.forEach((r) => (m[r.gu] = r));
    return m;
  }, [data]);

  const liveSummary = useMemo(() => {
    if (!data || !data.results.length) return null;
    const n = data.results.length;
    const avgT = data.results.reduce((s, r) => s + r.weather.temp, 0) / n;
    const avgH = data.results.reduce((s, r) => s + r.weather.humidity, 0) / n;
    const minD = Math.min(...data.results.map((r) => r.weather.days_since_rain));
    return { avgT, avgH, minD };
  }, [data]);

  const isLiveData = data?.weather_source === "open-meteo";
  const selectedRisk = selected ? riskByGu[selected] : null;

  return (
    <div className="app">
      {/* 좌측: 시뮬레이터 */}
      <aside className="sidebar">
        <div className="brand">
          Bug<span>Cast</span>
        </div>
        <div className="subtitle">
          서울 자치구별 러브버그 출몰·민원 위험도 예측
        </div>

        <div className="section">
          <div className="section-title">데이터 모드</div>
          <div className="toggle">
            <button
              className={mode === "live" ? "on" : ""}
              onClick={() => setMode("live")}
            >
              실시간 날씨
            </button>
            <button
              className={mode === "manual" ? "on" : ""}
              onClick={() => setMode("manual")}
            >
              시뮬레이터
            </button>
          </div>
          <div className="hint">
            {mode === "live"
              ? "Open-Meteo 실제 기상데이터(자치구별) 사용 · 키 불필요"
              : "날씨 값을 직접 조절해 가상 시나리오를 분석"}
          </div>
        </div>

        <div className="section">
          <div className="section-title">예측 날짜</div>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <div className="hint">
            출몰 성수기: 6월 말 ~ 7월 초 (시즌 가중치 적용)
            {mode === "live" && " · 실시간은 과거 7일~예보 16일 범위"}
          </div>
        </div>

        {mode === "live" ? (
          <div className="section">
            <div className="section-title">실시간 기상 (서울 평균)</div>
            {isLiveData && liveSummary ? (
              <div className="comp-grid">
                <div className="comp">
                  <div className="k">기온</div>
                  <div className="v">{liveSummary.avgT.toFixed(1)}℃</div>
                </div>
                <div className="comp">
                  <div className="k">습도</div>
                  <div className="v">{liveSummary.avgH.toFixed(0)}%</div>
                </div>
                <div className="comp">
                  <div className="k">강수후</div>
                  <div className="v">{liveSummary.minD}일</div>
                </div>
              </div>
            ) : (
              <div className="hint">{data?.weather_note || "실시간 데이터 불러오는 중…"}</div>
            )}
          </div>
        ) : (
          <div className="section">
            <div className="section-title">날씨 시뮬레이터</div>

            <div className="control">
              <div className="control-label">
                <span>강수 후 경과일</span>
                <b>{daysSinceRain}일</b>
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={daysSinceRain}
                onChange={(e) => setDaysSinceRain(Number(e.target.value))}
              />
              <div className="hint">
                비 오는 날(0일)은 활동↓, 비 온 뒤 1~3일에 급증
              </div>
            </div>

            <div className="control">
              <div className="control-label">
                <span>기온</span>
                <b>{temp}℃</b>
              </div>
              <input
                type="range"
                min={10}
                max={40}
                step={1}
                value={temp}
                onChange={(e) => setTemp(Number(e.target.value))}
              />
              <div className="hint">25~30℃ 부근에서 가장 활발 (27℃ 피크)</div>
            </div>

            <div className="control">
              <div className="control-label">
                <span>상대습도</span>
                <b>{humidity}%</b>
              </div>
              <input
                type="range"
                min={30}
                max={100}
                step={1}
                value={humidity}
                onChange={(e) => setHumidity(Number(e.target.value))}
              />
              <div className="hint">다습할수록 위험↑ (40%→0, 85%↑→최대)</div>
            </div>
          </div>
        )}

      </aside>

      {/* 중앙: 지도 */}
      <main className="map-wrap">
        {loading && <div className="loading">계산 중…</div>}
        <MapView riskByGu={riskByGu} selected={selected} onSelect={setSelected} />
        <div className="legend">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>위험 등급</div>
          {[
            ["위험", "75+"],
            ["경고", "55–74"],
            ["주의", "35–54"],
            ["안전", "0–34"],
          ].map(([lv, rng]) => (
            <div className="legend-row" key={lv}>
              <span className="swatch" style={{ background: levelColor(lv) }} />
              <span>
                {lv} <span style={{ color: "var(--muted)" }}>({rng})</span>
              </span>
            </div>
          ))}
        </div>
      </main>

      {/* 우측: 상세 + 랭킹 */}
      <aside className="sidebar right">
        {error && (
          <div className="detail-card" style={{ borderColor: "var(--danger)" }}>
            <b style={{ color: "var(--danger)" }}>⚠ {error}</b>
            <div className="hint" style={{ marginTop: 8 }}>
              backend 폴더에서 uvicorn 실행 여부를 확인하세요.
            </div>
          </div>
        )}

        {selectedRisk ? (
          <div className="detail-card">
            <div className="detail-head">
              <div className="detail-gu">{selectedRisk.gu}</div>
              <div
                className="detail-score"
                style={{ color: levelColor(selectedRisk.level) }}
              >
                {selectedRisk.score.toFixed(0)}
              </div>
            </div>
            <div style={{ marginTop: 4 }}>
              <span
                className="badge"
                style={{ background: levelColor(selectedRisk.level) }}
              >
                {selectedRisk.level}
              </span>
              <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: 8 }}>
                전체 {selectedRisk.rank}위
              </span>
            </div>

            <div className="hint" style={{ marginTop: 10 }}>
              {isLiveData ? "실측/예보" : "시뮬레이터"} 날씨 · 기온{" "}
              {selectedRisk.weather.temp}℃ · 습도 {selectedRisk.weather.humidity}% · 강수후{" "}
              {selectedRisk.weather.days_since_rain}일
            </div>

            <div className="comp-grid">
              <div className="comp">
                <div className="k">과거민원</div>
                <div className="v">{selectedRisk.components.past.toFixed(0)}</div>
              </div>
              <div className="comp">
                <div className="k">날씨</div>
                <div className="v">{selectedRisk.components.weather.toFixed(0)}</div>
              </div>
              <div className="comp">
                <div className="k">환경</div>
                <div className="v">{selectedRisk.components.env.toFixed(0)}</div>
              </div>
            </div>

            <div className="reason">
              <div className="section-title" style={{ marginTop: 16 }}>
                위험 이유
              </div>
              {selectedRisk.reasons.map((r, i) => (
                <div className="reason-row" key={i}>
                  <div className="reason-top">
                    <span>{r.factor}</span>
                    {r.contribution > 0 && (
                      <b style={{ color: "var(--accent)" }}>
                        {(r.contribution * 100).toFixed(0)}%
                      </b>
                    )}
                  </div>
                  <div className="reason-detail">{r.detail}</div>
                  {r.contribution > 0 && (
                    <div className="bar">
                      <span style={{ width: `${r.contribution * 100}%` }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="empty">
            지도에서 자치구를 클릭하면
            <br />
            위험도와 그 이유를 볼 수 있어요.
          </div>
        )}

        <div className="section-title">위험 순위</div>
        {data?.results.map((r) => (
          <div
            key={r.gu}
            className={`rank-item ${selected === r.gu ? "active" : ""}`}
            onClick={() => setSelected(r.gu)}
          >
            <span className="rank-num">{r.rank}</span>
            <span className="rank-name">{r.gu}</span>
            <span className="badge" style={{ background: levelColor(r.level) }}>
              {r.level}
            </span>
            <span className="rank-score">{r.score.toFixed(0)}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}
