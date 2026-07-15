---
title: '@clawboo/control-client'
description: 'The framework-agnostic REST/SSE client for the Clawboo control plane: a configurable base URL and header seam so the SPA and a future desktop, mobile, or npm client share one client.'
---

- **Version** `0.1.0`
- **Purity** browser-safe (`fetch` / `ReadableStream` / `TextDecoder`; no `node:*`)
- **Purpose** One typed client for the Clawboo control plane (config, SSE, runtimes, providers, agents, onboarding), with a base-URL and auth-header seam so the same client serves the same-origin SPA and a remote-host thin client.
- **Workspace deps** `@clawboo/agent-registry` (types only)
- **External deps** none

Extracted so the dashboard does not hard-code `fetch('/api/...')` in dozens of components. Every call routes through `apiFetch`, which resolves the base URL and injects headers. **The web app calls neither setter**: with no base set, requests stay same-origin and behave byte-identically to the inline `fetch` calls this package replaced. A desktop, mobile, or npm client instead calls `setApiBase(url)` and `setRequestHeaderProvider(fn)` once at startup and reuses everything else unchanged.

This package absorbed the deleted `lib/sseClient.ts`, `lib/runtimesClient.ts`, and `lib/onboardingClient.ts`.

<Note>
The two Zustand-coupled helpers (`refreshFleetFromRegistry`, `agentRecordToFleetState`) deliberately stay in `apps/web/src/lib/agentSourceClient.ts`. They hydrate the SPA's fleet store, and a framework-agnostic package cannot own React or Zustand state.
</Note>

## Public API

### Configuration (`config.ts`)

The seam every other module routes through.

| Signature                                            | Contract                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `setApiBase(url: string): void`                      | Target a remote server. Unset (the web default) means same-origin.                                                                     |
| `getApiBase(): string`                               | The current base (empty string when same-origin).                                                                                      |
| `setRequestHeaderProvider(fn: HeaderProvider): void` | Inject auth / tenant headers on every request. A no-op in single-tenant today; pairs with the server auth-middleware and tenant seams. |
| `getRequestHeaders(): Record<string, string>`        | The headers the provider currently returns.                                                                                            |
| `apiUrl(path: string): string`                       | Resolve an `/api/...` path against the base.                                                                                           |
| `apiFetch(path, init?): Promise<Response>`           | Base- and header-aware `fetch`. Per-call `init.headers` win over the provider's.                                                       |
| `resetControlClient(): void`                         | Clear the base and header provider (tests).                                                                                            |

### Server-Sent Events (`sse.ts`)

| Signature                                             | Contract                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumeSSE(url, options, handlers): AbortController` | The base-agnostic primitive: `fetch` + `ReadableStream` + `TextDecoder`, parsing `data: {...}\n\n` frames and routing a typed `SSEEvent` to `onProgress` / `onOutput` / `onComplete` / `onError`. Returns a controller for cancellation. |
| `consumeApiSSE(path, options, handlers)`              | The base- and header-aware wrapper for `/api/...` paths. **Prefer this**, so a thin client streaming from a remote host works unchanged.                                                                                                 |

### Runtimes (`runtimes.ts`)

Defensive (never-throw, typed) wrappers: `fetchRuntimes`, `recheckRuntime`, `installRuntime` (SSE), `connectRuntime`, `healthcheckNativeKey`, `disconnectRuntime`.

Owns the connectable **`RuntimeId`** union (`'claude-code' | 'codex' | 'hermes' | 'clawboo-native'`), which `features/runtimes/runtimeCatalog.ts` re-exports so client and catalog share one definition. This is deliberately narrower than `@clawboo/agent-registry`'s open-set `RuntimeId`.

### Providers (`providers.ts`)

`fetchProviders`, `connectProvider`, `disconnectProvider`, `fetchProviderModels` (stored key), `fetchProviderModelsWithKey` (a pasted, unsaved key, for onboarding).

### Agents (`agents.ts`)

The AgentSource REST wrappers: `listAgents`, `getAgentRecord`, `createAgentRecord`, `archiveAgentRecord`, `readAgentFile`, `writeAgentFile`, `setAgentModel`, `listAgentSessions`, `pushAgentSync`, `fetchRegistryHealth`.

### Onboarding (`onboarding.ts`)

`seedNativeTeam`, `setNativeLeaderModel`, and `fetchOnboardingState` (the aggregated first-run signals in one call; returns a defensive all-false "fresh install" shape on any error).

## Used by

- **`apps/web` (SPA)**; ~35 consumers across onboarding, the Runtimes and Providers panels, the fleet, and agent detail. The web app sets no base and no header provider, so it stays same-origin.

## Source

Barrel: [`packages/control-client/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/control-client/src/index.ts) (re-exports `./config`, `./sse`, `./runtimes`, `./providers`, `./agents`, `./onboarding`).

## See also

- [`@clawboo/agent-registry`](/reference/packages/agent-registry), the record types this client returns
- [Runtimes API](/reference/rest-api/runtimes), the endpoints it calls
- [Agents API](/reference/rest-api/agents)
- [Seams](/internals/seams), the thin-client and multi-tenant seams
- [Package overview](/reference/packages/index)
