# opencodex — proxy + dashboard in one container.
#
#   docker build -t opencodex .
#   docker run -d --name opencodex -p 10100:10100 \
#     -e OPENCODEX_API_AUTH_TOKEN=change-me \
#     -v opencodex-data:/data opencodex
#
# Inside a container the proxy must bind 0.0.0.0 to be reachable through the
# published port, and the server refuses a non-loopback bind without a
# data-plane credential — so a credential is effectively required. That is the
# same rule `ocx host` enforces on bare metal, not a Docker quirk. Either route
# the server accepts works: OPENCODEX_API_AUTH_TOKEN, or an `apiKeys` entry in
# the config.json on the mounted volume.
#
# The entrypoint supervises the proxy, so an in-app restart (the dashboard's
# drain-and-restart, a crash) brings it back rather than ending the container.
# `docker stop` is how you stop it — every proxy exit is otherwise a restart.

# ---- Stage 1: build the dashboard ------------------------------------------
FROM oven/bun:1.3.14 AS gui
WORKDIR /build
COPY gui/package.json gui/bun.lock ./gui/
RUN cd gui && bun install --frozen-lockfile
# The GUI build bakes the parent package version into the bundle.
COPY package.json ./
COPY gui/ ./gui/
RUN cd gui && bun run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM oven/bun:1.3.14
WORKDIR /app

# git powers the local account-change history (state snapshots in /data).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY bin/ ./bin/
COPY CHANGELOG.md* ./
COPY --from=gui /build/gui/dist ./gui/dist

# All durable state (config, accounts, history) lives on the volume.
ENV OPENCODEX_HOME=/data

# The container runs as the base image's unprivileged `bun` user (uid/gid 1000)
# so credentials written to /data are not root-owned — a volume shared with a
# bare-metal install stays readable without sudo.
#
# Trade-off, stated precisely: this cannot fix an *existing* mount. A named
# volume created from this image inherits /data's uid 1000 ownership, and so
# does a fresh empty one. But a bind mount of a host directory keeps the host's
# ownership, and a named volume populated by an older root-running opencodex
# image keeps its root-owned files. In those two cases the entrypoint fails fast
# with the exact `chown -R 1000:1000` command to run; `--user 0:0` restores the
# old root behaviour verbatim for anyone who prefers it.
RUN mkdir -p /data && chown -R bun:bun /data /app
VOLUME /data

# One fixed published port. The entrypoint normalizes config.port to match,
# because EXPOSE and HEALTHCHECK below cannot follow a port chosen inside a
# mounted config. To use a different one, override both together:
#   docker run -e OPENCODEX_CONTAINER_PORT=8080 -p 8080:8080 ...
ENV OPENCODEX_CONTAINER_PORT=10100
EXPOSE 10100

# Container-internal liveness; identity-checked the same way the CLI does it.
# Reads the port from the environment so an overridden port stays healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const p=process.env.OPENCODEX_CONTAINER_PORT||10100;const r=await fetch('http://127.0.0.1:'+p+'/healthz');const b=await r.json();if(b.service!=='opencodex')throw 1" || exit 1

# docker-entrypoint.sh writes hostname/port into the config before start, then
# supervises the proxy: the dashboard's drain-and-restart exits the process on
# purpose and expects something to bring it back, and PID 1 in a container has
# nothing above it to do that. See the header of the script for the exit-code
# semantics and the OPENCODEX_CONTAINER_SUPERVISE=0 escape hatch.
#
# chmod, not the mode COPY inherits from the build context: the repository is
# checked out on hosts with core.filemode=false (Windows), where git records the
# script as 0644 and the container refuses to exec it — every `docker run` died
# on "permission denied" before the entrypoint printed a single line.
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER bun
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
