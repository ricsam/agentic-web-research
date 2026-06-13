FROM oven/bun:1.3.13 AS app

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/admin/package.json apps/admin/package.json

RUN bun install

COPY . .

RUN bun run build:admin
RUN bunx playwright install --with-deps chromium

EXPOSE 8080

CMD ["bun", "run", "--cwd", "apps/server", "start"]
