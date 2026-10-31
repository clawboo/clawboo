---
title: 'Gateway client and proxy'
sidebarTitle: 'gateway-client'
description: 'The OpenClaw Gateway client, the server-side proxy and device identity, the optional access gate, and the always-on Origin and Host guard.'
keywords:
  [
    '@clawboo/gateway-client',
    '@clawboo/gateway-proxy',
    'gateway-client',
    'gateway-proxy',
    'GatewayClient',
    'device identity',
    'access gate',
    'STUDIO_ACCESS_TOKEN',
    'origin guard',
    'CLAWBOO_ALLOWED_ORIGINS',
    'CLAWBOO_ALLOWED_HOSTS',
    'exec approvals',
  ]
---

Two packages carry Clawboo's connection to an OpenClaw Gateway and guard the dashboard's own front door.
`@clawboo/gateway-client` is the WebSocket client the SPA and the server use to talk to a Gateway.
`@clawboo/gateway-proxy` is its server half: the same-origin WebSocket proxy the browser connects through, the
device identity that signs the Gateway handshake, the optional access gate and the always-on Origin and Host
guard.

Use this page when you change how Clawboo talks to OpenClaw or touch dashboard access control. The operator's
view of the same controls is on [Security model](/operating/security).

<Note>

The Ed25519 device identity only proves this Clawboo install to the OpenClaw Gateway. Who may open the dashboard
is decided by the access gate (off unless `STUDIO_ACCESS_TOKEN` is set) and the Origin and Host guard.

</Note>

## The Gateway client

`GatewayClient` connects to a Gateway, correlates requests and responses, delivers event frames to `onEvent`
subscribers, and reconnects with backoff when a connection that was open drops. `call(method, params)` sends any
RPC, and typed groups cover the common ones: `agents` (list, create, files), `sessions`, `config` and `chat`.

`connect(url, options)` negotiates OpenClaw's protocol range and takes these options:

- `token` or `password` for the Gateway's own auth.
- `caps`, the capabilities the connection declares. The default, `GATEWAY_BROWSER_CAPS`, declares exec approvals.
  The server's own connection declares `tool-events` and `exec-approvals`.
- `signConnect`, for a caller that signs the connect frame with its own identity, and `webSocketImpl` and
  `origin`, for a caller outside the browser. The server passes the `ws` package's constructor and the Gateway
  host as the origin.
- `disableDeviceAuth`. The client can sign the connect frame itself in a secure browser context, with an Ed25519
  key kept in `localStorage`, but the dashboard turns that off because the proxy signs for it.

`GatewayResponseError` carries the Gateway's error code (the pairing flow keys off `NOT_PAIRED`), and
`isAuthConnectError` and `authRetryAfterMs` tell a caller whether and when to retry an auth failure.

The package is browser-safe: it uses the global `WebSocket` and never imports `ws`, although its manifest still
lists it. The SPA uses it for the live connection, events and the pairing flow. On the server it backs the shared
Gateway connection in `apps/web/server/lib/agentSource/registry.ts`, the OpenClaw capability source, and the
Permissions tab routes. `@clawboo/events` and `@clawboo/adapter-openclaw` import its types.

## Exec approvals

The Gateway keeps every agent's exec posture and its standing command grants in one fleet-wide document, reachable
only through `exec.approvals.get` and `exec.approvals.set`. The package's exec helpers follow four rules, and any
new code that touches the document must too:

- **Treat `exec.approvals.get` as a write.** The Gateway re-saves the document when it answers, and an unparseable
  stored document would be replaced with a fail-closed default for every agent. Code that only reads grants reads
  OpenClaw's stored row directly and read-only, as `openclawExecAllowlistRead.ts` does.
- **Write under compare-and-swap.** `mutateExecApprovalsDoc(client, mutate)` reads the document, applies `mutate`,
  and writes it back against the base hash, re-running `mutate` on a fresh read after a conflict.
  `upsertExecApprovalPolicy` uses it to set one agent's posture while keeping its grants.
- **Filter rows, never rebuild them.** A grant that loses its `argPattern` in a round trip stops matching the
  command it was made for. `revokeExecAllowlistEntries` removes rows by content fingerprint
  (`execAllowlistEntryKey`), refuses a row that also lives in the wildcard bucket, and checks the Gateway's
  post-write reply before it reports `revoked`.
