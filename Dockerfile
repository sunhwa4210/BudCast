# --- 1단계: 프론트엔드 정적 빌드 ---
FROM node:22-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# 같은 출처(/api/*)로 호출하도록 상대경로 빌드
ENV NEXT_PUBLIC_API_BASE=""
RUN npm run build

# --- 2단계: 백엔드 런타임(프론트 정적파일까지 서빙) ---
FROM python:3.12-slim AS runtime
WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# 디렉터리 구조 유지(코드가 parents[2] 기준 상대경로로 데이터/지오json 참조)
COPY backend/ ./backend/
COPY data/ ./data/
COPY frontend/public/ ./frontend/public/
COPY --from=frontend /fe/out ./frontend/out

ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
