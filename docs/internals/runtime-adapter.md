---
title: 'The RuntimeAdapter trait'
sidebarTitle: 'RuntimeAdapter'
description: 'The interface every runtime implements: RuntimeAdapter, the RuntimeEvent union, the contract suite, prompt tiers, and a checklist for adding a runtime.'
keywords:
  ['executor', 'adapter', 'RuntimeEvent', 'add a runtime', 'contract suite', 'runAdapterContract']
---

`@clawboo/executor` defines the one interface Clawboo uses to drive every runtime: the `RuntimeAdapter` trait. An adapter starts a run on its runtime and translates the runtime's own frames into a shared `RuntimeEvent` stream. Every server path that drives a run (the executor runner, the team engine, 1:1 agent chat, the verification critic) reads that stream and never a runtime's native format.

Use this page when you change an adapter, consume the event stream, or [add a runtime](#add-a-runtime).

## What the package holds

The package is pure: no workspace dependencies, no runtime dependencies and no `node:*` imports, so it builds browser-safe and is inlined into the CLI bundle. Its main entry (`packages/executor/src/index.ts`) exports:

- the trait and its types (`RuntimeAdapter`, `Capabilities`, `RunHandle`, `StartOpts`, `SteerResult`, `SteerOptions`, `SessionCodec`);
- the `RuntimeEvent` union and the `assertExhaustive` guard;
- `resolveRuntimeIntegration`, which turns declared capabilities into an integration plan;
- `RuntimeRegistry`, a `Map` wrapper the server does not use (see [How the server builds adapters](#how-the-server-builds-adapters));
- `createAsyncQueue`, the callback-to-iterator bridge;
- the idle guard `withIdleTimeout` with `DEFAULT_RUN_SILENT_TIMEOUT_MS` and `IDLE_ABORT_GRACE_MS`;
- the steering helpers `steerThroughDriver` and `steeringOf`;
- the session-rotation helpers (`shouldRotate`, `buildRotationHandoffNote`, `rotateSession`, `DEFAULT_ROTATION`).

Two subpaths sit beside it. `@clawboo/executor/contract` holds the shared adapter test suite, which imports vitest, so it never rides the main entry. `@clawboo/executor/tiers` holds the prompt-tier helpers.

The trait is deliberately narrow. Claiming a task, provisioning a worktree, running verification and writing the handoff belong to the [executor runner](/internals/executor-runner). Which agents exist belongs to [AgentSource](/internals/agent-source). An adapter knows neither.

## The six adapters

| Package                        | Runtime id       | Notes                                                       |
| ------------------------------ | ---------------- | ----------------------------------------------------------- |
| `@clawboo/adapter-native`      | `clawboo-native` | Clawboo Native, the in-process harness.                     |
| `@clawboo/adapter-claude-code` | `claude-code`    | Drives the Claude Agent SDK.                                |
| `@clawboo/adapter-codex`       | `codex`          | Drives `codex app-server` (falls back to `codex exec`).     |
| `@clawboo/adapter-hermes`      | `hermes`         | Runs `hermes chat -q`, one process per run.                 |
| `@clawboo/adapter-openclaw`    | `openclaw`       | Drives an agent over a live OpenClaw Gateway connection.    |
| `@clawboo/adapter-mock`        | `clawboo-mock`   | Fault-injection runtime for contributors. Executes nothing. |

<Note>

`clawboo-mock` synthesizes its whole event stream from directives in the message, so silence, a crash, an unresolved tool call or a slow start can be reproduced through the real server paths. It is listed only when `CLAWBOO_ENABLE_MOCK_RUNTIME=1`, never appears in a normal install, declares no steering and no worktrees, and does not run the contract suite.

</Note>

## The trait

```ts
interface RuntimeAdapter {
  readonly id: RuntimeId
  readonly participantKind: ParticipantKind
  capabilities(): Capabilities
  health(): Promise<HealthResult>
  start(task: TaskHandle, opts: StartOpts): Promise<RunHandle>
  events(run: RunHandle): AsyncIterable<RuntimeEvent>
  abort(run: RunHandle): Promise<void>
  setModel(run: RunHandle, model: string): Promise<void>
  writeContext(run: RunHandle, key: string, value: string): Promise<void>
  steer?(run: RunHandle, text: string, opts?: SteerOptions): Promise<SteerResult>
  readonly sessionCodec?: SessionCodec
  dispose?(): Promise<void>
}
```

### Identity: `id` and `participantKind`

`RuntimeId` is an open set: `'openclaw' | 'claude-code' | 'codex' | 'hermes' | (string & {})`. The `(string & {})` member turns the named ids into autocomplete hints, so a new runtime id is a value, not a type change.

`participantKind` is `'agent' | 'human'`. Every adapter sets `'agent'` and nothing in the code branches on it. `'human'` is reserved so a person could later sit behind the same interface; there is no human-participant adapter.

### `capabilities()`

`capabilities()` returns a `Capabilities` block. The base fields describe the runtime:

| Field                  | Type                                     | Meaning                                                                                  |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `streaming`            | `boolean`                                | Emits incremental text deltas rather than one message at the end of a turn.              |
| `mcp`                  | `boolean`                                | Can discover and call MCP tool servers.                                                  |
| `worktrees`            | `boolean`                                | Can run work in a per-task git worktree.                                                 |
| `resume`               | `boolean`                                | Can resume a prior session from a serialized handle.                                     |
| `toolApproval`         | `boolean`                                | The runtime can raise tool-approval prompts for a host to answer.                        |
| `models`               | `string[]`                               | Model ids the runtime can use (empty when unknown).                                      |
| `contextWindowTokens?` | `number`                                 | The context window, when known. Drives the rotation watermark; omitted or 0 disables it. |
| `steering?`            | `'live' \| 'interrupt-resume' \| 'none'` | How `steer()` reaches a running turn. Omitted means `'none'`.                            |

<Warning>

`toolApproval: true` describes the runtime, not Clawboo's use of it. Clawboo drives the coding runtimes headless with their own approval prompts and sandboxes turned off: Claude Code with `permissionMode: 'bypassPermissions'` (plus `allowDangerouslySkipPermissions: true`), Codex with `--dangerously-bypass-approvals-and-sandbox` (or, through `codex app-server`, approval policy `never` and sandbox `danger-full-access`), and Hermes with `--yolo` and `--accept-hooks`. A per-task git worktree keeps file changes apart when the executor runner provisions one; it is not a sandbox. See [What agents can do](/concepts/permissions).

</Warning>

### Integration fields and `resolveRuntimeIntegration`

A second group of optional fields tells the host how deeply to integrate the runtime, so the host routes by declared data and never by a runtime-id switch:

- `runtimeClass?: 'wrapped-oneshot' | 'connected-substrate' | 'native'`. A wrapped one-shot is a process spawned per run; a connected substrate is a long-lived service the host drives over its live connection (OpenClaw); native is the in-process harness. Omitted means `'wrapped-oneshot'`.
- `nativeHome?: { scope: 'per-identity' | 'per-run', persist: boolean }`: a claim about the home directory the runtime accrues state in. The adapter never computes a path; the host materializes it.
- `nativeSkills?` and `nativeMemory?`: `'preserve' | 'none'`, whether the runtime's own on-disk skills or memory must survive across runs.
- `nativeChannels?: 'gateway' | 'none'`: whether the runtime owns its own delivery channels.
- `nativeScheduler?: boolean`: informational only. The host's scheduler always decides when work runs.

`resolveRuntimeIntegration(caps)` (`packages/executor/src/integration.ts`) turns those fields into the plan the host executes:

| Declared                                                             | `home.kind`  | Preserve flags                                             |
| -------------------------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| `runtimeClass: 'connected-substrate'`                                | `connected`  | Both false; `useGatewayChannels` follows `nativeChannels`  |
| Any other class with `nativeHome` `per-identity` and `persist: true` | `persistent` | `preserveSkills` / `preserveMemory` follow the declaration |
| Anything else (including an omitted block)                           | `ephemeral`  | Both false                                                 |

`coRunScheduler` is always `false`. Preserve flags are clamped to a persistent home, so a misdeclared adapter degrades to the plain one-shot path instead of a contradictory plan. The executor runner refuses a `connected` home before it claims anything, and serializes runs of a `persistent` home per agent.

What each adapter declares (`packages/adapters/*/src/adapter.ts`):

| Runtime          | Class                 | `nativeHome`                         | Streaming | MCP | Worktrees | Steering           | Preserves      |
| ---------------- | --------------------- | ------------------------------------ | --------- | --- | --------- | ------------------ | -------------- |
| `clawboo-native` | `native`              | per-identity, persist                | yes       | yes | yes       | `live`             | memory         |
| `claude-code`    | `wrapped-oneshot`     | none (the user's `~/.claude`)        | yes       | yes | yes       | `live`             | nothing        |
| `codex`          | `wrapped-oneshot`     | per-identity, persist (`CODEX_HOME`) | yes       | yes | yes       | `live`             | nothing        |
| `hermes`         | `wrapped-oneshot`     | per-identity, persist                | no        | yes | yes       | `interrupt-resume` | skills, memory |
| `openclaw`       | `connected-substrate` | none (the Gateway owns it)           | yes       | no  | no        | `live`             | skills, memory |
| `clawboo-mock`   | omitted               | none                                 | yes       | no  | no        | `none`             | nothing        |

Every real adapter declares `resume: true` and `toolApproval: true`; the mock declares both false. Native and Claude Code declare a 200,000-token context window; the others declare none, so the rotation watermark stays off for them.

The runtime descriptor (`RUNTIME_DESCRIPTORS` in `apps/web/server/lib/runtimes/descriptor.ts`) answers a different question: how to install and authenticate a runtime (package, health binary, auth kind, vault env var). The class lives on the adapter because it describes how the host drives the runtime once it is online.

### `start()` and the late-bound `runId`

`start(task, opts)` delivers the run's opening message and returns a `RunHandle`:

```ts
interface RunHandle {
  readonly adapterId: string
  readonly sessionKey: string
  runId: string | null
}
```

`runId` is mutable and late-bound. A runtime usually reports its run id on the first lifecycle frame rather than from `start()`, so callers begin with `runId: null`, and `events()` re-binds `run.runId` from the first frame of each run.

`TaskHandle` (`{ taskId?, teamId? }`) carries optional board references, so an adapter can run board-backed or ad hoc work. `StartOpts` carries the runtime-side `agentId`, the `sessionKey`, the `message`, an optional `model` and `context` block, and a `childToolBlocklist` of tools the run must not use (the runner passes `['sessions_send']`). The blocklist is advisory for runtimes that cannot restrict tools per run, so the host also enforces the real limit elsewhere: the board's depth cap, and for OpenClaw the sub-agent tools in the Gateway's `tools.deny`.

### `events()`: a continuous observer

`events(run)` returns an `AsyncIterable<RuntimeEvent>` for `run.sessionKey`.

<Info>

`events()` is a continuous observer. A Gateway session hosts many successive runs on one `sessionKey`, so `done` and `error` are yielded as events but do not necessarily end the stream. The consumer ends observation itself (`break` or `iterator.return()`), which releases the subscription. For a one-shot CLI process the stream ends when the process exits. Either way, the consumer drives termination.

</Info>

Adapters subscribe when `events()` is called, not on the first `next()`, so frames that arrive between subscription and the first pull are buffered rather than dropped. The OpenClaw adapter shows the shape: it subscribes through `client.onEvent`, filters frames by `sessionKey`, re-binds `run.runId` from each frame, maps frames to `RuntimeEvent`s with `mapFrameToRuntimeEvents`, and unsubscribes only when the iterator's `return()` runs.

### `abort()`, `setModel()`, `writeContext()`

- `abort(run)` cancels the live run. The OpenClaw adapter sends `chat.abort` when a `runId` is bound and always sends `sessions.abort` too, which covers the window before the run id binds and any queued work.
- `setModel(run, model)` switches the model mid-session (OpenClaw: `sessions.patch`).
- `writeContext(run, key, value)` writes a context file (OpenClaw: `agents.files.set`). It is not a mid-run channel: a spawned CLI never re-reads the file during a run, and a running OpenClaw session does not re-read an agent file. Use `steer()` for that.

### `steer()`: a message into a running run

`steer(run, text, opts?)` puts a message in front of the model during the run it is aimed at. It is how a person's comment on a task reaches the agent working on it. The adapter declares how in `capabilities().steering`:

- `'live'`: the runtime takes the message into the turn in progress at its next boundary without stopping anything (Clawboo Native, Claude Code, Codex, OpenClaw).
- `'interrupt-resume'`: the runtime has no way in mid-run, so the driver stops the process and resumes the same session with the message as the next input (Hermes). The stop is absorbed inside the driver and never surfaces as a terminal event, so the host sees one run that carries on. An aborted terminal would otherwise reach the team engine's failure path.
- `'none'` or omitted: no mid-run channel. A host must not call `steer()` on such a run.

`steer()` is optional and never throws. It resolves `{ delivered: true, mode }` when the runtime accepted the message for this run, or `{ delivered: false, reason }` with `reason` one of `no-run`, `run-ended`, `unsupported` or `rejected` (plus an optional `detail`). The server's comment path writes the agent's mailbox first, steers second, and marks the mailbox row delivered only when the steer lands, so a refusal falls back to the next run reading the mailbox.

`SteerOptions.passive` marks an ambient note rather than a person's instruction: it is delivered if the run reads input again, but never keeps a finishing run going and never stops a run (an `'interrupt-resume'` adapter refuses it). Adapters with a per-run driver share their `steer()` body through `steerThroughDriver(driver, text, mode, opts)`; `steeringOf(caps)` reads an omitted claim as `'none'`.

### `sessionCodec` and `dispose`

`sessionCodec` (optional) serializes a run's session to a string and restores it; the runner uses it to persist a native session id for a same-runtime resume. `dispose` (optional) releases adapter-level resources.

## The RuntimeEvent union

Every adapter normalizes its runtime's signals into one union with seven kinds:

```ts
type RuntimeEventKind =
  'text-delta' | 'tool-call' | 'tool-result' | 'status' | 'cost' | 'done' | 'error'
```

Each event carries a common envelope:

```ts
interface RuntimeEventBase {
  runId: string
  sessionId: string | null // the runtime's session handle
  ts: number
  seq: number // strictly increasing per stream
}
```

`seq` orders events that share a millisecond `ts`, so a consumer can always reconstruct causal order.

| Kind          | Payload (beyond the envelope)                                                               | Notes                                                     |
| ------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `text-delta`  | `text`, `channel?: 'assistant' \| 'reasoning'`                                              | `channel` separates visible output from reasoning traces. |
| `tool-call`   | `toolCallId`, `name`, `input`, `partial`                                                    | `partial: true` while the input JSON is still streaming.  |
| `tool-result` | `toolCallId`, `name`, `output`, `isError`                                                   | The outcome of a tool call.                               |
| `status`      | `phase: 'init' \| 'thinking' \| 'running' \| 'turn-complete'`, `model?`, `detail?`          | A lifecycle signal with no text.                          |
| `cost`        | `costUsd: number \| null`, `usage`, `model`, `estimated?`                                   | Token usage, plus USD when the runtime reports it.        |
| `done`        | `reason: 'success' \| 'max_turns' \| 'aborted' \| 'error'`, `summary`, `usage?`, `costUsd?` | Terminal summary for one run or turn.                     |
| `error`       | `code: string \| null`, `message`, `fatal`                                                  | A recoverable or fatal failure.                           |

The union encodes two real differences between runtimes in its types:

1. **Not every runtime reports USD.** `cost.costUsd` is `number | null`, and `estimated?` marks a derived value. A runtime that cannot supply USD emits `null` rather than an invented number; the runner then estimates spend from the token usage (see [the executor runner](/internals/executor-runner)).
2. **Not every runtime streams text.** A runtime without deltas emits one `text-delta` carrying the whole message.

`assertExhaustive(x: never): never` guards `switch` statements over the union, so a new variant is a compile error at every switch that forgets it.

## How the server builds adapters

The server does not keep a registry of adapter instances. `apps/web/server/lib/runtimes/index.ts` builds a fresh adapter for each run:

- `enabledRuntimeIds()` lists the non-OpenClaw runtimes: the four real ones, plus `clawboo-mock` only when `CLAWBOO_ENABLE_MOCK_RUNTIME=1`.
- `adapterFactoryFor(id)` returns a factory that takes a `RuntimeRunContext` (working directory, model, resume id, MCP base URL, memory scope, home directory, provider keys) and constructs the adapter wired to its real driver and health check. `buildRuntimeAdapterFactories()` maps every enabled id to its factory.
- OpenClaw adapters are built per delivery over the server's shared Gateway connection: `buildOpenClawServerAdapter()` (`runtimes/serverAdapter.ts`) for team chat, and the Routines wake bridge for OpenClaw routine fires.

`RuntimeRegistry` (register, unregister, get, has, ids, list) is exported from the package and unit-tested, but nothing in the server or the dashboard uses it.

## The async queue

Adapters bridge a callback source (a WebSocket `onEvent`, a subprocess stdout reader) into an `AsyncIterable` by pushing into `createAsyncQueue<RuntimeEvent>()` and letting the consumer pull with `for await`. The queue has one consumer. Backpressure is drop-oldest at `max` (default 1000), because orchestration cares about tool calls and `done` more than every text delta. `close()` ends the stream, and the iterator's `return()` closes the queue, which is how `events()` releases its subscription.

## The idle guard

`withIdleTimeout(source, { idleMs, onIdle, graceMs? })` re-yields an event stream and bounds the silence between events. The timer resets on every event, so a long run that keeps streaming never trips it. When silence passes `idleMs`, `onIdle()` fires (the caller aborts the run there), then a grace window (`IDLE_ABORT_GRACE_MS`, 5 seconds) lets the adapter surface its own terminal before the stream ends.

The executor runner, the team engine's `serverDeliver` and the 1:1 chat's `driveAgentChat` drain their runs through it; the other `events()` loops do not. Their ceiling is `DEFAULT_RUN_SILENT_TIMEOUT_MS` (30 minutes), overridable with `CLAWBOO_RUN_SILENT_TIMEOUT_MS`. The runner reports a silent timeout as a failed run with the cause stated, and a 1:1 chat that has not replied yet gets a notice that the run went quiet for too long.

## The contract suite

Every real adapter passes one shared suite, `runAdapterContract(harness)` from `@clawboo/executor/contract`. The adapter supplies an `AdapterTestHarness`: how to make the adapter on a fake transport, start a run, emit a native frame, and read the side effects it issued. The harness translates abstract `ContractFrames` (`delta`, `toolCall`, `final`, `aborted`, `error`) into the runtime's own frames, and the suite asserts on the normalized output:

- `id` is a non-empty string and `participantKind` is `'agent'` or `'human'`;
- `capabilities()` returns a well-formed shape;
- `health()` resolves within two seconds;
- `start()` returns a handle with the adapter's id and an unbound `runId` (`null`);
- `events()` round-trips a stream that ends in `done: success` with strictly increasing `seq`;
- `runId` binds late, from the first lifecycle frame;
- `abort()` issues a cancel side effect and the stream surfaces `done: aborted`;
- `setModel()` and `writeContext()` each issue their side effect.

<Info>

`vitest` stays external in the package's tsup config. A bundled copy would register `describe` and `it` on a detached collector, and an adapter's contract tests would silently never run. Keeping it external binds the suite to the consumer's vitest at runtime.

</Info>

The package also tests the suite itself against a minimal `InMemoryAdapter` (`packages/executor/src/__tests__/contract-selftest.test.ts`), which doubles as the smallest reference implementation of the trait.

## Prompt tiers: `@clawboo/executor/tiers`

The `./tiers` subpath keeps a provider's prompt cache warm. A prompt has three tiers, ordered by how often they change:

| Tier       | Changes                | Typical content                                               |
| ---------- | ---------------------- | ------------------------------------------------------------- |
| `stable`   | Frozen for the session | Identity, tool guidance, skills index.                        |
| `context`  | Infrequently           | The caller's system message, team manifest, project files.    |
| `volatile` | Every turn             | Memory snapshot, last handoff summary, a date-only timestamp. |

`assembleTiers(tiers)` joins them in that order and returns the `prompt`, the `stablePrefix` (stable plus context, identical turn over turn), its UTF-8 byte length, and suggested `cacheBreakpoints` (byte offsets an Anthropic-style consumer can map to `cache_control` markers; OpenAI caches prefixes on its own and the OpenClaw Gateway owns its caching, so both ignore them). Two helpers keep the prefix stable:

- `sortToolDefs(defs)` sorts tool definitions by name without mutating the input, because tool order is part of the cache key.
- `dateStamp(d)` returns a `YYYY-MM-DD` (UTC) stamp. A minute or second timestamp in the prompt would bust the cache on every rebuild; a runtime that needs wall-clock time should get it from a tool.

The executor runner assembles every run's prompt through `assembleTiers` (see [Prompt assembly](/internals/executor-runner#prompt-assembly)), and Clawboo Native's conversation loop uses `dateStamp` for its date header.

## Session rotation

The rotation helpers answer "the session ran out of room before the task finished". Rotation happens between runs, never mid-generation, because the runtime owns its inner loop. `shouldRotate` fires when `tokensUsed / contextWindow` reaches `thresholdPct` (`DEFAULT_ROTATION.thresholdPct`, 0.85) and stays inert when the runtime declares no window. `rotateSession` takes the adapter, a `restart` closure (the host re-assembles the prompt with a short handoff note from `buildRotationHandoffNote` and calls `adapter.start`), and an optional `recordRotation` callback for lineage. `DEFAULT_ROTATION.maxRotations` (3) bounds the chain of successor sessions per task. The runner's use of it is described in [Session rotation](/internals/executor-runner#session-rotation).

## Add a runtime

A new runtime touches more than the trait. Wire it in this order, and grep for an existing id such as `'hermes'` to catch anything this list misses.

<Steps>

<Step title="Write the adapter package">

Create `packages/adapters/<id>` exporting a class that implements `RuntimeAdapter`. Declare only capabilities that are true; omit the integration fields you cannot back. Add a test that calls `runAdapterContract` from `@clawboo/executor/contract` against a fake driver, like the existing `packages/adapters/*/src/__tests__/adapter.test.ts`.

</Step>

<Step title="Write the server driver">

Add a driver under `apps/web/server/lib/runtimes/` that spawns or connects to the runtime and consumes a `RuntimeRunContext` (`runtimes/types.ts`). Honour `ctx.cwd`, `ctx.homeDir`, `ctx.mcpBaseUrl` and `ctx.apiKeyEnv` the way the existing drivers do.

</Step>

<Step title="Register the id and descriptor">

Add the id to `NonOpenClawRuntimeId` and `NON_OPENCLAW_RUNTIME_IDS`, and a `RUNTIME_DESCRIPTORS` entry (install command, health binary, auth kind, vault env var), in `apps/web/server/lib/runtimes/descriptor.ts`.

</Step>

<Step title="Add the factory">

Add a case to `adapterFactoryFor()` in `apps/web/server/lib/runtimes/index.ts` that builds the adapter over your driver, with a health check. Add the adapter package to `apps/web/package.json`.

</Step>

<Step title="Add a capability source">

Implement a `CapabilitySource` in `apps/web/server/lib/capabilitySource/`, register it in `capabilitySource/registry.ts`, and add its id to `CapabilitySourceId` and `SOURCE_IDS` in `packages/capability-registry/src/`. See [Capability and schedule sources](/internals/seams).

</Step>

<Step title="Add an agent source">

For a runtime whose agents live only in SQLite, add the id to `CODING_RUNTIME_SOURCE_IDS` in `apps/web/server/lib/agentSource/registry.ts`, which registers a `RuntimeAgentSource` for it. A runtime with its own upstream needs its own `AgentSource`. See [AgentSource](/internals/agent-source).

</Step>

<Step title="Declare agent files and prompt behaviour">

Add a row to `AGENT_FILE_RUNTIME_SUPPORT` in `packages/protocol/src/index.ts` listing only the files the runtime really consumes. If it reads no persona file of its own, add it to `RUNTIMES_WITHOUT_NATIVE_PERSONA` in `runtimes/personaBlock.ts`, and check `memoryGuidance.ts` and `teamChat/contextPreamble.ts`.

</Step>

<Step title="Surface it in the dashboard">

Add the id to the client `RuntimeId` union in `packages/control-client/src/runtimes.ts` and an entry to `apps/web/src/features/runtimes/runtimeCatalog.ts`, then follow the remaining UI references (brand mark, Boo variant, runtime pickers).

</Step>

</Steps>

You should then see the runtime on the Runtimes settings panel, be able to create an agent on it, and run a board task on it through `POST /api/runtimes/<id>/run`.

## Related

- [The executor runner](/internals/executor-runner): claim, worktree, run, verify and hand off one task through an adapter
- [Capability and schedule sources](/internals/seams): the capability and schedule multiplexers a new runtime plugs into
- [AgentSource](/internals/agent-source): where a runtime's agents are recorded
- [What agents can do](/concepts/permissions): the per-runtime safety posture
- [Choose a runtime](/runtimes/index): the runtimes as users see them
- [Write a runtime adapter](/reference/packages/executor): the package-level guide to building on `@clawboo/executor`
- [Runtime adapters](/reference/packages/adapters): the six adapter packages compared