- **Patch sessions with `execHost` only.** OpenClaw refuses the retired `execSecurity` and `execAsk` session fields,
  so `resolveExecPatchParams()` returns only `execHost`.

`classifyExecAllowlistEntry`, `isEffectiveExecGrant` and `affectsEnforcement` say what one stored row means. The user
side is [Review and revoke command permissions](/using/command-permissions).

## The proxy and device identity

`createGatewayProxy({ loadUpstreamSettings })` serves the WebSocket at `/api/gateway/ws`. The browser opens a
same-origin socket, and the proxy opens the upstream Gateway connection for it, fills in the Gateway token and a
device signature on the `connect` frame, and then forwards frames both ways with a bounded buffer and a keepalive.
The browser never sees the Gateway token.

`loadOrCreateProxyDeviceIdentity()` keeps one Ed25519 keypair in `proxy-device-identity.json` in Clawboo's state
folder, with the folder limited to your user and the file re-tightened on every load. `signConnectParams` signs a
connect frame with it. The server's own Gateway connection reuses the same identity through the client's
`signConnect` hook, so the dashboard and the server count as one paired device.

## The access gate

`createAccessGate({ token, basePath, authorizeRuntime })` is off unless `STUDIO_ACCESS_TOKEN` is set. When it is on:

- Opening the dashboard with `?access_token=<token>` sets an HttpOnly `clawboo_access` cookie, scoped to the base
  path and marked `Secure` over TLS, then redirects to remove the token from the address bar.
- Every `/api/*` request and every Gateway WebSocket upgrade needs that cookie. The comparison is constant-time,
  and the path check ignores case.
- The one exception is an `/api/mcp/*` call from a runtime the server started. `authorizeRuntime` admits it only
  when it carries a valid attach token, came straight to the loopback port, and was not forwarded.
  `isForwardedRequest` looks for `Forwarded`, `X-Forwarded-*` and `X-Real-IP`, and those headers can only take
  access away.

A token with a character outside `A-Z a-z 0-9 . _ ~ -` turns the gate off with a console warning instead of
breaking the cookie. A non-loopback bind still refuses to start without a working gate, unless
`CLAWBOO_ALLOW_INSECURE=1`, but a loopback server behind a same-host reverse proxy would then be open. Generate the
token with `openssl rand -hex 24`. When a forwarded request reaches a server with no token, the server logs a
one-time warning (`proxyExposureWarning.ts`).

## The Origin and Host guard

`createOriginGuard({ port, bindHost, allowedOrigins, allowedHosts })` runs on every `/api/*` request and WebSocket
upgrade, whether or not the access gate is on. It closes cross-site WebSocket hijacking, DNS rebinding and
cross-site requests on a default install with no configuration. A request passes when:

- its `Host` is a loopback name, the bind host, or listed in `CLAWBOO_ALLOWED_HOSTS`;
- its `Origin`, when present, is a loopback origin on the API port, the bind host, the Vite dev server in
  development, or listed in `CLAWBOO_ALLOWED_ORIGINS`;
- its `Sec-Fetch-Site`, when present, is `same-origin`, `same-site` or `none`.

Anything else gets `403` with `Cross-origin request blocked.` The two environment lists only widen the allowed
set, so a reverse proxy or a LAN address must be listed in them. The guard is not authentication: a non-browser
client can send any headers it likes, which is why a non-loopback bind needs the access gate.

## Test it

Run `pnpm --filter @clawboo/gateway-client test` and `pnpm --filter @clawboo/gateway-proxy test`. The dashboard's
end-to-end suite runs against a mock Gateway; see [Testing strategy](/internals/testing).

## Related

- [Security model](/operating/security): the access model, tokens and safe exposure.
- [Reach Clawboo from another machine](/guides/self-host-securely): tunnels, proxies and the environment lists in
  practice.
- [Gateway connection internals](/internals/gateway-and-events): how Gateway frames flow into the dashboard.
- [OpenClaw](/runtimes/openclaw): pairing, the Gateway connection and OpenClaw setup.
- [@clawboo/mcp](/reference/packages/mcp): the attach token the access gate checks.
