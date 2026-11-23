# Bun runtime swap for the r5d-chat research deployment.
#
# The running r5d-chat image (tag sha-302810f) was built on 2026-08-24 from a
# working tree with uncommitted changes, so main cannot replace it without
# changing the application. This image keeps that image's exact /app tree
# (source, node_modules, built admin UI) and rebuilds everything beneath it on
# oven/bun:1.4.5, repeating the repository Dockerfile's steps around it.
FROM ghcr.io/ricsam/agentic-web-research@sha256:8cdaa243c3db629f2d580f909e45a725d8e03c457ea4876665f9aee9a0984c35 AS production

FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18

LABEL org.opencontainers.image.source="https://github.com/ricsam/agentic-web-research"
LABEL org.opencontainers.image.description="Bun 1.4.5 runtime under the unchanged /app tree of ghcr.io/ricsam/agentic-web-research@sha256:8cdaa243c3db629f2d580f909e45a725d8e03c457ea4876665f9aee9a0984c35"

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=production /app /app

RUN cd apps/server \
  && bun node_modules/playwright/cli.js install --with-deps chromium \
  && bun -e "const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true }); await browser.close();" \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

EXPOSE 8080

WORKDIR /app/apps/server

USER bun

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]

CMD ["bun", "src/index.ts"]
