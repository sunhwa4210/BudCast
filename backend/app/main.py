"""러브버그 위험도 예측 API (FastAPI)."""
from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .scoring import compute_risk, COUNTS_SOURCE, ENV_SOURCE
from . import weather

app = FastAPI(title="BugCast API", description="서울 자치구 러브버그 위험도 예측", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/risk")
def risk(
    mode: str = Query(default="live", description="live(실시간 날씨) | manual(시뮬레이터)"),
    date_str: str | None = Query(default=None, alias="date", description="YYYY-MM-DD"),
    days_since_rain: int = Query(default=2, ge=0, le=14, description="(manual) 강수 후 경과일"),
    temp: float = Query(default=28.0, ge=-10, le=45, description="(manual) 기온(℃)"),
    humidity: float = Query(default=78.0, ge=0, le=100, description="(manual) 상대습도(%)"),
):
    """위험도 계산.

    - mode=live: Open-Meteo 실시간/예보 날씨를 자치구별로 사용(키 불필요).
    - mode=manual: 슬라이더 값(days_since_rain/temp/humidity)을 모든 구에 적용.
    """
    target = datetime.strptime(date_str, "%Y-%m-%d").date() if date_str else date.today()

    weather_by_gu = None
    weather_source = "manual"
    weather_note = None

    if mode == "live":
        try:
            weather_by_gu = weather.get_weather_by_gu(target)
            if weather_by_gu:
                weather_source = "open-meteo"
            else:
                weather_source = "manual"
                weather_note = "해당 날짜가 실데이터 범위(과거 7일~예보 16일) 밖이라 시뮬레이터 기본값을 사용했습니다."
        except Exception as e:  # 네트워크 실패 등 → manual 폴백
            weather_source = "manual"
            weather_note = f"실시간 날씨 호출 실패로 시뮬레이터 값 사용: {e}"

    results = compute_risk(target, days_since_rain, temp, humidity, weather_by_gu)

    return {
        "date": target.isoformat(),
        "mode": mode,
        "weather_source": weather_source,
        "weather_note": weather_note,
        "complaints_source": COUNTS_SOURCE,
        "env_source": ENV_SOURCE,
        "params": {"days_since_rain": days_since_rain, "temp": temp, "humidity": humidity},
        "results": results,
    }


# --- 프론트엔드 정적 파일 서빙(빌드된 Next export가 있을 때만) ---
# API 라우트(/api/*) 정의 이후에 마운트해야 우선순위가 보장된다.
_STATIC_DIR = Path(__file__).resolve().parents[2] / "frontend" / "out"
if _STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_STATIC_DIR), html=True), name="static")
