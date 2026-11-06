FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PORT=8767

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    i2c-tools \
    iproute2 \
    iputils-ping \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY server.py /app/server.py
COPY static /app/static

EXPOSE 8767
CMD ["python", "/app/server.py"]
