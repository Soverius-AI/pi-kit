#!/bin/sh
# Build locally and deploy the output without a commit: sh apps/onboarding-site/deploy/push.sh [user@host]
set -eu
host=${1:-root@46.224.163.73}
site=/srv/pi-kit-onboarding/site
pnpm exec nx build onboarding-site --output-style=static >/dev/null
COPYFILE_DISABLE=1 tar --no-xattrs -C dist/apps/onboarding-site -cz browser -C "$(pwd)/apps/onboarding-site" nginx.conf compose.yaml \
  | ssh "$host" "rm -rf $site.next && mkdir -p $site.next && tar -xz -C $site.next && rm -rf $site.previous && { [ -d $site ] && mv $site $site.previous || true; } && mv $site.next $site && docker compose -f $site/compose.yaml up -d --force-recreate --remove-orphans"
echo "deployed to https://remote.pi-kit.dev"
