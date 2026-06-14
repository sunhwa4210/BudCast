"""러브버그 민원 실데이터 커넥터.

국민권익위원회 민원빅데이터 분석정보 API (data.go.kr, 1140100)
오퍼레이션: minAnalsInfoView7/minPttnStstAddrInfo
  - "키워드 검색으로 조회된 민원을 시군구 단위 민원 발생지별 건수 조회"
  - 응답: body.items[].item = {label: 민원발생지, hits: 건수}, 전국 TOP 10

특징/한계:
  - 전국 시군구 TOP 10만 반환 → 서울 커버리지를 높이려고 target=saeol(수집민원,
    응답소 포함)을 주로 쓰고, 여러 기간 창을 스캔해 서울 자치구를 모은다.
  - 결과를 data/processed/complaints.json 에 캐싱(개발계정 100건/일 쿼터 보호).
"""
from __future__ import annotations

import json
import ssl
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL = ssl.create_default_context()

ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = ROOT / "backend" / ".env"
OUT_PATH = ROOT / "data" / "processed" / "complaints.json"
DISTRICTS_PATH = ROOT / "data" / "static" / "districts.json"

BASE = "https://apis.data.go.kr/1140100/minAnalsInfoView7/minPttnStstAddrInfo"
SEARCHWORD = "러브버그"


def _service_key() -> str:
    import os
    if os.environ.get("ACRC_SERVICE_KEY"):
        return os.environ["ACRC_SERVICE_KEY"]
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("ACRC_SERVICE_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("ACRC_SERVICE_KEY 가 설정되지 않았습니다 (backend/.env).")


def _seoul_districts() -> set[str]:
    data = json.loads(DISTRICTS_PATH.read_text(encoding="utf-8"))
    return set(data["districts"].keys())


def fetch_addr_stats(target: str, date_from: str, date_to: str,
                     searchword: str = SEARCHWORD) -> dict[str, int]:
    """한 기간 창의 시군구별 민원 건수(전국 TOP10) → {label: hits}."""
    params = {
        "serviceKey": _service_key(),
        "target": target,
        "searchword": searchword,
        "dateFrom": date_from,
        "dateTo": date_to,
        "type": "json",
    }
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "bugcast/0.1"})
    with urllib.request.urlopen(req, timeout=20, context=_SSL) as resp:
        raw = resp.read().decode("utf-8").strip()
    if not raw:
        return {}
    data = json.loads(raw)
    items = (data.get("body") or {}).get("items") or []
    if isinstance(items, dict):  # 단건이면 dict
        items = [items]
    out: dict[str, int] = {}
    for it in items:
        node = it.get("item", it)
        label = node.get("label")
        hits = node.get("hits")
        if label is not None and hits is not None:
            out[label] = int(hits)
    return out


def _seoul_only(stats: dict[str, int], districts: set[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for label, hits in stats.items():
        if not label.startswith("서울"):
            continue
        gu = label.split()[-1]  # "서울특별시 양천구" → "양천구"
        if gu in districts:
            out[gu] = out.get(gu, hits)
    return out


def build_seoul_complaints(years: list[int] | None = None,
                           sleep: float = 0.3) -> dict:
    """여러 기간/타깃을 스캔해 서울 자치구별 러브버그 민원 건수를 집계."""
    years = years or [2024, 2025]
    districts = _seoul_districts()
    counts: dict[str, int] = {gu: 0 for gu in districts}
    windows_log: list[dict] = []

    def scan(target: str, y: int, df: str, dt: str, supplement_only: set[str] | None):
        try:
            stats = fetch_addr_stats(target, df, dt)
        except Exception as e:
            windows_log.append({"target": target, "from": df, "to": dt, "error": str(e)})
            return {}
        seoul = _seoul_only(stats, districts)
        windows_log.append({"target": target, "from": df, "to": dt,
                            "seoul": seoul, "total_regions": len(stats)})
        time.sleep(sleep)
        return seoul

    for y in years:
        # 1) 시즌 전체 saeol (가장 신뢰도 높은 메인 집계)
        season = scan("saeol", y, f"{y}0601", f"{y}0731", None)
        seen = set(season)
        for gu, h in season.items():
            counts[gu] += h
        # 2) 하위 기간 창 saeol → 시즌 전체에서 안 잡힌 구만 보강
        for df, dt in [(f"{y}0601", f"{y}0615"), (f"{y}0616", f"{y}0630"),
                       (f"{y}0701", f"{y}0715"), (f"{y}0716", f"{y}0731")]:
            sub = scan("saeol", y, df, dt, seen)
            for gu, h in sub.items():
                if gu not in seen:
                    counts[gu] += h
                    seen.add(gu)
        # 3) 일반민원(pttn) 시즌 전체 → 누락 구 추가 보강
        p = scan("pttn", y, f"{y}0601", f"{y}0731", seen)
        for gu, h in p.items():
            if gu not in seen:
                counts[gu] += h
                seen.add(gu)

    result = {
        "source": "ACRC minPttnStstAddrInfo (target=saeol/pttn, searchword=러브버그)",
        "searchword": SEARCHWORD,
        "years": years,
        "generated_at": date.today().isoformat(),
        "counts": counts,
        "windows": windows_log,
    }
    return result


def save(result: dict) -> Path:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return OUT_PATH


def get_past_complaints() -> dict[str, int] | None:
    """캐시된 실데이터 민원 건수 {gu: count}. 없으면 None."""
    if OUT_PATH.exists():
        data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
        return data.get("counts")
    return None


if __name__ == "__main__":
    print("러브버그 민원 실데이터 수집 중… (ACRC API)")
    res = build_seoul_complaints()
    path = save(res)
    print(f"저장: {path}")
    ranked = sorted(res["counts"].items(), key=lambda x: x[1], reverse=True)
    for gu, c in ranked:
        if c > 0:
            print(f"  {gu:6s} {c}")
