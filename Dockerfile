FROM oven/bun:1.3.13 AS app

LABEL org.opencontainers.image.source="https://github.com/ricsam/agentic-web-research"

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/admin/package.json apps/admin/package.json

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build:admin
RUN cd apps/server \
  && bun node_modules/playwright/cli.js install --with-deps chromium \
  && bun -e "const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true }); await browser.close();" \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

EXPOSE 8080

USER bun

CMD ["bun", "run", "--cwd", "apps/server", "start"]
