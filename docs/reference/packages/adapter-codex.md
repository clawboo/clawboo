---
title: '@clawboo/adapter-codex'
description: Codex RuntimeAdapter that maps the codex exec event stream into the normalized executor event stream.
---

|                    |                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.0`                                                                                                                                                                                                                             |
| **Purity**         | pure (deps: `@clawboo/executor` only; no Node/spawn imports, the heavy `codex exec` driver lives server-side)                                                                                                                       |
| **Purpose**        | The Codex [`RuntimeAdapter`](/internals/runtime-adapter): boots a run, maps each native `codex exec --json` frame into the normalized `RuntimeEvent` union, and delegates abort/setModel/writeContext to a per-run injected driver. |
| **Workspace deps** | `@clawboo/executor`                                                                                                                                                                                                                 |
| **External deps**  | none (runtime) · `tsup`, `typescript`, `vitest`, `@clawboo/tsconfig` (dev)                                                                                                                                                          |

This package is the contract-testable shell. It does **not** spawn `codex`, a fresh `CodexDriver` is minted per run via the injected `driverFactory`, and the real driver (`createCodexDriver`) lives in `apps/web/server/lib/runtimes/`. Same shape as the Claude Code adapter (per-run injected driver, eager subscribe, late-bound runId); the two Codex realities, **no USD cost** and **thread-id resume**, live entirely in `mapCodexEvent` and the driver, so the trait surface is identical.

## Public API

All exports come from `src/index.ts`. The package declares a single `.` export in `package.json` (no subpath barrels).

### Classes

| Export         | Signature                                      | Contract                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodexAdapter` | `class CodexAdapter implements RuntimeAdapter` | The adapter. Constructed with `(driverFactory: CodexDriverFactory, healthCheck?: () => Promise<HealthResult>)`. `id = 'codex'`, `participantKind = 'agent'`. Holds a per-run driver map keyed by `sessionKey`. |

**`CodexAdapter` members:**

- `capabilities(): Capabilities`, returns `{ streaming: true, mcp: true, worktrees: true, resume: true, toolApproval: true, models: ['gpt-5-codex','gpt-5','o4-mini'], runtimeClass: 'wrapped-oneshot', nativeHome: { scope: 'per-run', persist: false }, nativeSkills: 'none', nativeMemory: 'none', nativeChannels: 'none', nativeScheduler: false }`. `nativeHome` declares a throwaway per-run `CODEX_HOME` (the driver mkdtemps one each run), no cross-run self-improvement substrate to preserve. There is no `sessionCodec` and no `contextWindowTokens`.
- `health(): Promise<HealthResult>`, races the injected `healthCheck` against a 2 s timeout (`{ ok: false, message: 'health check timed out' }` on timeout); any throw → `{ ok: false, message }`.
- `start(_task: TaskHandle, opts: StartOpts): Promise<RunHandle>`, mints a driver via `driverFactory(opts)`, stores it by `opts.sessionKey`, calls `driver.start()`, returns `{ adapterId: 'codex', sessionKey, runId: null }`. The `runId` late-binds in `events()` from the first native frame carrying a thread id, falling back to `sessionKey`.
- `events(run: RunHandle): AsyncIterable<RuntimeEvent>`, subscribes to the run's driver stream, late-binds `runId`, accumulates non-`reasoning` `text-delta` text, and yields the mapped normalized stream via a bounded `createAsyncQueue` (`max: 1000`). Consumer termination (`return()`) unsubscribes the driver. Returns an empty (closed) queue if no driver is registered for the run.
- `abort(run: RunHandle): Promise<void>`, delegates to the run's driver `abort()`.
- `setModel(run: RunHandle, model: string): Promise<void>`, delegates to the run's driver `setModel()`.
- `writeContext(run: RunHandle, key: string, value: string): Promise<void>`, delegates to the run's driver `writeContext()`.

### Functions

