"""러브버그 위험도 스코어링 (1단계 규칙 기반).

설계 문서(DESIGN.md §5.1) 반영:
  위험도 = 시즌가중치 × (0.45·과거민원 + 0.35·날씨 + 0.20·환경)
  - 과거민원: 인구 보정(1만명당) + log 정규화
  - 날씨: 단순 강수량이 아닌 "강수 후 경과일 + 기온 + 습도" 조합
  - 환경: 녹지/공원 중복(다중공선성) 정리 + 하천 인접
  - 시즌: 6월 말~7월 초 피크 가우시안 가중
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "static" / "districts.json"

# 앙상블 가중치
W_PAST = 0.45
W_WEATHER = 0.35
W_ENV = 0.20

# 시즌 피크: 7월 2일(연중 183일) 중심, 표준편차 약 14일
SEASON_PEAK_DOY = 183
SEASON_SIGMA = 14.0
SEASON_FLOOR = 0.05


def _load_districts() -> dict:
    with open(DATA_PATH, encoding="utf-8") as f:
        return json.load(f)["districts"]


_DISTRICTS = _load_districts()


def _load_counts() -> tuple[dict[str, int], str]:
    """과거 민원 건수 출처: 실데이터(ACRC) 우선, 없으면 추정치."""
    try:
        from .complaints import get_past_complaints
        real = get_past_complaints()
    except Exception:
        real = None
    if real:
        # 실데이터에 없는 구는 0으로 채움
        counts = {gu: int(real.get(gu, 0)) for gu in _DISTRICTS}
        return counts, "acrc-realdata"
    return {gu: d["past_complaints"] for gu, d in _DISTRICTS.items()}, "estimate"


_COUNTS, COUNTS_SOURCE = _load_counts()


def _minmax(values: dict[str, float]) -> dict[str, float]:
    lo, hi = min(values.values()), max(values.values())
    span = hi - lo
    if span == 0:
        return {k: 50.0 for k in values}
    return {k: (v - lo) / span * 100.0 for k, v in values.items()}


# --- 과거 민원 점수: 인구 1만명당 + log 정규화 (모듈 로드시 1회 계산) ---
def _compute_past_scores() -> dict[str, float]:
    per_capita = {
        gu: _COUNTS[gu] / d["population"] * 10000.0
        for gu, d in _DISTRICTS.items()
    }
    logged = {gu: math.log1p(v) for gu, v in per_capita.items()}
    return _minmax(logged)


def _load_park() -> tuple[dict[str, float] | None, str]:
    """공원·녹지 출처: 서울 열린데이터광장 실데이터 우선, 없으면 추정치."""
    try:
        from .parks import get_park_values
        v = get_park_values()
    except Exception:
        v = None
    if v:
        return v, "seoul-opendata"
    return None, "estimate"


_PARK_REAL, ENV_SOURCE = _load_park()


# --- 환경 점수: 녹지/공원 중복 정리 후 하천과 결합 ---
def _compute_env_scores() -> dict[str, float]:
    if _PARK_REAL:
        # 실데이터(공원율 또는 1인당 공원면적). 누락 구는 최소값으로.
        present = {gu: float(_PARK_REAL[gu]) for gu in _DISTRICTS if gu in _PARK_REAL}
        lo = min(present.values()) if present else 0.0
        raw = {gu: present.get(gu, lo) for gu in _DISTRICTS}
        veg = _minmax(raw)
    else:
        green = _minmax({gu: d["green_ratio"] for gu, d in _DISTRICTS.items()})
        park = {gu: float(d["park_area_rank"]) for gu, d in _DISTRICTS.items()}
        # 녹지·공원은 상관(다중공선성) → 식생(vegetation) 하나로 합산
        veg = {gu: 0.7 * green[gu] + 0.3 * park[gu] for gu in _DISTRICTS}
    river = {gu: d["river_adjacent"] * 100.0 for gu, d in _DISTRICTS.items()}
    return {gu: 0.78 * veg[gu] + 0.22 * river[gu] for gu in _DISTRICTS}


_PAST_SCORES = _compute_past_scores()
_ENV_SCORES = _compute_env_scores()


def season_weight(d: date) -> float:
    doy = d.timetuple().tm_yday
    w = math.exp(-((doy - SEASON_PEAK_DOY) ** 2) / (2 * SEASON_SIGMA ** 2))
    return max(SEASON_FLOOR, w)


def _rain_factor(days_since_rain: int) -> float:
    """비 오는 날은 활동 감소, 비 온 뒤 1~3일에 급증."""
    table = {0: 0.30, 1: 1.00, 2: 0.92, 3: 0.75, 4: 0.55, 5: 0.40}
    if days_since_rain in table:
        return table[days_since_rain]
    return 0.30  # 6일 이상 경과 → 건조, 활동 저조


def _temp_factor(temp_c: float) -> float:
    """25~30℃ 부근 최적(27℃ 피크)."""
    return max(0.0, 1.0 - abs(temp_c - 27.0) / 15.0)


def _humidity_factor(humidity: float) -> float:
    """습도 40%(0) ~ 85%(1) 선형, 다습 선호."""
    return min(1.0, max(0.0, (humidity - 40.0) / 45.0))


def weather_score(days_since_rain: int, temp_c: float, humidity: float) -> tuple[float, dict]:
    rf = _rain_factor(days_since_rain)
    tf = _temp_factor(temp_c)
    hf = _humidity_factor(humidity)
    score = 100.0 * (0.45 * rf + 0.30 * tf + 0.25 * hf)
    return score, {"rain": rf, "temp": tf, "humidity": hf}


def _level(score: float) -> str:
    if score >= 75:
        return "위험"
    if score >= 55:
        return "경고"
    if score >= 35:
        return "주의"
    return "안전"


def _build_reasons(gu: str, past: float, weather: float, env: float,
                   sw: float, wparts: dict, days_since_rain: int,
                   temp_c: float, humidity: float) -> list[dict]:
    base = W_PAST * past + W_WEATHER * weather + W_ENV * env
    base = base or 1.0
    d = _DISTRICTS[gu]
    cnt = _COUNTS[gu]
    per_capita = cnt / d["population"] * 10000.0
    src = "실데이터" if COUNTS_SOURCE == "acrc-realdata" else "추정"

    reasons = [
        {
            "factor": "과거 민원 다발 지역",
            "contribution": round(W_PAST * past / base, 3),
            "detail": f"러브버그 민원 {cnt}건({src}) · 인구1만명당 {per_capita:.2f}건",
        },
        {
            "factor": "날씨 조건",
            "contribution": round(W_WEATHER * weather / base, 3),
            "detail": f"강수 후 {days_since_rain}일 · 기온 {temp_c:.0f}℃ · 습도 {humidity:.0f}%",
        },
        {
            "factor": "지역 환경(녹지/하천)",
            "contribution": round(W_ENV * env / base, 3),
            "detail": f"녹지비율 {d['green_ratio']}% · 하천인접 {d['river_adjacent']:.0%}",
        },
    ]
    reasons.sort(key=lambda r: r["contribution"], reverse=True)
    if sw < 0.4:
        reasons.append({"factor": "출몰 시즌 외", "contribution": 0.0,
                        "detail": f"시즌 가중치 {sw:.0%} (성수기는 6월말~7월초)"})
    elif sw > 0.8:
        reasons.append({"factor": "출몰 성수기", "contribution": 0.0,
                        "detail": f"시즌 가중치 {sw:.0%}"})
    return reasons


def compute_risk(target_date: date, days_since_rain: int,
                 temp_c: float, humidity: float,
                 weather_by_gu: dict[str, dict] | None = None) -> list[dict]:
    """위험도 계산.

    weather_by_gu 가 주어지면(실시간 모드) 자치구별 실제 날씨를 사용하고,
    없으면 단일 (days_since_rain, temp_c, humidity) 값을 모든 구에 적용한다(시뮬레이터).
    """
    sw = season_weight(target_date)

    results = []
    for gu in _DISTRICTS:
        if weather_by_gu and gu in weather_by_gu:
            w = weather_by_gu[gu]
            dsr, t, h = w["days_since_rain"], w["temp"], w["humidity"]
        else:
            dsr, t, h = days_since_rain, temp_c, humidity

        wscore, wparts = weather_score(dsr, t, h)
        past = _PAST_SCORES[gu]
        env = _ENV_SCORES[gu]
        base = W_PAST * past + W_WEATHER * wscore + W_ENV * env
        score = sw * base
        results.append({
            "gu": gu,
            "score": round(score, 1),
            "level": _level(score),
            "weather": {"days_since_rain": dsr, "temp": t, "humidity": h},
            "components": {
                "past": round(past, 1),
                "weather": round(wscore, 1),
                "env": round(env, 1),
                "season_weight": round(sw, 3),
            },
            "reasons": _build_reasons(gu, past, wscore, env, sw, wparts,
                                      dsr, t, h),
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    for i, r in enumerate(results, 1):
        r["rank"] = i
    return results
