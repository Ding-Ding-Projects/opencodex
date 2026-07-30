#!/bin/sh
# opencodex container entrypoint and supervisor.
#
# Ensures the config binds an address the container can actually reach (a
# loopback bind is unreachable through a published port, a hostname the container
# cannot bind kills the proxy on start, and a config-chosen port is unreachable
# through a fixed EXPOSE/HEALTHCHECK), and refuses to start without a data-plane
# credential.
#
# The credential rule mirrors the server's own `assertServerAuthConfig`: either
# OPENCODEX_API_AUTH_TOKEN *or* a non-empty `apiKeys` entry in the config
# satisfies it. Surfacing it here just makes the failure earlier and gives it a
# Docker-flavoured message; it must never be stricter than the server.
#
# It then *supervises* the proxy instead of exec'ing it, because the proxy exits
# on purpose in normal operation: the dashboard's drain-and-restart recycles the
# process and expects a supervisor to bring it back (src/server/management/
# system-restart.ts spells that contract out — systemd Restart=on-failure, WinSW
# onfailure, a Task Scheduler loop). As PID 1 with no supervisor above it, a bare
# `exec` turned that button into "stop the container, permanently". So this script
# stays PID 1 and relaunches.
#
# Consequences, stated precisely rather than discovered later:
# - Every proxy exit is treated as a restart request, including the dashboard's
#   "Exit app" — the two are indistinguishable from out here (both exit 0). In a
#   container the way to stop the proxy is to stop the container: `docker stop`
#   sends SIGTERM to this script, which forwards it and goes down with the proxy.
# - A proxy that dies immediately, over and over, is a real failure and not
#   something to paper over: after 5 exits inside 5s the supervisor gives up so
#   the error stays visible in `docker logs` instead of scrolling past forever.
# - OPENCODEX_CONTAINER_SUPERVISE=0 restores the plain `exec` behaviour, for
#   running under an orchestrator (Kubernetes, ECS, a restart policy) that wants
#   to see the exit itself. Drain-and-restart then depends on that policy.
#
# Nothing in here may be more brittle than the server it wraps. In particular a
# config.json that will not parse is left exactly as-is: the server backs up an
# unreadable config and starts from defaults, and pre-empting that with a hard
# exit would turn a self-healing situation into a crash loop.

set -eu

: "${OPENCODEX_HOME:=/data}"
# The image publishes one fixed port (EXPOSE + HEALTHCHECK). Override it only
# together with the published port: -e OPENCODEX_CONTAINER_PORT=8080 -p 8080:8080
: "${OPENCODEX_CONTAINER_PORT:=10100}"
: "${OPENCODEX_CONTAINER_SUPERVISE:=1}"
# `:=` only creates shell variables. The normalizer below reads both through
# process.env, so without the export it fell back to `Number(undefined)` — NaN,
# which JSON.stringify writes as `"port": null` onto the volume. It happened to
# work only because the image also declares them with ENV.
export OPENCODEX_HOME OPENCODEX_CONTAINER_PORT
CONFIG="$OPENCODEX_HOME/config.json"
PROXY_ENTRY="/app/src/cli/index.ts"

credential_required() {
  echo "opencodex: no data-plane credential is configured." >&2
  echo "  A container binds 0.0.0.0, and a non-loopback bind requires a data-plane" >&2
  echo "  credential. Provide either one:" >&2
  echo "    - an environment token:  docker run -e OPENCODEX_API_AUTH_TOKEN=<secret> ..." >&2
  echo "    - an apiKeys entry in $CONFIG on the mounted volume" >&2
  exit 1
}

# The port is interpolated straight into JSON and compared numerically inside the
# normalizer. `8o8o` writes `"port": 8o8o`, an empty value writes `"port": ` and a
# leading zero writes `"port": 08080` — each one a config.json the server can only
# back up and replace, on the volume holding the user's accounts. And `null` reaches
# the same file through the normalizer's `Number()`. Refuse loudly instead.
case "$OPENCODEX_CONTAINER_PORT" in
  "" | *[!0-9]*) OPENCODEX_CONTAINER_PORT_VALID=0 ;;
  0*) OPENCODEX_CONTAINER_PORT_VALID=0 ;;
  *) OPENCODEX_CONTAINER_PORT_VALID=1 ;;
