---
title: Deploying Clawboo
description: Run Clawboo via npx, in dev mode, or as a bundled server, covering ports, state dir, host binding, and reverse-proxy setup.
---

Use this page when you want to run the Clawboo dashboard server: locally with `npx clawboo`, from the monorepo in dev mode, or on a remote/headless box behind a reverse proxy. Clawboo is a single Express server that serves both the SPA and every `/api/*` route, plus a WebSocket proxy at `/api/gateway/ws`.

<Note>
These docs describe Clawboo **v0.3.0**, the current release.
</Note>

## Prerequisites

- **Node.js 22+** (the CLI and server both declare `engines.node >= 22`).
- For the bundled path, nothing else; the `clawboo` npm package ships the server and UI inside its `dist/`.
- For dev mode, the monorepo with `pnpm install` completed.

## At a glance

| Mode                 | Command                                                       | What runs                                                 | Where it binds                               |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------- |
| Bundled (production) | `npx clawboo`                                                 | Forks `dist/server.js` (the SPA + API), opens the browser | Loopback `127.0.0.1`, auto-port from `18790` |
| Dev                  | `pnpm dev`                                                    | Express API (watch) + Vite SPA on `:5173`, proxied        | API on the chosen port; Vite serves `:5173`  |
| Standalone server    | `node dist/server.js` (or `pnpm --filter @clawboo/web start`) | The server only, no browser, no CLI                       | Loopback by default; `HOST` widens it        |

The default bind is **loopback only** (`127.0.0.1`). A fresh install is never reachable from another host until you explicitly set `HOST` (and `HOST` alone; `HOSTNAME` is ignored, see below).

## Bundled mode: `npx clawboo`

`npx clawboo` is a thin launcher. It probes for an already-running dashboard, starts one if needed, then opens your browser at the resolved URL.

```bash
npx clawboo
```

What the launcher does, in order:

