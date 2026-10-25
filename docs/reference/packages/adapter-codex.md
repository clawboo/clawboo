---
title: '@clawboo/adapter-codex'
description: Codex RuntimeAdapter that maps the Codex app-server event stream into the normalized executor event stream.
---

|                    |                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.0`                                                                                                                                                                                                                     |
| **Purity**         | pure (deps: `@clawboo/executor` only; no Node/spawn imports, the heavy `codex app-server` driver lives server-side)                                                                                                         |
| **Purpose**        | The Codex [`RuntimeAdapter`](/internals/runtime-adapter): boots a run, maps each native Codex frame into the normalized `RuntimeEvent` union, and delegates abort/setModel/writeContext/steer to a per-run injected driver. |
| **Workspace deps** | `@clawboo/executor`                                                                                                                                                                                                         |
| **External deps**  | none (runtime) · `tsup`, `typescript`, `vitest`, `@clawboo/tsconfig` (dev)                                                                                                                                                  |

This package is the contract-testable shell. It does **not** spawn `codex`, a fresh `CodexDriver` is minted per run via the injected `driverFactory`, and the real driver (`createCodexDriver`) lives in `apps/web/server/lib/runtimes/`. Same shape as the Claude Code adapter (per-run injected driver, eager subscribe, late-bound runId); the two Codex realities, **no USD cost** and **session-id resume**, live entirely in `mapCodexEvent` and the driver, so the trait surface is identical.

## Public API

All exports come from `src/index.ts`. The package declares a single `.` export in `package.json` (no subpath barrels).

### Classes

| Export         | Signature                                      | Contract                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodexAdapter` | `class CodexAdapter implements RuntimeAdapter` | The adapter. Constructed with `(driverFactory: CodexDriverFactory, healthCheck?: () => Promise<HealthResult>)`. `id = 'codex'`, `participantKind = 'agent'`. Holds a per-run driver map keyed by `sessionKey`. |

**`CodexAdapter` members:**

- `capabilities(): Capabilities`, returns `{ streaming: true, mcp: true, worktrees: true, resume: true, toolApproval: true, steering: 'live', models: ['gpt-5-codex','gpt-5','o4-mini'], runtimeClass: 'wrapped-oneshot', nativeHome: { scope: 'per-identity', persist: true }, nativeSkills: 'none', nativeMemory: 'none', nativeChannels: 'none', nativeScheduler: false }`. `nativeHome` declares a persistent managed per-agent `CODEX_HOME` (the host materializes it; the driver falls back to a throwaway `mkdtemp` when no identity home is supplied), which is what makes thread continuity across runs possible (`thread/resume`, or `codex exec resume` on the fallback). The adapter defines a `sessionCodec` (serializes the captured thread id per sessionKey, the Hermes mirror); there is no `contextWindowTokens`.
- `health(): Promise<HealthResult>`, races the injected `healthCheck` against a 2 s timeout (`{ ok: false, message: 'health check timed out' }` on timeout); any throw → `{ ok: false, message }`.
- `start(_task: TaskHandle, opts: StartOpts): Promise<RunHandle>`, mints a driver via `driverFactory(opts)`, stores it by `opts.sessionKey`, calls `driver.start()`, returns `{ adapterId: 'codex', sessionKey, runId: null }`. The `runId` late-binds in `events()` from the first native frame carrying a thread id, falling back to `sessionKey`.
- `events(run: RunHandle): AsyncIterable<RuntimeEvent>`, subscribes to the run's driver stream, late-binds `runId`, accumulates non-`reasoning` `text-delta` text, and yields the mapped normalized stream via a bounded `createAsyncQueue` (`max: 1000`). Consumer termination (`return()`) unsubscribes the driver. Returns an empty (closed) queue if no driver is registered for the run.
- `abort(run: RunHandle): Promise<void>`, delegates to the run's driver `abort()`.
- `setModel(run: RunHandle, model: string): Promise<void>`, delegates to the run's driver `setModel()`.
- `writeContext(run: RunHandle, key: string, value: string): Promise<void>`, delegates to the run's driver `writeContext()`.
- `steer(run: RunHandle, text: string, opts?): Promise<SteerResult>`, delegates to the run's driver `steer()` (the real driver sends `turn/steer` to the in-progress turn) through `steerThroughDriver` with mode `'live'`.

### Functions