esac
if [ "$OPENCODEX_CONTAINER_PORT_VALID" = 1 ]; then
  if [ "$OPENCODEX_CONTAINER_PORT" -lt 1 ] || [ "$OPENCODEX_CONTAINER_PORT" -gt 65535 ]; then
    OPENCODEX_CONTAINER_PORT_VALID=0
  fi
fi
if [ "$OPENCODEX_CONTAINER_PORT_VALID" = 0 ]; then
  echo "opencodex: OPENCODEX_CONTAINER_PORT=\"$OPENCODEX_CONTAINER_PORT\" is not a port number." >&2
  echo "  Expected a decimal integer from 1 to 65535 with no leading zero, and it must match" >&2
  echo "  the published port:  docker run -e OPENCODEX_CONTAINER_PORT=8080 -p 8080:8080 ..." >&2
  exit 1
fi

mkdir -p "$OPENCODEX_HOME"

if [ ! -w "$OPENCODEX_HOME" ]; then
  echo "opencodex: $OPENCODEX_HOME is not writable by uid $(id -u)." >&2
  echo "  The image runs as a non-root user so credentials written to the volume are not" >&2
  echo "  root-owned. When mounting an existing host directory, give it to that user:" >&2
  echo "    chown -R $(id -u):$(id -g) <host-dir>     (or run with --user 0:0)" >&2
  exit 1
fi

