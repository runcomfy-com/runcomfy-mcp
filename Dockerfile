FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

RUN useradd --create-home --shell /usr/sbin/nologin appuser

COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY runcomfy_client.py server.py container_runtime.py container_app.py container_entrypoint.py ./

USER appuser

EXPOSE 8000

CMD ["python", "-m", "container_entrypoint"]
