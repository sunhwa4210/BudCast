"""실시간/예보 날씨 연동 (Open-Meteo, API 키 불필요).

- 자치구 중심좌표(GeoJSON에서 계산)별로 실제 기온·습도·강수 데이터를 받아온다.
- "강수 후 경과일"은 과거 시간별 강수량에서 자동 계산한다.
- 과거 7일 + 예보 16일 범위를 지원한다(그 밖의 날짜는 시뮬레이터 모드 권장).
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # certifi 미설치 시 기본 컨텍스트
    _SSL_CTX = ssl.create_default_context()

GEOJSON_PATH = Path(__file__).resolve().parents[2] / "frontend" / "public" / "seoul.geojson"

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
RAIN_THRESHOLD_MM = 0.5   # 이 이상이면 "비 옴"으로 간주
CACHE_TTL = 600           # 10분 캐시
_CACHE: dict[str, tuple[float, dict]] = {}


def _iter_coords(geom: dict):
    t = geom["type"]
    coords = geom["coordinates"]
    if t == "Polygon":
        for ring in coords:
            yield from ring
    elif t == "MultiPolygon":
        for poly in coords:
            for ring in poly:
                yield from ring


def _centroids() -> dict[str, tuple[float, float]]:
    with open(GEOJSON_PATH, encoding="utf-8") as f:
        gj = json.load(f)
    out: dict[str, tuple[float, float]] = {}
    for feat in gj["features"]:
        name = feat["properties"]["name"]
        pts = list(_iter_coords(feat["geometry"]))
        if not pts:
            continue
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        out[name] = (round(lat, 4), round(lon, 4))
    return out


_CENTROIDS = _centroids()
GU_ORDER = list(_CENTROIDS.keys())


def _fetch_raw() -> list[dict]:
    """Open-Meteo 벌크 호출: 25개 좌표 시간별 데이터를 한 번에."""
    lats = ",".join(str(_CENTROIDS[g][0]) for g in GU_ORDER)
    lons = ",".join(str(_CENTROIDS[g][1]) for g in GU_ORDER)
    url = (
        f"{OPEN_METEO}?latitude={lats}&longitude={lons}"
        "&hourly=temperature_2m,relative_humidity_2m,precipitation"
        "&past_days=7&forecast_days=16&timezone=Asia%2FSeoul"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "bugcast/0.1"})
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    # 좌표가 여러 개면 list, 하나면 dict 로 오므로 normalize
    if isinstance(data, dict):
        data = [data]
    return data


def _get_cached() -> list[dict]:
    now = time.time()
    if "raw" in _CACHE and now - _CACHE["raw"][0] < CACHE_TTL:
        return _CACHE["raw"][1]
    raw = _fetch_raw()
    _CACHE["raw"] = (now, raw)
    return raw


def _aggregate(hourly: dict, target: date) -> dict | None:
    """대상 날짜의 낮시간(11~18시) 평균 기온·습도 + 강수 후 경과일."""
    times = hourly["time"]
    temps = hourly["temperature_2m"]
    hums = hourly["relative_humidity_2m"]
    precs = hourly["precipitation"]

    day_temps, day_hums = [], []
    last_rain_dt: datetime | None = None
    ref = datetime.combine(target, datetime.min.time()).replace(hour=12)

    for i, ts in enumerate(times):
        dt = datetime.fromisoformat(ts)
        if precs[i] is not None and precs[i] >= RAIN_THRESHOLD_MM and dt <= ref:
            if last_rain_dt is None or dt > last_rain_dt:
                last_rain_dt = dt
        if dt.date() == target and 11 <= dt.hour <= 18:
            if temps[i] is not None:
                day_temps.append(temps[i])
            if hums[i] is not None:
                day_hums.append(hums[i])

    if not day_temps:
        return None  # 대상 날짜가 가용 범위 밖

    if last_rain_dt is None:
        days_since_rain = 14
    else:
        days_since_rain = max(0, int((ref - last_rain_dt).total_seconds() // 86400))
        days_since_rain = min(days_since_rain, 14)

    return {
        "temp": round(sum(day_temps) / len(day_temps), 1),
        "humidity": round(sum(day_hums) / len(day_hums)),
        "days_since_rain": days_since_rain,
    }


def get_weather_by_gu(target: date) -> dict[str, dict]:
    """자치구명 -> {temp, humidity, days_since_rain} (실데이터)."""
    raw = _get_cached()
    out: dict[str, dict] = {}
    for idx, gu in enumerate(GU_ORDER):
        if idx >= len(raw):
            break
        agg = _aggregate(raw[idx]["hourly"], target)
        if agg is not None:
            out[gu] = agg
    return out
