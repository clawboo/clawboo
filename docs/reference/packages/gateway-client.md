---
title: "@clawboo/gateway-client"
description: WebSocket client for the OpenClaw Gateway: typed RPC, event subscription, reconnect, and Ed25519 device auth.
---

|                    |                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.1`                                                                                                                                                                                       |
| **Purity**         | browser-safe (the `ws` dep is for Node injection only; see `webSocketImpl`)                                                                                                                   |
| **Purpose**        | A WebSocket client for the OpenClaw Gateway: UUID-keyed request/response correlation, event subscription, reconnect lifecycle, and a typed RPC surface for agents / sessions / config / chat. |
| **Workspace deps** | `@clawboo/logger`                                                                                                                                                                             |
| **External deps**  | `@noble/ed25519`, `ws`                                                                                                                                                                        |

The client owns reconnection after a connection that opened then dropped (`800 ms → 15 s` backoff). It negotiates the OpenClaw connect protocol (`minProtocol: 3, maxProtocol: 4`) and signs the connect frame with Ed25519 device auth in the browser (via `crypto.subtle`), or through an injected `signConnect` hook for Node callers. The `device-auth` module is internal and not re-exported.

## Public API

### Classes

| Export          | Signature             | Contract                                                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GatewayClient` | `new GatewayClient()` | The WS client. Lifecycle: `connect(url, opts?)` / `disconnect()`. RPC: `call<T>(method, params?, timeoutMs = 60_000)`. Subscriptions: `onStatus(handler)`, `onEvent(handler)`, `on(event, handler)` (each returns an unsubscribe fn). Getter `status`; `getLastHello()`. Typed namespaces `agents` / `sessions` / `config` / `chat` (below). |

`GatewayClient` typed RPC namespaces (instance fields, not separate exports):

| Member              | Signature                                                        | Contract                                                                                                                               |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.list`       | `() => Promise<AgentsListResult>`                                | RPC `agents.list`.                                                                                                                     |
| `agents.create`     | `(config: AgentCreateConfig) => Promise<AgentCreateResult>`      | RPC `agents.create` with a 2-minute timeout (the Gateway resolves the default model, which can be slow on Windows).                    |
| `agents.delete`     | `(id: string) => Promise<void>`                                  | RPC `agents.delete` with param `{ agentId: id }`.                                                                                      |
| `agents.files.read` | `(agentId, name) => Promise<string>`                             | Calls RPC `agents.files.get`; returns `res.file.content` or `''` when missing.                                                         |
| `agents.files.set`  | `(agentId, name, content) => Promise<void>`                      | RPC `agents.files.set`, 2-minute timeout.                                                                                              |
| `sessions.list`     | `(agentId: string) => Promise<Session[]>`                        | RPC `sessions.list`.                                                                                                                   |
| `sessions.send`     | `(agentId, message) => Promise<void>`                            | RPC `sessions.send`, delivers a message to the agent's main session.                                                                   |
| `sessions.patch`    | `(key, updates) => Promise<SessionPatchResult>`                  | RPC `sessions.patch` (model / thinkingLevel / execHost / execSecurity / execAsk).                                                      |
| `sessions.abort`    | `(key, runId?) => Promise<{ ok; abortedRunId?; status? }>`       | Heavy session-level abort; `runId` optional (Gateway resolves the active run from `key`). `status: 'no-active-run'` is a benign no-op. |
| `config.get`        | `() => Promise<GatewayConfig>`                                   | RPC `config.get`.                                                                                                                      |
| `config.patch`      | `(updates: Partial<GatewayConfig>, baseHash?) => Promise<void>`  | RPC `config.patch`, wire-encoded via `encodeConfigPatchParams` (`{ raw, baseHash }`).                                                  |
| `chat.abort`        | `(sessionKey, runId) => Promise<{ ok; abortedRunId?; status? }>` | Surgical per-run cancel, the Stop-button primitive.                                                                                    |

### Functions

| Export                           | Signature                                                                            | Contract                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseGatewayFrame`              | `(raw: string) => Frame \| null`                                                     | `JSON.parse` a wire frame; returns `null` on parse failure.                                                                                                                         |
| `buildAgentMainSessionKey`       | `(agentId: string, mainKey: string) => string`                                       | Builds `agent:<agentId>:<mainKey>` (defaults `mainKey` to `'main'` when blank).                                                                                                     |
| `parseAgentIdFromSessionKey`     | `(sessionKey: string) => string \| null`                                             | Extracts the agent id from an `agent:<id>:` key; `null` on no match.                                                                                                                |
| `isSameSessionKey`               | `(a: string, b: string) => boolean`                                                  | True when both trim to the same non-empty string.                                                                                                                                   |
| `isGatewayDisconnectLikeError`   | `(err: unknown) => boolean`                                                          | True for "gateway not connected"/"client stopped" messages or a `Gateway closed (1012)` reason.                                                                                     |
| `isAuthError`                    | `(msg: string \| null) => boolean`                                                   | Heuristic: true when the message reads as auth / unauthorized / forbidden / invalid-token / token-missing.                                                                          |
| `resolveProxyGatewayUrl`         | `() => string`                                                                       | Same-origin `ws(s)://<host>/api/gateway/ws`; falls back to `ws://localhost:18790/api/gateway/ws` when `window` is undefined (SSR/Node).                                             |
| `isLocalGatewayUrl`              | `(url: string) => boolean`                                                           | True when the URL host is `localhost` / `127.0.0.1` / `::1` / `0.0.0.0`.                                                                                                            |
| `encodeConfigPatchParams`        | `(updates: Partial<GatewayConfig>, baseHash?: string) => { raw: string; baseHash? }` | Encodes a partial config into OpenClaw 2026.5.x's `config.patch` envelope: `raw` = `JSON.stringify(updates)`, optional optimistic-concurrency `baseHash` from a prior `config.get`. |
| `formatGatewayError`             | `(error: unknown) => string`                                                         | Renders an error for display; `GatewayResponseError` → `Gateway error (<code>): <message>` (adds a `doctor --fix` hint on invalid-config).                                          |
| `resolveGatewayAutoRetryDelayMs` | `(params: AutoRetryDelayParams) => number \| null`                                   | Auto-reconnect backoff (`2s × 1.5^attempt`, capped 30s, max 20 attempts); `null` to stop on manual disconnect / non-retryable code / auth error.                                    |
| `syncGatewaySessionSettings`     | `(params: SyncSessionSettingsParams) => Promise<SessionPatchResult>`                 | Builds a `sessions.patch` payload from the provided settings (at least one required) and calls it through the injected `GatewayClientLike`.                                         |

