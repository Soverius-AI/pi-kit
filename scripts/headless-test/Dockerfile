# Integration-test machine, not a production headless distribution.
# Run with its own cgroup namespace: systemd must really supervise the service.
# No Node.js and no desktop libraries: the server tarball brings its own runtime and needs neither.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus-user-session libpam-systemd \
      ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash tester \
    && mkdir -p /var/lib/systemd/linger \
    && touch /var/lib/systemd/linger/tester
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
