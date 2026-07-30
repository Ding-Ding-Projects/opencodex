---
title: Docker
description: Run the opencodex proxy and dashboard in a container, with every durable file on one volume.
---

The repository ships a `Dockerfile` that builds the dashboard and the proxy into one image. It is a
convenient way to keep opencodex running on a home server or NAS — but a container is a networked
deployment, so read [Remote access](/reference/configuration/#remote-access) first: the same
credential rules `ocx host` enforces apply here, and they are not optional.

## Build and run

```bash
docker build -t opencodex .

docker run -d --name opencodex -p 10100:10100 \
  -e OPENCODEX_API_AUTH_TOKEN=<data-plane-secret> \
  -e OPENCODEX_ADMIN_AUTH_TOKEN=<admin-secret> \
  -v opencodex-data:/data \
  opencodex
```

The dashboard is then at `http://<host>:10100/`, and clients point at `http://<host>:10100/v1`.

## A credential is mandatory

A container has to bind `0.0.0.0` to be reachable through a published port, and opencodex refuses a
non-loopback bind without a data-plane credential. The entrypoint checks the same rule the server
does — `OPENCODEX_API_AUTH_TOKEN`, **or** a non-empty `apiKeys` entry in the `config.json` on the
volume — and fails fast with that message instead of letting the server throw later. This is not a
Docker quirk; it is exactly what `ocx host enable` insists on.

`OPENCODEX_ADMIN_AUTH_TOKEN` is the separate credential the dashboard and `/api/*` authenticate
with. Omit it and the proxy generates one on first start, into `admin-api-token` inside its config
directory — which here is the `/data` volume, **not** `~/.opencodex` on the host. `ocx host token`
run on the host reads the host's own config directory and will not find it, so read it out of the
container:

```bash
docker exec opencodex cat /data/admin-api-token
```

## State lives on the volume

`OPENCODEX_HOME` is `/data`, so the config, the OAuth/account stores, and the local
account-change git history all live on the mounted volume. `git` is installed in the image for that
history. Nothing durable is kept in the container layer — remove and recreate the container freely,
keep the volume.

## What the entrypoint rewrites

The image publishes one fixed port, because `EXPOSE` and `HEALTHCHECK` cannot follow a port chosen
inside a mounted config file. Before starting the server, the entrypoint normalizes two fields of
`/data/config.json`:

| Field | Rewritten to | Why |
| --- | --- | --- |
| `hostname` | `0.0.0.0` when it is missing, loopback, unresolvable inside the container, or an address no interface here carries | a loopback bind is unreachable through a published port, and an address the container cannot bind kills the proxy on start — a volume carrying a hostname from a previous `ocx host enable` would otherwise crash-loop forever |
| `port` | `OPENCODEX_CONTAINER_PORT` (default `10100`) | a config-chosen port is unreachable through the fixed `EXPOSE`, and the healthcheck watches the published one |

To use a different port, override both halves together:

```bash
docker run -e OPENCODEX_CONTAINER_PORT=8080 -p 8080:8080 ...
```

A `config.json` that will not parse is deliberately left untouched: the server backs up an
unreadable config and starts from its defaults, and pre-empting that with a hard exit would turn a
self-healing situation into a restart loop. Those defaults bind loopback, so the container answers
its own healthcheck while staying unreachable from outside until the file is repaired or removed —
the entrypoint says so on stderr rather than failing silently.

## File ownership

The image runs as the base image's unprivileged `bun` user (uid/gid `1000`) so credentials written to
the volume are not root-owned. That cannot fix an **existing** mount:

- A named volume created from this image — or a fresh empty one — inherits `/data`'s uid 1000
  ownership and just works.
- A **bind mount** of a host directory keeps the host's ownership, and a named volume populated by an
  older root-running opencodex image keeps its root-owned files. In both cases the entrypoint fails
  fast with the exact command to run:

  ```bash
  chown -R 1000:1000 <host-dir>
  ```

  Running with `--user 0:0` restores the old root behaviour verbatim if you prefer it.

## Health

The image declares a `HEALTHCHECK` that calls `/healthz` on the container-internal port and requires
the response to identify itself as `opencodex`, so an unrelated process answering that port cannot
mark the container healthy. It reads the port from the environment, so an overridden
`OPENCODEX_CONTAINER_PORT` stays healthy.

## Limitations

- **No TLS.** Both tokens cross the network in cleartext, exactly as with `ocx host`. Put the
  container behind a reverse proxy that terminates TLS if it needs to leave a trusted network.
- **Browser OAuth logins are awkward inside a container.** There is no browser, and each provider's
  login flow waits on its own `127.0.0.1` callback port *inside* the container, which the redirect
  from your own browser cannot reach. Log in on a machine that has a browser and move the resulting
  state onto the volume — `ocx export` writes the bundle and prints the restore steps.
- `ocx service` (launchd / systemd / Task Scheduler) has no role here — the entrypoint is the
  supervisor. It restarts the proxy when the proxy exits on its own, which is what makes the
  dashboard's drain-and-restart work inside a container: without it, that action would stop the
  container permanently, because the proxy expects a supervisor to bring it back and PID 1 in here is
  the entrypoint, not an init system. A proxy that exits five times within 5s of starting is *not*
  restarted again, so a real failure surfaces in the logs instead of being buried by a restart loop.
- **`docker stop` is how you stop it.** The entrypoint forwards SIGTERM to the proxy, which runs its
  own drain, and then exits with it — including when the signal lands in the moment between a restart,
  so a stop is never waited out until the runtime SIGKILLs the container.
- Set `OPENCODEX_CONTAINER_SUPERVISE=0` to skip the supervisor and `exec` the proxy as PID 1 instead.
  The container then stops when the proxy stops, and the dashboard's restart ends it — use your
  runtime's restart policy if you want it back.
