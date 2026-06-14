"""서울 공원·녹지 실데이터 로더.

서울 열린데이터광장 / 서울시 시정통계(stat.eseoul.go.kr)의
자치구별 '공원율(공원면적/행정구역면적)' 또는 '1인당 공원면적' 데이터를
CSV로 받아 env 점수에 사용한다.

지원 입력 (둘 중 아무거나):
  A) data/raw/seoul_park.csv  : 사용자가 직접 받은 CSV
       - 헤더에 자치구명 컬럼 + 값 컬럼이 있으면 자동 인식
  B) 서울 열린데이터광장 OpenAPI (키 필요) → fetch_from_api()

산출물: data/processed/parks.json = {gu: value(float)}
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW_CSV = ROOT / "data" / "raw" / "seoul_park.csv"
OUT_PATH = ROOT / "data" / "processed" / "parks.json"
DISTRICTS_PATH = ROOT / "data" / "static" / "districts.json"

GU_RE = re.compile(r"[가-힣]+구")


def _districts() -> set[str]:
    return set(json.loads(DISTRICTS_PATH.read_text(encoding="utf-8"))["districts"].keys())


def _to_float(s: str):
    if s is None:
        return None
    s = s.replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def load_from_csv(path: Path = RAW_CSV) -> dict[str, float]:
    """CSV에서 자치구별 값을 추출. 구명 컬럼/값 컬럼을 자동 탐지.

    가정: 각 행에 자치구명이 들어있고, 같은 행에 숫자값(공원율/면적)이 있다.
    여러 숫자 컬럼이면 마지막(또는 최신연도) 값을 사용.
    """
    districts = _districts()
    out: dict[str, float] = {}
    if not path.exists():
        return out
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        rows = [r for r in reader if any(c.strip() for c in r)]
    for row in rows:
        gu = None
        for cell in row:
            m = GU_RE.fullmatch(cell.strip())
            if m and cell.strip() in districts:
                gu = cell.strip()
                break
        if not gu:
            continue
        # 행에서 마지막 유효 숫자값 사용
        vals = [v for v in (_to_float(c) for c in row) if v is not None]
        if vals:
            out[gu] = vals[-1]
    return out


def save(values: dict[str, float], source: str) -> Path:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps({"source": source, "values": values}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return OUT_PATH


def get_park_values() -> dict[str, float] | None:
    """캐시된 공원 실데이터 {gu: value}. 없으면 None."""
    if OUT_PATH.exists():
        return json.loads(OUT_PATH.read_text(encoding="utf-8")).get("values")
    return None


if __name__ == "__main__":
    vals = load_from_csv()
    if not vals:
        print(f"입력 CSV가 없습니다: {RAW_CSV}")
        print("→ 서울 시정통계(공원율/1인당 공원면적) 표를 CSV로 받아 위 경로에 두세요.")
    else:
        path = save(vals, source=f"CSV:{RAW_CSV.name}")
        print(f"저장: {path} ({len(vals)}개 자치구)")
        for gu, v in sorted(vals.items(), key=lambda x: x[1], reverse=True):
            print(f"  {gu:6s} {v}")