### Types & interfaces

| Export                      | Kind      | Contract                                                                                                                                                                                                                                     |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReqFrame`                  | type      | Request frame: `{ type: 'req'; id; method; params }`.                                                                                                                                                                                        |
| `ResFrame`                  | type      | Response frame: `{ type: 'res'; id; ok; payload?; error? }`.                                                                                                                                                                                 |
| `EventFrame`                | type      | Event frame: `{ type: 'event'; event; payload?; seq?; stateVersion? }`.                                                                                                                                                                      |
| `Frame`                     | type      | `ReqFrame \| ResFrame \| EventFrame`.                                                                                                                                                                                                        |
| `GatewayStateVersion`       | type      | `{ presence: number; health: number }`.                                                                                                                                                                                                      |
| `GatewayHelloOk`            | type      | The `hello-ok` connect response: protocol, features, snapshot, auth (deviceToken/role/scopes), policy.                                                                                                                                       |
| `AgentStatus`               | type      | `'idle' \| 'running' \| 'error' \| 'sleeping'`.                                                                                                                                                                                              |
| `Agent`                     | interface | `{ id; name; status?; sessionKey?; model?; createdAt? }`.                                                                                                                                                                                    |
| `AgentListEntry`            | interface | `{ id; name?; identity? }` (identity carries theme/emoji/avatar).                                                                                                                                                                            |
| `AgentsListResult`          | interface | `{ defaultId; mainKey; scope?; agents: AgentListEntry[] }`.                                                                                                                                                                                  |
| `AgentCreateConfig`         | interface | `{ name; workspace }`, the only fields `agents.create` accepts.                                                                                                                                                                              |
| `AgentCreateResult`         | interface | `{ agentId; name; workspace? }`.                                                                                                                                                                                                             |
| `Session`                   | interface | `{ key; agentId; createdAt?; updatedAt? }`.                                                                                                                                                                                                  |
| `GatewayConfig`             | interface | `{ path?; gateway?: { url?; token? }; [key: string]: unknown }`, loose; mirrors the on-disk config.                                                                                                                                          |
| `ConnectionStatus`          | type      | `'disconnected' \| 'connecting' \| 'connected' \| 'reconnecting'`.                                                                                                                                                                           |
| `GatewayDeviceField`        | interface | Signed device fields on a connect frame: `{ id; publicKey; signature; signedAt; nonce? }`.                                                                                                                                                   |
| `ConnectOptions`            | interface | Connect args: `clientName?`, `clientVersion?`, `token?`, `password?`, `authScopeKey?`, `disableDeviceAuth?`, `platform?`, `mode?`, `instanceId?`, `signConnect?` (Node device-auth hook), `origin?` (Node-only WS Origin), `webSocketImpl?`. |
| `WebSocketLikeCtor`         | type      | `new (url: string, options?: { origin?: string }) => WebSocket`, a constructor compatible with both the DOM global and the `ws` package.                                                                                                     |
| `SessionPatchResult`        | type      | `{ ok: true; key; entry?; resolved? }`.                                                                                                                                                                                                      |
| `GatewayClientLike`         | type      | `{ call<T>(method, params?): Promise<T> }`, the minimal forward-reference used by helper params.                                                                                                                                             |
| `SyncSessionSettingsParams` | type      | Input for `syncGatewaySessionSettings`: `{ client; sessionKey; model?; thinkingLevel?; execHost?; execSecurity?; execAsk? }`.                                                                                                                |
| `AutoRetryDelayParams`      | type      | Input for `resolveGatewayAutoRetryDelayMs`: `{ status; didAutoConnect; wasManualDisconnect; gatewayUrl; errorMessage; connectErrorCode; attempt }`.                                                                                          |
| `GatewayErrorPayload`       | type      | `{ code; message; details?; retryable?; retryAfterMs? }`.                                                                                                                                                                                    |

### Errors

| Export                 | Kind  | Contract                                                                                                                                                                                                      |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GatewayResponseError` | class | `extends Error`; constructed from a `GatewayErrorPayload`. Exposes read-only `code`, `details?`, `retryable?`, `retryAfterMs?`. SPA code branches on `err.code === 'NOT_PAIRED'` for the device-pairing flow. |

