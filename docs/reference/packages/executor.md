---
title: '@clawboo/executor'
description: The RuntimeAdapter trait, the normalized RuntimeEvent lifecycle union, the adapter contract suite, and KV-cache prompt-tier primitives.
---

|                    |                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.0`                                                                                                                                                                                       |
| **Purity**         | pure zero-dep (browser-safe; no `node:*`, no workspace deps)                                                                                                                                  |
| **Purpose**        | The runtime-adapter trait + the normalized lifecycle-event union every heterogeneous agent runtime emits, plus the contract suite adapters must pass and the KV-cache prompt-tier primitives. |
| **Workspace deps** | none                                                                                                                                                                                          |
| **External deps**  | none at runtime. `./contract` imports `vitest` (kept `external` so it binds to the consumer's instance).                                                                                      |

This is the substrate the whole multi-runtime executor is built on: a single `RuntimeAdapter` interface over every runtime (OpenClaw, clawboo-native, Claude Code, Codex, Hermes), a 7-variant `RuntimeEvent` union the orchestrator/board/UI consume so they stay decoupled from per-runtime quirks, a `runAdapterContract` suite every adapter must pass, and cache-discipline helpers for prompt assembly.

Three barrels, each its own subpath in `package.json` `exports`:

- `.` → `src/index.ts`: the app-safe barrel (trait, event union, registry, async queue, session rotation, integration plan). No test deps.
- `./contract` → `src/contract.ts`: the adapter contract test suite. Imports `vitest`; never pulled through `.`.
- `./tiers` → `src/tiers/index.ts`: KV-/prompt-cache discipline primitives.

## Public API

### `.`, main barrel (`src/index.ts`)

#### Functions

| Export                      | Signature                                         | Contract                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assertExhaustive`          | `(x: never) => never`                             | Compile-time exhaustiveness guard for a `switch` over `RuntimeEvent`; throws at runtime if reached.                                                                                        |
| `resolveRuntimeIntegration` | `(caps: Capabilities) => RuntimeIntegrationPlan`  | Pure: turns a runtime's declared capabilities into the integration plan the host branches on (never on a runtime id). Conservative default: an absent claim resolves to the one-shot path. |
| `createAsyncQueue`          | `<T>(opts?: { max?: number }) => AsyncQueue<T>`   | Single-consumer push/pull queue that bridges a callback event source into an `AsyncIterable`. Drop-oldest backpressure at `max` (default 1000).                                            |
| `shouldRotate`              | `(t: RotationTrigger) => boolean`                 | True when the session has consumed `thresholdPct` of its context window. A non-positive `contextWindow` or `thresholdPct` disables the watermark.                                          |
| `buildRotationHandoffNote`  | `(h: RotationHandoff) => string`                  | Renders the short structured handoff note threaded into a successor session's prompt (data, not transcript).                                                                               |
| `rotateSession`             | `(opts: RotateSessionOpts) => Promise<RunHandle>` | Rotates to a fresh successor session at the run boundary: serialize (best-effort), render the note, `restart`, then `recordRotation` (best-effort). Returns the successor handle.          |

#### Types & interfaces

