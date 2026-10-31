---
title: 'Settings, health and layout API'
sidebarTitle: 'Settings and health'
description: 'REST reference for the OpenClaw Gateway connection settings, the boot report behind System Health, and the saved positions of graph nodes.'
keywords: ['misc', 'health', 'boot probe', 'system health', 'graph-layout', 'gateway url']
---

Three small surfaces: the OpenClaw Gateway connection settings, the boot report the **System Health** panel shows, and the node positions the dashboard saves for its graphs. Use this page when you point Clawboo at a Gateway from a script, or check an install's health from a monitor.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. All six routes are on the general rate limit described in the [REST API overview](/reference/rest-api/index).

## Routes

| Method | Path                  | Summary                                                          |
| ------ | --------------------- | ---------------------------------------------------------------- |
| GET    | `/api/settings`       | The Gateway URL, whether a token resolves, the first-run dismiss |
| POST   | `/api/settings`       | Save the Gateway URL, token or first-run dismiss                 |
| GET    | `/api/health`         | The latest boot report                                           |
| POST   | `/api/health/recheck` | Run the boot probe again                                         |
| GET    | `/api/graph-layout`   | Saved node positions for one graph                               |
| POST   | `/api/graph-layout`   | Save node positions for one graph                                |

## Settings

Clawboo keeps the Gateway URL, the Gateway token and the time the first-run notice was dismissed in `<clawboo home>/settings.json` (`~/.clawboo/settings.json` unless `CLAWBOO_HOME` is set). Most other dashboard settings live in the SQLite `settings` table and are not served here.

No route returns the Gateway token. The server adds it itself when it connects to the Gateway, so the browser never needs it. Errors use `{ "error": "<message>" }`.

### `GET /api/settings`

#### Responses

**`200 OK`**:

```ts
{
  gatewayUrl: string // never empty, see below
  hasToken: boolean
  firstRunDismissedAt: number | null // epoch ms, or null
}
```

`gatewayUrl` is the first of:

1. the URL saved in `settings.json`;
2. `ws://localhost:<port>`, when no token is saved and OpenClaw's `openclaw.json` has both a Gateway token and a port;
3. `ws://localhost:18789`.

