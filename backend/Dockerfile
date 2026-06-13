FROM mcr.microsoft.com/playwright/python:v1.49.0-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data /app/session /app/engine/chrome_profile_playwright

ENV PYTHONUNBUFFERED=1
ENV HEADLESS=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host ${API_HOST:-0.0.0.0} --port ${API_PORT:-8000}"]