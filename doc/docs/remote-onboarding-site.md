---
title: Onboarding site
---

# Remote-access setup guide

`https://remote.pi-kit.dev` serves a static guide for installing pi-kit and Tailscale, enabling
[remote access](remote-access.md), pairing a device, and adding the private address to the Home Screen.
It can save the user's `https://…ts.net` address in browser storage, open that address, and scan a pairing QR code
with the device camera. It does not proxy application traffic or hold pi-kit credentials. The application runs at
the computer's private tailnet address.

## Source and local development

`apps/onboarding-site/` is an Angular app (`pk-onboarding`) served by nginx. It uses English and German translations
from `@pi-kit/i18n` and decodes QR codes with `jsqr`. Its `i18n` target extracts the `remoteSite` section of the shared
translations into `public/i18n` before builds and tests. The download link points to the latest GitHub release.

```sh
pnpm exec nx serve onboarding-site
pnpm exec nx test onboarding-site
```

## Deployment workflow

The `deploy-onboarding` job in `.github/workflows/release.yml` runs on `v*` tag pushes after the release is published.
It uses the Coolify API to pin the configured application to the release commit and request a deployment. The repository
contains `apps/onboarding-site/Dockerfile` for building from the repository root; nginx listens on port `8080`.

The job reads three GitHub repository secrets:

| Secret | Purpose |
|---|---|
| `COOLIFY_URL` | The Coolify instance URL. |
| `COOLIFY_TOKEN` | An API token permitted to update and deploy the application. |
| `COOLIFY_ONBOARDING_UUID` | The target Coolify application's identifier. |

If any secret is missing, the job emits a notice and skips deployment. Triggering the API does not prove that the
external deployment completed successfully; its status is managed in Coolify. Domain routing and credentials are
operational configuration, not values maintained in the source tree.