| Export          | Signature                                                                                                                    | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapCodexEvent` | `(ev: CodexNativeEvent, ctx: MapContext, nextSeq: () => number, now?: () => number, accumulated?: string) => RuntimeEvent[]` | Pure native→`RuntimeEvent` mapper. Each native event yields zero or more normalized events with a monotonic `seq`. `thread`→`status` (phase `init`, optional `model`); `text`→`text-delta` (channel defaults `assistant`, empty text dropped); `tool-call`/`tool-result` pass through; `result` emits an optional `cost` event with **`costUsd: null, estimated: true`** (Codex reports no USD) then a terminal `done`/`error`. `aborted`→`done reason:'aborted'`; `ok`→`done reason:'success'` (with `costUsd: null`); otherwise a fatal `error` (`code: null`) + `done reason:'error'`. Unknown native types are dropped, never crash the stream. |
| `codexNativeId` | `(ev: CodexNativeEvent) => string \| undefined`                                                                              | Recovers the native thread id (the resume handle) from the frames that carry one, `thread.threadId` or `result.threadId`; `undefined` otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Types & interfaces

| Export               | Kind                | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodexNativeEvent`   | discriminated union | A native lifecycle frame normalized off the app-server's notifications (or the `codex exec --json` stream on the fallback). Variants: `thread { threadId, model? }` (the resume handle) · `text { text, channel? }` · `tool-call { id, name, input }` · `tool-result { id, name, output, isError? }` · `result { ok, summary, usage?, model?, threadId?, aborted?, errorMessage? }`. A `result` carries token `usage` only, **no USD**, so the mapper marks the derived cost `estimated` with `costUsd: null`.                                                          |
| `CodexDriver`        | interface           | The injected per-run seam (analogous to OpenClaw's `OpenClawGatewayClient`). Methods: `start(): Promise<void>` · `onEvent(handler) => () => void` (subscribe, returns unsubscribe) · `abort(): Promise<void>` · `setModel(model): Promise<void>` · `writeContext(key, value): Promise<void>` · `steer?(text, opts?): Promise<boolean>` (optional: `true` when the run took the message, `false` when it had already ended, a throw when the runtime refused it). One instance per run; the real driver hosts the run in `codex app-server` in an isolated `CODEX_HOME`. |
| `CodexDriverFactory` | type alias          | `(opts: StartOpts) => CodexDriver`, fresh driver per run; the adapter calls it in `start()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MapContext`         | interface           | `{ runId: string \| null; sessionId: string \| null }`, the ids the mapper stamps onto every emitted `RuntimeEvent` base.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

<Note>
The `Capabilities`, `HealthResult`, `RunHandle`, `RuntimeAdapter`, `RuntimeEvent`, `StartOpts`, `TaskHandle`, and `Usage` types referenced above are owned by [`@clawboo/executor`](/reference/packages/executor), not re-exported here.
</Note>

<Warning>
Codex keeps its ChatGPT OAuth in `$CODEX_HOME/auth.json`. The driver seeds a copy of the user's `~/.codex/auth.json` into the managed home (parse-validated, freshness-checked so a rotated refresh token is never clobbered, never written back), so a spawned run authenticates with the user's own `codex login`; a home with no usable auth fails fast. See the [Codex runtime](/runtimes/codex) page.
</Warning>

## Used by

- `apps/web/server/lib/runtimes/index.ts`, instantiates `CodexAdapter`, injecting `createCodexDriver` (the real driver: `codex app-server`, falling back to `codex exec`) and a CLI health probe.
- `apps/web/server/lib/runtimes/codexDriver.ts`, imports the `CodexDriver` + `CodexNativeEvent` types to implement the server-side driver (with `codexAppServerDriver.ts`) against `codex app-server`, with `codex exec` as the fallback.

## Source

`packages/adapters/codex/src/index.ts` (barrel; re-exports `./adapter`, `./types`, `./mapCodexEvent`).

## See also

- [@clawboo/executor](/reference/packages/executor), the `RuntimeAdapter` trait + `RuntimeEvent` union this adapter implements.
- [RuntimeAdapter trait](/internals/runtime-adapter), the cross-runtime contract.
- [Codex runtime](/runtimes/codex), using the runtime end-to-end.
- Sibling adapters: [@clawboo/adapter-claude-code](/reference/packages/adapter-claude-code), [@clawboo/adapter-hermes](/reference/packages/adapter-hermes), [@clawboo/adapter-native](/reference/packages/adapter-native), [@clawboo/adapter-openclaw](/reference/packages/adapter-openclaw).