`hasToken` is `true` when a Gateway token resolves: the token saved in `settings.json` (a `${VAR}` value is read from the environment, then from OpenClaw's `.env`), or else the `gateway.auth.token` in OpenClaw's `openclaw.json`. So it can be `true` with nothing saved in Clawboo. OpenClaw's files are in its state directory, `~/.openclaw` by default.

**`500 Internal Server Error`**: the settings could not be read, `{ "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/settings
```

### `POST /api/settings`

Saves only the fields you send; the rest keep their values, so a dismiss-only request leaves the Gateway URL alone. A field of the wrong type is ignored rather than rejected.

- **Request body**:

```ts
{
  gatewayUrl?: string // ws:// or wss:// on any host; '' clears the saved URL
  gatewayToken?: string // '' clears the saved token
  firstRunDismissedAt?: number // epoch ms
}
```

The URL is checked after trimming, and only a `ws:` or `wss:` URL is accepted, because the server later connects to it. After you clear it, `GET` returns the fallback above. Changing `gatewayUrl` or `gatewayToken` makes the server reconnect to the Gateway in the background.

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`400 Bad Request`**: the body is missing or not a JSON object:

```json
{ "error": "JSON body required" }
```

**`400 Bad Request`**: a non-empty `gatewayUrl` that is not a `ws://` or `wss://` URL:

```json
{ "error": "gatewayUrl must be a ws:// or wss:// URL" }
```

**`500 Internal Server Error`**: saving failed, `{ "error": "<message>" }`.

#### Example

```bash
# Point Clawboo at a Gateway
curl -X POST http://localhost:18790/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"gatewayUrl":"ws://localhost:18789","gatewayToken":"<token>"}'

# Record the first-run dismiss only
curl -X POST http://localhost:18790/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"firstRunDismissedAt":1761650000000}'
```

## Health

The server runs a boot probe at startup and keeps the result: one pass or fail per check, plus what the install resolved (folders, port, vault). The **System Health** panel shows it. These routes answer with the Gateway down, and `ok` (`true` when no check is fatal) is the one field a monitor needs.

Responses pass through the same redaction as the logs, so a credential-shaped string inside a check's message is masked. On failure the health routes answer `{ "ok": false, "error": "<message>" }`.

### `GET /api/health`

Returns the latest boot report. A request that arrives before the first report exists computes one.

#### Responses

**`200 OK`**: the boot report (see [The boot report](#the-boot-report) below), with `ok` added. Dates are ISO strings.

**`500 Internal Server Error`**: computing a first report failed, `{ "ok": false, "error": "<message>" }`.

#### Example

```bash
curl http://localhost:18790/api/health
```

### `POST /api/health/recheck`

Runs the boot probe again: the **Re-run probe** button in System Health. When the Gateway cannot be reached, the answer waits out the Gateway check, about 1.5 seconds. Takes no body.

#### Responses

**`200 OK`**: the new boot report, the same shape as `GET /api/health`.

**`500 Internal Server Error`**: `{ "ok": false, "error": "<message>" }`.

#### Example

```bash
curl -X POST http://localhost:18790/api/health/recheck
```

### The boot report

```ts
interface BootReport {
  ok: boolean // true when fatal is empty
  startedAt: string // ISO date
  finishedAt: string
  checks: Array<{
    id: string
    ok: boolean
    message: string // short status
    detail?: string // longer detail, when there is any
    durationMs: number
  }>
  degraded: string[] // ids of failed checks the server runs without
  fatal: string[] // ids of failed checks nothing works without
  config: {
    logLevel: string
    budgetPosture: string
    budgetHardCapUsdCents: number | null
    budgetWarnSoftPct: number
    otelEnabledByDefault: boolean
    otelActive: boolean
  }
  resolved: {
    clawbooHome: string
    dbPath: string
    apiPort: number | null
    stateDir: string // OpenClaw's state directory
    vaultPresent: boolean // the encrypted vault file, secrets/runtime-keys.json, exists
    masterKeyOk: boolean
  }
}
```

Most failures only degrade: the server keeps running and the panel shows a warning, so a degraded install still answers `ok: true` with a non-empty `degraded`. Three failures are fatal: `clawbooHomeWritable`, `databaseIntegrity` and `databaseSchema`. Each failed check's `detail` says what to do; resetting the Clawboo home folder is the last resort (see [Data and state](/operating/data-and-state)).

The checks, in the order they run:

| `id`                       | What it checks                                                                                                                                                                                                                                             | Fatal   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `clawbooHomeWritable`      | The Clawboo home folder exists (it is created if missing) and is writable                                                                                                                                                                                  | **Yes** |
| `vaultPerms`               | `secrets/`, the master key and `proxy-device-identity.json` give no access to group or others. Passes on Windows, and before any of them exist                                                                                                             | No      |
| `masterKeyBootSentinel`    | A value encrypted on first boot still decrypts, so the master key has not changed. When it fails, saved runtime keys cannot be read                                                                                                                        | No      |
| `databaseIntegrity`        | SQLite's `PRAGMA integrity_check` returns `ok`                                                                                                                                                                                                             | **Yes** |
| `databaseSchema`           | The core tables exist and no column the schema declares is missing                                                                                                                                                                                         | **Yes** |
| `apiPortFileMatches`       | The api-port file holds the port the server listens on. Passes without checking when the probe runs before the server has a port                                                                                                                           | No      |
| `mcpServersHealthy`        | Each built-in MCP server (Tasks, Memory, Tools, TeamChat) can be built and lists its tools                                                                                                                                                                 | No      |
| `openclawGatewayReachable` | The server's Gateway connection comes up within 1.5 seconds. It always runs, because a Gateway URL always resolves, so an install without OpenClaw lists it in `degraded` while `ok` stays `true`; the server then serves the agents last synced to SQLite | No      |
| `otelExporterReachable`    | With an OTLP endpoint set, the OpenTelemetry exporter started. With none set, it passes                                                                                                                                                                    | No      |

`config` reports the defaults this build ships, not live overrides: `logLevel` reads `info` even when `LOG_LEVEL` is set. Only `otelActive` reflects this boot.

| Field                   | Shipped value      | Meaning                                                                                    |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `logLevel`              | `"info"`           | The default log level                                                                      |
| `budgetPosture`         | `"track-and-warn"` | Spend is tracked and warned about; nothing pauses unless you set a budget in hard-cap mode |
| `budgetHardCapUsdCents` | `null`             | No install-wide hard cap                                                                   |
| `budgetWarnSoftPct`     | `80`               | A budget warns at 80% of its limit                                                         |
| `otelEnabledByDefault`  | `false`            | OpenTelemetry export is opt-in                                                             |
| `otelActive`            | this boot          | `true` when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set   |

## Graph layout

The node positions the dashboard saves when you drag nodes on a graph, stored in the SQLite `graph_layouts` table under a pair of keys: a layout `name` and a Gateway URL. The URL is only part of the storage key: when the dashboard runs without a Gateway, it saves under `''`. Errors on `POST` use `{ "ok": false, "error": "<message>" }`.

| `name`                        | Graph                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas-radial`                | The Org chart in its radial layout (`atlas` is the Org chart's internal name)                                                                              |
| `atlas-top-down`              | The Org chart in its tree layout; each layout keeps its own positions                                                                                      |
| `team-<teamId>`               | A team's **Team graph**                                                                                                                                    |
| `team-<teamId>-room-<roomId>` | A room's **Room graph**, kept apart from the team's                                                                                                        |
| `default`                     | The team graph when no team is selected                                                                                                                    |
| `loose-<canvas>`              | Skills and connectors placed on a graph with **+** and not yet attached to an agent: `loose-atlas` on the Org chart, `loose-team-<teamId>` on a team graph |

In a `loose-` layout the position keys are node ids such as `loose:skill:web-search`.

### `GET /api/graph-layout`

The query parameter for the Gateway URL is `url`, not `gatewayUrl`.

- **Query params**:

| Param  | Type   | Default     | Notes                                      |
| ------ | ------ | ----------- | ------------------------------------------ |
| `name` | string | `'default'` | The layout name                            |
| `url`  | string | `''`        | The Gateway URL the layout was saved under |

#### Responses

**`200 OK`**: the saved layout, or no positions when nothing is saved:

```ts
{
  positions: Record<string, { x: number; y: number }>
}
```

This route never answers an error: a database failure also returns `{ "positions": {} }`.

#### Example

```bash
curl "http://localhost:18790/api/graph-layout?name=team-<team-id>&url="
```

### `POST /api/graph-layout`

Creates or replaces the positions for one layout. The positions are stored as sent.

- **Request body**:

```ts
{
  name?: string // default 'default'
  positions: Record<string, { x: number; y: number }>
  gatewayUrl: string // required; '' is allowed
}
```

#### Responses

**`200 OK`**: `{ "ok": true }`.

**`400 Bad Request`**: the body is not a JSON object:

```json
{ "ok": false, "error": "invalid JSON" }
```

**`400 Bad Request`**: `gatewayUrl` is missing or not a string:

```json
{ "ok": false, "error": "gatewayUrl required" }
```

**`500 Internal Server Error`**: `{ "ok": false, "error": "<message>" }`.

#### Example

```bash
curl -X POST http://localhost:18790/api/graph-layout \
  -H 'Content-Type: application/json' \
  -d '{"name":"team-<team-id>","gatewayUrl":"","positions":{"boo-a1":{"x":120,"y":40}}}'
```

**Source of truth:** `apps/web/server/api/settings.ts` with `packages/config/src/index.ts` (settings resolution), `apps/web/server/api/health.ts` with `apps/web/server/lib/bootProbe.ts` and `lib/defaults.ts`, and `apps/web/server/api/graphLayout.ts`.

## Related

- [System Health](/using/system-health): the panel over the boot report
- [Configuration](/reference/configuration): `settings.json` and the other files in the Clawboo home folder
- [Environment variables](/reference/environment-variables): `CLAWBOO_HOME`, `LOG_LEVEL` and the OpenTelemetry variables
- [System API](/reference/rest-api/system): installing, configuring and starting the OpenClaw Gateway
- [Org chart](/using/org-chart): the graphs whose positions these routes save