# Runs before *every* start, not just the first. A one-click state restore rewrites
# config.json from history and then restarts the proxy, so the file the second start
# reads can be a bare-metal config again — loopback hostname, foreign port and all.
prepare_config() {
  if [ ! -f "$CONFIG" ]; then
    # Nothing on the volume yet, so the only possible credential is the env token.
    [ -n "${OPENCODEX_API_AUTH_TOKEN:-}" ] || credential_required
    printf '{\n  "hostname": "0.0.0.0",\n  "port": %s\n}\n' "$OPENCODEX_CONTAINER_PORT" > "$CONFIG"
    return 0
  fi

  # An existing volume may carry a hostname or port from a bare-metal config;
  # rewrite just those fields so the container stays reachable through the
  # published port. Exit codes: 0 ok, 3 no credential, 4 unparseable.
  set +e
  # --- config-normalizer ---
  bun -e '
    const path = process.env.OPENCODEX_HOME + "/config.json";
    const wantPort = Number(process.env.OPENCODEX_CONTAINER_PORT);
    let config;
    try {
      config = JSON.parse(await Bun.file(path).text());
    } catch (error) {
      config = undefined;
      console.error("opencodex: could not read " + path + " as JSON: " + (error && error.message ? error.message : String(error)));
    }
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      // Leave it alone. The server backs up an unreadable config and starts from its
      // defaults; those defaults bind loopback, so the container will answer its own
      // healthcheck but stay unreachable through the published port until the file is
      // repaired or removed. Crashing here instead would only produce a restart loop.
      console.error("opencodex: leaving the file untouched so the server can back it up and start from defaults.");
      console.error("opencodex: until it is repaired or removed the server binds loopback and the container is not reachable through the published port.");
      process.exit(4);
    }
    const hasConfigKey = Array.isArray(config.apiKeys)
      && config.apiKeys.some((entry) => entry && typeof entry.key === "string" && entry.key.trim() !== "");
    // Mirror assertServerAuthConfig: env token OR a non-empty apiKeys entry.
    if (!(process.env.OPENCODEX_API_AUTH_TOKEN || "").trim() && !hasConfigKey) process.exit(3);
    let changed = false;

    // Rewriting only the loopback literals was not enough: `ocx host enable` writes the
    // machine LAN IP into the config, and that address does not exist on any interface
    // inside the container, so the proxy died on bind on every single start — a config
    // on a reused volume crash-looped the container forever. So ask the kernel instead
    // of guessing: anything unresolvable, loopback-resolving, or unbindable in here gets
    // replaced. A hostname that genuinely works (the container IP, a pinned --ip) is kept.
    const hostname = config.hostname === undefined || config.hostname === null ? "" : String(config.hostname).trim();
    const isLoopbackAddress = (address) => address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
    const hostnameVerdict = async (host) => {
      if (host === "0.0.0.0" || host === "::") return "usable";
      if (["127.0.0.1", "localhost", "::1"].includes(host)) return "loopback";
      const net = await import("node:net");
      const dns = await import("node:dns/promises");
      let address;
      try {
        address = (await dns.lookup(host)).address;
      } catch {
        return "unresolvable";
      }
      if (isLoopbackAddress(address)) return "loopback";
      return await new Promise((resolve) => {
        const probe = net.createServer();
        // Port 0 so the probe can never collide with the port the proxy is about to take.
        probe.once("error", () => resolve("unbindable"));
        probe.listen({ host, port: 0, exclusive: true }, () => { probe.close(() => resolve("usable")); });
      });
    };
    const verdict = hostname === ""
      ? "unset"
      : await Promise.race([
          hostnameVerdict(hostname),
          // A hung resolver must not hang the container start. Timing out counts as
          // unusable, which errs toward a reachable container.
          new Promise((resolve) => setTimeout(() => resolve("unbindable"), 3000)),
        ]);
    const whyRewritten = {
      unset: "no hostname was set",
      loopback: "a loopback bind is not reachable through a published port",
      unresolvable: "the container cannot resolve " + JSON.stringify(hostname),
      unbindable: "no interface in this container carries " + JSON.stringify(hostname) + ", so the proxy would die on bind",
    }[verdict];
    if (whyRewritten) {
      config.hostname = "0.0.0.0";
      changed = true;
      console.log("opencodex: rewrote config hostname to 0.0.0.0 for container networking — " + whyRewritten + ".");
    }

    if (config.port !== wantPort) {
      console.log("opencodex: overrode config port " + JSON.stringify(config.port) + " with " + wantPort + " — the image publishes a fixed port, and the healthcheck watches it. To keep a different port, run with -e OPENCODEX_CONTAINER_PORT=<port> -p <port>:<port>.");
      config.port = wantPort;
      changed = true;
    }
    if (changed) {
      try {
        await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
      } catch (error) {
        console.error("opencodex: could not rewrite " + path + ": " + (error && error.message ? error.message : String(error)));
        console.error("opencodex: starting anyway with the config as written on the volume.");
      }
    }
    // Explicit, so a socket handle the probe left behind can never keep this process
    // alive: a normalizer that hangs never starts the proxy at all.
    process.exit(0);
  '
  # --- end config-normalizer ---
  normalize_status=$?
  set -e
  case "$normalize_status" in
    0) ;;
    3) credential_required ;;
    4) ;;  # unparseable: already explained above, hand it to the server
    *) exit "$normalize_status" ;;
  esac
}