| Export          | Signature                                                                                                                    | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapCodexEvent` | `(ev: CodexNativeEvent, ctx: MapContext, nextSeq: () => number, now?: () => number, accumulated?: string) => RuntimeEvent[]` | Pure native→`RuntimeEvent` mapper. Each native event yields zero or more normalized events with a monotonic `seq`. `thread`→`status` (phase `init`, optional `model`); `text`→`text-delta` (channel defaults `assistant`, empty text dropped); `tool-call`/`tool-result` pass through; `result` emits an optional `cost` event with **`costUsd: null, estimated: true`** (Codex reports no USD) then a terminal `done`/`error`. `aborted`→`done reason:'aborted'`; `ok`→`done reason:'success'` (with `costUsd: null`); otherwise a fatal `error` (`code: null`) + `done reason:'error'`. Unknown native types are dropped, never crash the stream. |
| `codexNativeId` | `(ev: CodexNativeEvent) => string \| undefined`                                                                              | Recovers the native thread id (the resume handle) from the frames that carry one, `thread.threadId` or `result.threadId`; `undefined` otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Types & interfaces

| Export               | Kind                | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodexNativeEvent`   | discriminated union | A native lifecycle frame normalized off the `codex exec --json` stream. Variants: `thread { threadId, model? }` (the resume handle) · `text { text, channel? }` · `tool-call { id, name, input }` · `tool-result { id, name, output, isError? }` · `result { ok, summary, usage?, model?, threadId?, aborted?, errorMessage? }`. A `result` carries token `usage` only, **no USD**, so the mapper marks the derived cost `estimated` with `costUsd: null`. |
| `CodexDriver`        | interface           | The injected per-run seam (analogous to OpenClaw's `OpenClawGatewayClient`). Methods: `start(): Promise<void>` · `onEvent(handler) => () => void` (subscribe, returns unsubscribe) · `abort(): Promise<void>` · `setModel(model): Promise<void>` · `writeContext(key, value): Promise<void>`. One instance per run (a `codex exec` run is one-shot); the real driver spawns it in an isolated `CODEX_HOME`.                                                |
| `CodexDriverFactory` | type alias          | `(opts: StartOpts) => CodexDriver`, fresh driver per run; the adapter calls it in `start()`.                                                                                                                                                                                                                                                                                                                                                               |
| `MapContext`         | interface           | `{ runId: string \| null; sessionId: string \| null }`, the ids the mapper stamps onto every emitted `RuntimeEvent` base.                                                                                                                                                                                                                                                                                                                                  |

<Note>
The `Capabilities`, `HealthResult`, `RunHandle`, `RuntimeAdapter`, `RuntimeEvent`, `StartOpts`, `TaskHandle`, and `Usage` types referenced above are owned by [`@clawboo/executor`](/reference/packages/executor), not re-exported here.
</Note>

<Warning>
Codex keeps its ChatGPT OAuth in `$CODEX_HOME/auth.json`, so a user's `codex login` (`~/.codex`) is invisible to spawned runs, the per-run `CODEX_HOME` is a throwaway. This is the `authKind: 'oauth'` known limitation; see the [Codex runtime](/runtimes/codex) page.
</Warning>

## Used by

- `apps/web/server/lib/runtimes/index.ts`, instantiates `CodexAdapter`, injecting `createCodexDriver` (the real `codex exec`-backed driver) and a CLI health probe.
- `apps/web/server/lib/runtimes/codexDriver.ts`, imports the `CodexDriver` + `CodexNativeEvent` types to implement the server-side driver against `codex exec`.

## Source

`packages/adapters/codex/src/index.ts` (barrel; re-exports `./adapter`, `./types`, `./mapCodexEvent`).

## See also

- [@clawboo/executor](/reference/packages/executor), the `RuntimeAdapter` trait + `RuntimeEvent` union this adapter implements.
- [RuntimeAdapter trait](/internals/runtime-adapter), the cross-runtime contract.
- [Codex runtime](/runtimes/codex), using the runtime end-to-end.
- Sibling adapters: [@clawboo/adapter-claude-code](/reference/packages/adapter-claude-code), [@clawboo/adapter-hermes](/reference/packages/adapter-hermes), [@clawboo/adapter-native](/reference/packages/adapter-native), [@clawboo/adapter-openclaw](/reference/packages/adapter-openclaw).