<Note>
The package exports no runtime constants from its barrel. The connect protocol range (`minProtocol: 3, maxProtocol: 4`), retry constants, and close codes are private to `client.ts` / `helpers.ts`.
</Note>

## Used by

- `apps/web/src/stores/connection.ts`, holds the live `GatewayClient` instance (`ConnectionStatus` superset adds an `'error'` state).
- `apps/web/src/features/connection/{GatewayBootstrap,GatewayConnectScreen,useGatewayEvents}.tsx?`, connect/reconnect lifecycle and event subscription; `GatewayResponseError.code` drives the `NOT_PAIRED` pairing branch.
- `apps/web/server/lib/agentSource/registry.ts`, the server-side `OpenClawAgentSource` connection injects `WebSocketLikeCtor` + `signConnect` for Node device auth.
- `apps/web/server/lib/capabilitySource/openclaw.ts`, uses `encodeConfigPatchParams` for the `config.patch` envelope.
- `packages/events/src/{index,bridge,types}.ts`, consumes the `EventFrame` / `AgentStatus` / `ConnectionStatus` types in the Bridge → Policy → Handler pipeline.
- `packages/adapters/openclaw/src/{adapter,mapFrame,types}.ts`, maps `EventFrame` / `AgentsListResult` / `SessionPatchResult` into the normalized `RuntimeEvent` stream.

## Source

Barrel: [`packages/gateway-client/src/index.ts`](https://github.com/clawboo/clawboo/tree/main/packages/gateway-client/src/index.ts). Modules: `types.ts` (frame + domain + connect types), `errors.ts` (`GatewayResponseError`), `client.ts` (the `GatewayClient` class), `helpers.ts` (frame/session/url/error/retry helpers). `device-auth.ts` is internal and not re-exported.

## See also

- [Gateway & events pipeline](/concepts/gateway-and-events), how frames flow Bridge → Policy → Handler.
- [@clawboo/events](/reference/packages/events), the consumer that turns `EventFrame`s into store mutations.
- [@clawboo/adapter-openclaw](/reference/packages/adapter-openclaw), the RuntimeAdapter wrapping this client.
- [@clawboo/gateway-proxy](/reference/packages/gateway-proxy), the same-origin WS proxy + the `signConnectParams` server wires to `signConnect`.
- [OpenClaw runtime](/runtimes/openclaw), device pairing and channels.