# systemd's KillMode=control-group, by hand. When drain-and-restart cannot see a
# supervisor it spawns its *own* detached replacement before exiting; in here it
# cannot see one (there is no installed service in a container), so a leftover
# proxy may already be reaching for the published port while we relaunch. Two
# proxies fighting over one port is worse than either alone.
# Terminating a leftover is not enough: the replacement is started WITHOUT --port, so
# it only retries the preferred port for ~750ms before falling back to a random one.
# A leftover that holds the socket for a second or two while it drains would leave the
# container running but unreachable through the published port — the very failure this
# reaping exists to prevent, arrived at from the other side. So confirm each pid is
# actually gone rather than sleeping a guessed amount and hoping.
reap_leftover_proxies() {
  reaped=""
  for proc_dir in /proc/[0-9]*; do
    leftover_pid=${proc_dir#/proc/}
    if [ "$leftover_pid" = "$$" ]; then continue; fi
    leftover_cmd=$(tr "\0" " " < "$proc_dir/cmdline" 2>/dev/null) || continue
    case "$leftover_cmd" in
      *"$PROXY_ENTRY start"*)
        kill "$leftover_pid" 2>/dev/null || true
        reaped="$reaped $leftover_pid"
        ;;
    esac
  done
  [ -n "$reaped" ] || return 0

  # Bounded: a leftover that will not die must not wedge the supervisor forever. If the
  # deadline passes we say so and carry on — the port fallback message from the proxy
  # is then the honest explanation rather than a silent misbinding.
  waited=0
  while [ "$waited" -lt 100 ]; do
    still_running=""
    for reaped_pid in $reaped; do
      if [ -e "/proc/$reaped_pid" ]; then still_running="yes"; break; fi
    done
    [ -n "$still_running" ] || return 0
    interruptible_sleep 0.1
    if [ "$stopping" = 1 ]; then return 0; fi
    waited=$((waited + 1))
  done
  echo "opencodex: a previous proxy is still running after 10s; the replacement may have to use another port." >&2
}

if [ "$OPENCODEX_CONTAINER_SUPERVISE" = 0 ]; then
  prepare_config
  exec bun run "$PROXY_ENTRY" start
fi

proxy_pid=""
stopping=0
forward_stop() {
  stopping=1
  if [ -n "$proxy_pid" ]; then kill -TERM "$proxy_pid" 2>/dev/null || true; fi
}
trap forward_stop TERM INT

# A signal is only delivered to a shell between commands, or while it is blocked in
# `wait` — so a plain `sleep` swallows it for its whole duration. Backgrounding the
# sleep and waiting on it makes the delay interruptible, which is what lets a
# `docker stop` land during the restart window instead of being sat on until the
# grace period runs out and the runtime SIGKILLs us.
interruptible_sleep() {
  sleep "$1" &
  wait "$!" 2>/dev/null || true
}

# `stopping` is set by the trap from anywhere, but acting on it only where `wait`
# returns is not enough: a TERM arriving during reaping, the restart delay, or
# prepare_config would set the flag and then be ignored, and the loop would start a
# replacement and block in `wait` forever. Every step of the loop checks through here.
exit_if_stopping() {
  if [ "$stopping" = 1 ]; then
    echo "opencodex: stop requested; not restarting the proxy." >&2
    exit 0
  fi
}

fast_exits=0
while :; do
  prepare_config
  # prepare_config can take a moment on a cold volume, and a stop arriving inside it
  # must not be answered by launching a proxy.
  exit_if_stopping
  started_at=$(date +%s)
  bun run "$PROXY_ENTRY" start &
  proxy_pid=$!
  proxy_status=0
  wait "$proxy_pid" || proxy_status=$?

  if [ "$stopping" = 1 ]; then
    # `docker stop`: the proxy owns its own shutdown, we just wait for it and go
    # down with it. A second signal (or the SIGKILL after the grace period) ends
    # this wait, which is the correct outcome either way.
    wait "$proxy_pid" 2>/dev/null || true
    exit 0
  fi

  reap_leftover_proxies
  exit_if_stopping
  exited_at=$(date +%s)
  if [ "$((exited_at - started_at))" -lt 5 ]; then
    fast_exits=$((fast_exits + 1))
  else
    fast_exits=0
  fi
  if [ "$fast_exits" -ge 5 ]; then
    echo "opencodex: the proxy exited 5 times in a row within 5s of starting (last status $proxy_status)." >&2
    echo "  Not restarting it again — a restart loop would bury the error above. Fix the cause," >&2
    echo "  or inspect the volume, then start the container again." >&2
    if [ "$proxy_status" = 0 ]; then exit 1; fi
    exit "$proxy_status"
  fi
  echo "opencodex: proxy exited with status $proxy_status; restarting it (a container is its own supervisor)." >&2
  # Let the listen socket clear before the replacement reaches for it — interruptibly,
  # so a stop during this second is honoured instead of waited out.
  interruptible_sleep 1
  exit_if_stopping
done
