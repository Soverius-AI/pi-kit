# Build context is the repository root: docker build -f apps/onboarding-site/Dockerfile .
FROM node:22-alpine AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0 CI=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec nx build onboarding-site --skip-nx-cache

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY apps/onboarding-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/dist/apps/onboarding-site/browser /usr/share/nginx/html
EXPOSE 8080
