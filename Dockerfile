FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts

EXPOSE 8000

# 클라우드는 $PORT를 주입한다(없으면 8000). shell 형태라야 ${PORT} 치환됨.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
