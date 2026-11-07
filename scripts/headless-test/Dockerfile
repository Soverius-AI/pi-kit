# Integration-test machine, not a production headless distribution.
# Run with its own cgroup namespace: systemd must really supervise the service.
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus-user-session libpam-systemd \
      libgtk-3-0 libnss3 libasound2 libgbm1 libsecret-1-0 libxtst6 libxss1 \
      ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash tester \
    && mkdir -p /var/lib/systemd/linger /opt/pi-kit \
    && touch /var/lib/systemd/linger/tester
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
