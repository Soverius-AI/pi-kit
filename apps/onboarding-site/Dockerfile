# Build context is the repository root: docker build -f apps/onboarding-site/Dockerfile .
# A glibc Node 24 image matches the repository's engines; install scripts are skipped because the site needs none of the
# native modules (node-pty, sqlite) the desktop and backend build on install.
FROM node:24-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0 CI=1 NX_DAEMON=false
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm exec nx build onboarding-site --skip-nx-cache

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY apps/onboarding-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/dist/apps/onboarding-site/browser /usr/share/nginx/html
EXPOSE 8080
