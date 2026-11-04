---
title: Onboarding site
---

# remote.pi-kit.dev onboarding site

A static guide at `https://remote.pi-kit.dev` that walks a user through installing pi-kit and Tailscale, enabling [remote access](remote-access.md), pairing a device and adding the private address to the Home Screen. It can remember the user's own `https://…ts.net` address in the browser, open it, and scan the pairing QR code with the device camera. It serves no application routes and holds no credentials; the chat app stays on the private tailnet address.

Source: `apps/onboarding-site/`, a small Angular app (`pk-onboarding`, English and German through `@pi-kit/i18n`, QR decoding with `jsqr`) served by nginx. Its strings live under `remoteSite` in the shared translation files; the `i18n` target extracts that section into `public/i18n` before each build and test. The download button points at the latest GitHub release.

```sh
pnpm exec nx serve onboarding-site
pnpm exec nx test onboarding-site
```

## Deploy

Every `v*` tag deploys the site: the `deploy-onboarding` job in `.github/workflows/release.yml` runs after the GitHub release is published, pins the Coolify application to the tagged commit (`PATCH /api/v1/applications/{uuid}` with `git_commit_sha`) and triggers a build (`POST /api/v1/deploy?uuid=…&force=true`). Coolify then builds `apps/onboarding-site/Dockerfile` from the repository root and routes `remote.pi-kit.dev` to it. Until the secrets below exist the job prints a notice and does nothing, so releases are never blocked by the site.

### Coolify setup (done on 2026-11-04)

The Coolify application `onboarding` (`wtymbsuvufvd9wtvpiauejrs`) lives in the project `remote.pi-kit.dev` on the `localhost` server of https://appz.coderabbit.at: public repository `Soverius-AI/pi-kit`, branch `main`, Dockerfile build pack with `apps/onboarding-site/Dockerfile` from base directory `/`, port 8080, domain `https://remote.pi-kit.dev`, no auto deploy. The instance API is enabled and the token `github-release remote.pi-kit.dev` (write and deploy, scoped to the `remote.pi-kit.dev` project only, no expiry) is stored with the URL and the application UUID as the repository secrets `COOLIFY_URL`, `COOLIFY_TOKEN` and `COOLIFY_ONBOARDING_UUID`.

Before the first tag deploy, remove the interim container so the domain has one router: `ssh root@46.224.163.73 'docker rm -f pi-kit-onboarding'`. To rotate the token, create a new one under Keys & Tokens in Coolify and replace `COOLIFY_TOKEN`.

### Interim push-to-deploy

Until the Coolify application exists, a build can still be pushed by hand:

```sh
pnpm run deploy:onboarding
```

`deploy:onboarding` builds the app locally and copies `dist/apps/onboarding-site/browser`, `nginx.conf` and `compose.yaml` over SSH into `/srv/pi-kit-onboarding/site`, then runs `docker compose up` there. The container is the stock `nginx-unprivileged` image with the build output bind-mounted; it joins the `coolify` network with Traefik labels for `remote.pi-kit.dev`, so Coolify's proxy issues the certificate. Nothing needs to be committed.