| Export                   | Kind       | Contract                                                                                                                                                                                        |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeEvent`           | union type | The normalized 7-variant lifecycle union: `text-delta`, `tool-call`, `tool-result`, `status`, `cost`, `done`, `error` over `RuntimeEventBase`.                                                  |
| `RuntimeEventKind`       | union type | The seven event-kind string literals.                                                                                                                                                           |
| `RuntimeEventBase`       | interface  | Common envelope: `{ runId, sessionId, ts, seq }`. `seq` is a strictly increasing per-stream tiebreaker.                                                                                         |
| `Usage`                  | interface  | `{ inputTokens, outputTokens, cachedInputTokens? }` token usage for a run.                                                                                                                      |
| `RuntimeAdapter`         | interface  | One interface over every runtime: `id`, `participantKind`, `capabilities()`, `health()`, `start()`, `events()`, `abort()`, `setModel()`, `writeContext()`, optional `sessionCodec`/`dispose()`. |
| `RuntimeId`              | type       | Known runtime ids (`openclaw`/`claude-code`/`codex`/`hermes`) as autocomplete hints over an open `string` set.                                                                                  |
| `ParticipantKind`        | type       | `'agent' \| 'human'`, reserved seam; nothing branches on `'human'` yet.                                                                                                                         |
| `Capabilities`           | interface  | What a runtime can do: `streaming`, `mcp`, `worktrees`, `resume`, `toolApproval`, `models[]`, optional `contextWindowTokens` + the native-preservation seam fields.                             |
| `RuntimeClass`           | type       | `'wrapped-oneshot' \| 'connected-substrate' \| 'native'`: how a runtime composes with the host.                                                                                                 |
| `NativeHomeClaim`        | interface  | A runtime's CLAIM about its state home: `{ scope: 'per-identity' \| 'per-run'; persist: boolean }`. The host materializes the path.                                                             |
| `HealthResult`           | interface  | `{ ok: boolean; message?: string }`.                                                                                                                                                            |
| `TaskHandle`             | interface  | `{ taskId?, teamId? }`, board references for a run (both optional for ad-hoc runs).                                                                                                             |
| `StartOpts`              | interface  | `{ agentId, sessionKey, message, model?, context?, childToolBlocklist? }`, inputs to `start()`.                                                                                                 |
| `RunHandle`              | interface  | `{ adapterId, sessionKey, runId }`. `runId` is late-bound (null until the first lifecycle frame).                                                                                               |
| `SessionCodec`           | interface  | Optional `serialize(run)` / `restore(blob)` for session resume.                                                                                                                                 |
| `IntegrationHome`        | union type | `{ kind: 'persistent'; scope: 'per-identity' } \| { kind: 'ephemeral' } \| { kind: 'connected' }`.                                                                                              |
| `RuntimeIntegrationPlan` | interface  | The normalized plan `resolveRuntimeIntegration` returns: `{ home, preserveSkills, preserveMemory, useGatewayChannels, coRunScheduler: false }`.                                                 |
| `AsyncQueue<T>`          | interface  | `AsyncIterable<T>` with `push(value)`, `close()`, `readonly closed`.                                                                                                                            |
| `RotationTrigger`        | interface  | `{ tokensUsed, contextWindow, thresholdPct }`, the watermark input.                                                                                                                             |
| `RotationHandoff`        | interface  | The structured rotation handoff: `{ taskId, predecessorSessionKey, predecessorSessionId, reason, lastSummary, tokensUsed, rotationIndex }`.                                                     |
| `RotateSessionOpts`      | interface  | Injected side-effects: `{ adapter, current, handoff, restart, recordRotation? }`, keeps `rotateSession` DB-free + runtime-agnostic.                                                             |

#### Classes

| Export            | Signature | Contract                                                                                                          |
| ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `RuntimeRegistry` | `class`   | Open set of adapters keyed by id: `register(adapter)`, `unregister(id)`, `get(id)`, `has(id)`, `ids()`, `list()`. |

#### Constants

| Export             | Value                                              | Contract                                                                            |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DEFAULT_ROTATION` | `{ thresholdPct: 0.85, maxRotations: 3 } as const` | Conservative rotation defaults; `maxRotations` bounds the successor chain per task. |

### `./tiers`, prompt-cache discipline (`src/tiers/index.ts`)

KV-/prompt-cache primitives: stable → context → volatile tier ordering, deterministically-sorted tool definitions, date-only timestamps. Pure + browser-safe.

#### Functions