1. **Informational Gateway probe**: TCP-probes `localhost:18789` (the OpenClaw Gateway). This is a hint only; it never blocks startup.
2. **Find a running dashboard**: `findRunningDashboard()` checks, in priority order: the `CLAWBOO_API_PORT` env var, then the runtime port file (`~/.clawboo/api-port.txt`), then a scan of ports `18790`–`18809`. Each candidate is validated with an HTTP `GET /api/settings` that must return a Clawboo-shaped JSON body (both `gatewayUrl: string` and `hasToken: boolean`), so an unrelated listener in that range (Gateway aux ports, Chrome's `--remote-debugging-port`) is never mistaken for Clawboo.
3. **Start a server if none is found**: the CLI forks the bundled `dist/server.js` (located next to the CLI entry) with `NODE_ENV=production`, detached and `unref`'d. If the bundled server isn't present, it falls back to a dev-mode `npx tsx apps/web/server/index.ts` after locating the monorepo root.
4. **Poll for readiness**: it re-runs discovery every 500 ms for up to 45 seconds (a cold Windows first-boot of the bundled CJS plus the `better-sqlite3` native binding can take 20–30 s).
5. **Open the browser** at `http://localhost:<port>`.

<Tip>
If a Clawboo dashboard is already running, `npx clawboo` skips the spawn and just opens the browser to the existing instance. Run it again any time to re-open the tab.
</Tip>

### What the bundle contains

The published `clawboo` package ships everything the server needs in `dist/`:

- `dist/index.js`: the CLI launcher.
- `dist/server.js`: the single-file bundled server (Express, the API router, the SPA static host, all `@clawboo/*` libraries inlined via tsup `noExternal`).
- `dist/ui/`: the Vite build output served as the SPA.
- `dist/bin/{tasks,memory,tools,teamchat}.js`: the four MCP stdio bins (see [MCP servers](/operating/mcp-servers)). The CLI sets `CLAWBOO_MCP_BIN_DIR` to `dist/bin` on the forked server so MCP attach snippets point at them.

Runtime native dependencies kept external from the bundle, `better-sqlite3`, `ws`, `pino`, `pino-pretty`, are declared as dependencies of the `clawboo` package and installed by npm.

## Dev mode: `pnpm dev`

`pnpm dev` runs the API server and the Vite SPA together. A small orchestrator (`apps/web/scripts/dev-orchestrator.cjs`) picks a free API port **up front** and exports it as `CLAWBOO_API_PORT`, so the API and Vite agree on the port without a race:

```bash
pnpm dev
```

It prints a banner so you always know where things are:

```
[clawboo-dev] API port: 18790  ·  UI port: 5173
```

If `18790` was busy it appends `(18790 was busy — picked next free port)`. The orchestrator then runs `pnpm dev:api` (`tsx watch server/index.ts --dev`) and `pnpm dev:ui` (`vite`) concurrently. Vite serves the SPA on `:5173` and proxies `/api` (and the `/api/gateway/ws` upgrade) to the Express API on the resolved port. Vite resolves that port from `CLAWBOO_API_PORT`, then the runtime port file, then the default `18790`.

<Note>
In dev mode the server enables CORS (`cors({ origin: true })`) because the SPA origin (`:5173`) differs from the API origin. In production the SPA and API share one origin, so CORS is off.
</Note>

## Port resolution

The Express server picks its port at boot via `resolveApiPort()`, in this priority order:

| Priority | Source                     | Behavior                                                                                                                                      |
| -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `CLAWBOO_API_PORT=N`       | Use N exactly. If N is taken, **fail loudly**; an explicit choice gets no fallback.                                                           |
| 2        | `PORT=N`                   | Honored **only on production boots** (no `--dev`) and only when `CLAWBOO_API_PORT` is unset. Preserves Heroku/Render/Cloud-Run compatibility. |
| 3        | `CLAWBOO_API_PORT_START=M` | Start the auto-scan from M instead of the default.                                                                                            |
| 4        | (default)                  | Auto-scan from `18790`, trying up to 20 consecutive ports (`18790`–`18809`). Throws if all 20 are taken.                                      |

The default `18790` sits one above the OpenClaw Gateway's `18789`, in the uncommonly-used `18000–18999` range, so it sidesteps the "port 3000 is already taken" failure mode.

After a successful bind the server writes the chosen port to a **runtime port file** at `~/.clawboo/api-port.txt`. External tools (the CLI, the Vite dev proxy, e2e helpers) read this file to discover the port without scanning. The file is removed on graceful shutdown (`SIGINT`/`SIGTERM`/`exit`); a stale file is harmless because every consumer probes the port before trusting it.

<Tip>
Pin the port with `CLAWBOO_API_PORT=18790` when you want a stable URL (a reverse proxy upstream, CI, or running multiple instances on chosen ports). Two unpinned instances coexist fine; the second gets `18791`.
</Tip>

## The state directory

Clawboo owns one state directory, default `~/.clawboo`, overridable with `CLAWBOO_HOME` (`~`-expansion applies). Everything Clawboo writes lives under it:

| Path                                    | Contents                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `~/.clawboo/clawboo.db`                 | The SQLite database (registry, board, memory, tools, governance, obs, …). Relocate it with `CLAWBOO_HOME`.        |
| `~/.clawboo/settings.json`              | Gateway URL/token and the access token.                                                                           |
| `~/.clawboo/api-port.txt`               | The runtime port file (above).                                                                                    |
| `~/.clawboo/secrets/`                   | The encrypted runtime-credential vault (`master.key` + `runtime-keys.json`). See [Security](/operating/security). |
| `~/.clawboo/worktrees/`                 | Per-task git worktrees.                                                                                           |
| `~/.clawboo/proxy-device-identity.json` | The Ed25519 device key the proxy signs Gateway connects with.                                                     |

<Info>
There is **no migration ladder**. The schema is the inline `CREATE TABLE IF NOT EXISTS` DDL in `createDb`; a schema change is a hard reset of the local DB. To wipe state, stop the server and delete `~/.clawboo` (or just `~/.clawboo/clawboo.db`), then re-run onboarding.
</Info>

OpenClaw's own state dir (`~/.openclaw`, set by `OPENCLAW_STATE_DIR`) is **read-only interop**; Clawboo reads the Gateway config and a provider-key fallback from it but never writes there.

## Running standalone (no CLI)

To run just the server, for a systemd unit, a container, or a PaaS dyno:

```bash
# from a clean install of the clawboo package
CLAWBOO_UI_DIR=./dist/ui node dist/server.js

# or from the monorepo
pnpm --filter @clawboo/web start
```

In production mode the server serves the SPA from `CLAWBOO_UI_DIR` (default: the `ui/` directory next to `server.js`) via `express.static`, with a GET catch-all that returns `index.html` so client-side routing works. Two overrides matter for non-standard layouts:

| Env var               | Effect                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_UI_DIR`      | Path to the Vite build output to serve. Default: `<server.js dir>/ui`.                                          |
| `CLAWBOO_SERVER_PATH` | Used by the **CLI** to locate the monorepo root for its dev-mode fallback spawn. Not read by the server itself. |

## Behind a reverse proxy / on a remote box

By default the server binds `127.0.0.1`, so it is unreachable off-host. To expose it (a remote box, a container, behind nginx/Caddy), set `HOST`:

```bash
HOST=0.0.0.0 \
STUDIO_ACCESS_TOKEN="$(openssl rand -hex 24)" \
CLAWBOO_API_PORT=18790 \
CLAWBOO_UI_DIR=./dist/ui \
node dist/server.js
```

`resolveHost()` returns the trimmed **`HOST`** when set, otherwise loopback. A bind to `0.0.0.0`/`::` reports a browser URL of `http://localhost:<port>` in the log, but the listener accepts connections on all interfaces.

<Note>
**`HOSTNAME` is deliberately ignored.** Only `HOST` widens the bind. Docker, systemd, and many CI runners auto-inject `HOSTNAME` into every process env, so honouring it would silently expose a container that never asked to be exposed. Setting `HOSTNAME=0.0.0.0` leaves the server on loopback.
</Note>

<Warning>
A non-loopback bind **without** an access token means the server **refuses to start**: it logs a `SECURITY:` error and exits with code 1. This is deliberate; the origin guard is not authentication against a non-browser client (a LAN peer forges `Host`/`Origin` freely), so on a wide bind the access token is the only real auth.

Fix it by one of: set `STUDIO_ACCESS_TOKEN=<random>` to require a token; unset `HOST` to bind loopback only; or set `CLAWBOO_ALLOW_INSECURE=1` to run unauthenticated on purpose. Only that last escape hatch reaches the warn-and-keep-serving path.
</Warning>

When `STUDIO_ACCESS_TOKEN` is set, the access gate protects every `/api/*` route. A few load-bearing details for proxy setups:

- The token charset is restricted to `[A-Za-z0-9._~-]`. A token with any other character **disables** the gate (and logs a warning) rather than silently locking you out, so generate tokens from that set (e.g. `openssl rand -hex 24`).
- The pathname prefix check is **case-folded**; `/API/settings` cannot bypass `/api/` to reach a route unauthenticated.
- Loopback `/api/mcp/*` requests are **exempt** (a spawned runtime attaches its MCP client from `127.0.0.1` with no cookie). Non-loopback `/api/mcp/*` still requires the token.
- The gate sets `Secure` on its cookie only when the request arrived over TLS (`X-Forwarded-Proto: https`). If you terminate TLS at the proxy, forward that header so the secure-cookie path engages.

For the front-end proxy itself, forward both HTTP and the WebSocket upgrade for `/api/gateway/ws`:

```nginx
# nginx sketch — terminate TLS, forward to the loopback Clawboo server
location / {
    proxy_pass http://127.0.0.1:18790;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # WebSocket upgrade for the Gateway proxy
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Bind Clawboo to loopback and let the proxy be the only network-facing surface, **or** bind it wide and protect it with `STUDIO_ACCESS_TOKEN`, full details in [Security](/operating/security).

## Verify it worked

- Hit `GET /api/settings`; a 200 with `{ gatewayUrl, hasToken }` confirms the server is up and Clawboo-shaped.
- Hit `GET /api/health`, the boot probe report (`{ ok, degraded, fatal, checks, ... }`). `ok: true` means no fatal checks failed; the report also surfaces the resolved state dir, vault, db, and port.
- Confirm the port file exists: `cat ~/.clawboo/api-port.txt`.

## Troubleshooting

<Warning>
**`CLAWBOO_API_PORT=N is already in use`**; an explicitly pinned port gets no fallback. Free that port, pick another, or unset `CLAWBOO_API_PORT` to auto-scan.
</Warning>

<Warning>
**`npx clawboo` opens a 401 or an unrelated page.** Older launchers used a bare TCP probe and could route to the Gateway's aux ports or Chrome's debug port. The current launcher validates `GET /api/settings`, so make sure you are on a build that ships the HTTP-signature probe (v0.1.2+). If a stale `api-port.txt` points at a dead port, the launcher re-scans; delete the file if it persists.
</Warning>

<Danger>
**Deleting `~/.clawboo` deletes all Clawboo state**: the database (board, memory, registry), the encrypted vault, and worktrees. There is no migration/repair path; a delete is a clean reset that re-triggers onboarding.
</Danger>

## Related

- [Security](/operating/security), access gate, device auth, the vault, redaction, safe exposure
- [MCP servers](/operating/mcp-servers), attaching the bundled MCP bins
- [Environment variables](/reference/environment-variables), `CLAWBOO_API_PORT`, `CLAWBOO_HOME`, `CLAWBOO_UI_DIR`, `HOST`, `STUDIO_ACCESS_TOKEN`, and the rest
- [`npx clawboo` CLI reference](/reference/cli), the single command and the MCP bins
- [Configuration](/reference/configuration), `settings.json` and file locations
