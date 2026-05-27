FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc && \
    cp -r src/web_admin/public dist/web_admin/public && \
    mkdir -p dist/web_portal && \
    cp -r src/web_portal/public dist/web_portal/public && \
    chmod +x dist/cli/index.js

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    bash \
    curl \
    git \
    unzip \
    ca-certificates \
    ffmpeg \
    espeak-ng \
    libespeak-ng1 \
    python3 \
    make \
    build-essential \
    xpdf \
    gnupg \
    lsb-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

WORKDIR /app/node_modules/better-sqlite3
RUN npm run build-release

WORKDIR /app

COPY --from=builder /app/dist dist/
COPY docs/ docs/

RUN mkdir -p /data/config /data/workspaces /data/skills

VOLUME ["/data"]

ENV KORA_STORAGE_PATH=/data

EXPOSE 3120

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3120/api/status || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]