| Export          | Signature                                        | Contract                                                                                                                                                                                         |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assembleTiers` | `(tiers: PromptTiers) => AssembledPrompt`        | Joins `stable → context → volatile` so the frozen content is the cacheable head; reports `stablePrefix`, `stablePrefixBytes` (UTF-8), and suggested `cacheBreakpoints`. Empty tiers are skipped. |
| `dateStamp`     | `(d: Date) => string`                            | UTC `YYYY-MM-DD` only, never minute/second precision (fine-grained timestamps bust the KV prefix cache).                                                                                         |
| `sortToolDefs`  | `<T extends ToolDef>(defs: readonly T[]) => T[]` | Non-mutating sort by `name`. Tool-array order is a cache key; an unsorted list busts the tool-definitions prefix.                                                                                |

#### Types & interfaces

| Export            | Kind      | Contract                                                                                           |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `ToolDef`         | interface | `{ name: string; [k: string]: unknown }`, a tool definition with the cache-stable `name` sort key. |
| `PromptTiers`     | interface | `{ stable, context, volatile }`, the three tiers ordered by change frequency.                      |
| `CacheBreakpoint` | interface | `{ offset: number; label: 'stable' \| 'context' }`, a suggested `cache_control` byte offset.       |
| `AssembledPrompt` | interface | `{ prompt, stablePrefix, stablePrefixBytes, cacheBreakpoints }`.                                   |

<Note>
`cacheBreakpoints` are suggestions for an Anthropic-style consumer. OpenAI auto-prefix-caches and ignores them; OpenClaw's Gateway owns caching and ignores them too.
</Note>

### `./contract`, adapter contract suite (`src/contract.ts`)

The suite every `RuntimeAdapter` must pass. Imports `vitest`, so it lives only under this subpath and is never re-exported from the main barrel.

#### Functions

| Export               | Signature                               | Contract                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runAdapterContract` | `(harness: AdapterTestHarness) => void` | Drives a runtime-agnostic scenario through the adapter and asserts the normalized output (stable id, well-formed capabilities, health < 2s, late-bound runId, monotonic `seq`, `done:success`/`done:aborted`, abort/setModel/writeContext side-effects). |

#### Types & interfaces

| Export               | Kind      | Contract                                                                                                                            |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `RecordedCall`       | interface | `{ method: string; params: unknown }`, a side-effect (setModel/abort/writeContext) the adapter issued, for assertions.              |
| `ContractFrames`     | interface | Abstract native-frame builders the harness supplies: `delta`, `toolCall`, `final`, `aborted`, `error`.                              |
| `AdapterTestHarness` | interface | The runtime-specific glue the suite drives: `label`, `makeAdapter()`, `start(adapter)`, `emit(frame)`, `frames`, `recordedCalls()`. |

## Used by

- **`@clawboo/adapter-openclaw`, `-native`, `-claude-code`, `-codex`, `-hermes`**, implement `RuntimeAdapter`, emit `RuntimeEvent`, declare `Capabilities`, and run the `./contract` suite (`RecordedCall` imported in each adapter's `testing/fake*Driver.ts`).
- **`apps/web`**, `executorRunner.ts` imports `assembleTiers` from `./tiers` and drives the trait + rotation; `runtimes/native/conversation.ts` imports `dateStamp`. The runner uses `RuntimeRegistry`, `shouldRotate`/`rotateSession`/`DEFAULT_ROTATION`, and `resolveRuntimeIntegration`.
- **`@clawboo/evals`**, depends on the executor surface for its harness.

## Source

- Main barrel: [`packages/executor/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/executor/src/index.ts)
- Contract barrel: `packages/executor/src/contract.ts`
- Tiers barrel: `packages/executor/src/tiers/index.ts`
- Subpath mapping: `packages/executor/package.json` `exports` + `packages/executor/tsup.config.ts`

## See also

- [RuntimeAdapter trait (internals)](/internals/runtime-adapter)
- [Executor runner (internals)](/internals/executor-runner)
- [Runtimes overview](/runtimes/index)
- [Package overview](/reference/packages/index)
