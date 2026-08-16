---
title: '@clawboo/adapter-native'
description: The pure RuntimeAdapter for clawboo's in-process native conversational harness, plus its AgentConfig schema and native→RuntimeEvent mapper.
---

**Version** 0.1.0 · **Purity** pure (browser-safe; deps: `@clawboo/executor`, `zod`) · **Purpose** the pure `RuntimeAdapter` for clawboo's native runtime, the in-process conversational harness driving provider SDKs directly, mapped onto the normalized executor event stream.

- **Workspace deps**: `@clawboo/executor`
- **External deps**: `zod` (^3.25.0)

The package is the dependency-light translation layer the contract suite can drive with an in-memory fake. The real harness (turn loop, provider clients, MCP bridge) lives server-side in `apps/web/server/lib/runtimes/native/`; this package owns only the adapter, the event mapper, and the persisted `AgentConfig` shape.

## Public API

### Functions

| Export              | Signature                                                                                                               | Contract                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mapNativeEvent`    | `(ev: NativeEvent, ctx: MapContext, nextSeq: () => number, now?: () => number, accumulated?: string) => RuntimeEvent[]` | Pure native→`RuntimeEvent` mapper. Each native event yields zero or more normalized events with a monotonic `seq`. A `turn` frame maps to a `cost` event whose usage/`costUsd` are turn deltas; the terminal `result` maps to `done`/`error`. Unknown events are dropped, not thrown.                                                                                                                                                |
| `nativeFrameId`     | `(ev: NativeEvent) => string \| undefined`                                                                              | Recovers the native session id from the frames that carry one (`init`, `result`); `undefined` otherwise.                                                                                                                                                                                                                                                                                                                             |
| `parseAgentConfig`  | `(json: string \| null) => AgentConfig \| null`                                                                         | Parses a stored JSON blob through `agentConfigSchema`; returns `null` on missing/corrupt/invalid content so a bad blob degrades to the default rather than crashing a run.                                                                                                                                                                                                                                                           |
| `envVarForProvider` | `(provider: string) => string \| null`                                                                                  | The conventional vault env-var name per known provider. Ten keyed providers: `anthropic`→`ANTHROPIC_API_KEY`, `openai`→`OPENAI_API_KEY`, `openrouter`→`OPENROUTER_API_KEY`, `google`→`GEMINI_API_KEY`, `xai`→`XAI_API_KEY`, `groq`→`GROQ_API_KEY`, `mistral`→`MISTRAL_API_KEY`, `together`→`TOGETHER_API_KEY`, `cerebras`→`CEREBRAS_API_KEY`, `moonshot`→`MOONSHOT_API_KEY`. `ollama` and unknown providers return `null` (keyless). |

### Classes

| Export          | Signature                                       | Contract                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeAdapter` | `class NativeAdapter implements RuntimeAdapter` | The fifth peer runtime's `RuntimeAdapter`. `id = 'clawboo-native'`, `participantKind = 'agent'`. Constructed with a per-run `NativeDriverFactory` (and an optional `healthCheck`); `start()` mints a fresh driver per `sessionKey`, `events()` maps the driver's native stream to `RuntimeEvent` and late-binds `runId` from the first frame. |

`NativeAdapter.capabilities()` returns: `streaming`, `mcp`, `worktrees`, `resume`, `toolApproval` all `true`; `contextWindowTokens: 200000`; `runtimeClass: 'native'`; `nativeHome: { scope: 'per-identity', persist: true }`; `nativeSkills: 'none'`; `nativeMemory: 'preserve'`; `nativeChannels: 'none'`; `nativeScheduler: false`. It also exposes a `sessionCodec` that serializes the captured native session id so a same-runtime resume continues the persisted transcript.

### Types & interfaces

| Export                | Kind       | Contract                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeEvent`         | union type | The lifecycle event the in-process harness emits directly (no scraping): `init` \| `text` \| `tool-call` \| `tool-result` \| `error` (non-terminal, typed, `fatal` flag) \| `turn` (one per provider response; `usage` is the turn delta, `costUsd` the turn's USD) \| `result` (terminal; `ok`, `summary`, optional `aborted`/`maxTurns`/`usage`/`costUsd`/`errorCode`). |
| `NativeDriver`        | interface  | The injected seam, the structural slice of a running conversation the adapter drives: `start()`, `onEvent(handler) → unsubscribe`, `abort()`, `setModel(model)`, `writeContext(key, value)`. One instance per run; the real driver hosts the turn loop, tests pass a double.                                                                                              |
| `NativeDriverFactory` | type       | `(opts: StartOpts) => NativeDriver`, fresh driver per run; the adapter calls it in `start()`.                                                                                                                                                                                                                                                                             |
| `MapContext`          | interface  | `{ runId: string \| null; sessionId: string \| null }`, the run/session ids `mapNativeEvent` stamps onto every emitted event base.                                                                                                                                                                                                                                        |
| `AgentConfig`         | type       | `z.infer<typeof agentConfigSchema>`, the normalized native-agent shape: identity (`systemPrompt`), routing (`primaryProvider`/`primaryModel`/`fallbacks`/`envVar`), tool toggles (`memory`/`tools`/`tasks`/`teamchat`/`custom`), `participantKind`, `maxTurns`, `budgetUsd`, timestamps, and a dormant `tenantId`.                                                        |
| `KnownProvider`       | type       | `(typeof KNOWN_PROVIDERS)[number]`: `'anthropic' \| 'openai' \| 'openrouter' \| 'ollama' \| 'google' \| 'xai' \| 'groq' \| 'mistral' \| 'together' \| 'cerebras' \| 'moonshot'`.                                                                                                                                                                                          |

### Constants

| Export                     | Type                | Contract                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentConfigSchema`        | `z.ZodObject`       | The zod schema validating a stored `AgentConfig` blob. Provider/model are open-set strings (a custom OpenAI-compatible id is allowed).                                                                                                                                                                                                                                                                                             |
| `DEFAULT_AGENT_CONFIG`     | `AgentConfig`       | The fallback config when an agent id has no stored config: anthropic + `claude-haiku-4-5`, Memory / Tools / TeamChat on with Tasks `'read'` (a corrupt-blob fallback must never hand a team agent full board writes), `maxTurns: DEFAULT_MAX_TURNS`, `budgetUsd: null`.                                                                                                                                                            |
| `DEFAULT_MAX_TURNS`        | `number`            | `16`, the default turn ceiling for a native conversation.                                                                                                                                                                                                                                                                                                                                                                          |
| `KNOWN_PROVIDERS`          | `readonly string[]` | `['anthropic', 'openai', 'openrouter', 'ollama', 'google', 'xai', 'groq', 'mistral', 'together', 'cerebras', 'moonshot']`, the first-party providers; the last seven are OpenAI-compatible extras the native harness reaches through a base-URL override. The schema accepts any provider string, but routing recognizes only these eleven ids (`routeCall.ts` throws `unknown provider` for anything else).                       |
| `NATIVE_PROVIDER_ENV_VARS` | `readonly string[]` | Every non-keyless provider env-var name (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `CEREBRAS_API_KEY`, `MOONSHOT_API_KEY`), the full set a multi-provider native agent might have a key stored under. The runtime descriptor derives `altEnvVars` from it, so a key for any one of them satisfies the credential check. |

<Note>
The `turn` event carries the per-response token delta, not a running total; the host records spend per `cost` event so the budget kill-switch sees live mid-run spend. On the terminal `result`/`done`, `usage.inputTokens` is the final turn's input (≈ live context size, the rotation watermark's signal) and `costUsd` is the run-cumulative total (never re-billed). See [the executor runner internals](/internals/executor-runner).
</Note>

<Note>
`tenantId` (on `AgentConfig`) is a dormant multi-tenant seam, always `null` today. `participantKind` is an open-set string (`'agent'` today; a human teammate slots in without code branching). Both are future seams, not built.
</Note>

## Used by

- `apps/web/server/lib/runtimes/index.ts`, wires `NativeAdapter` into the runtime registry with the real server-side driver factory.
- `apps/web/server/lib/runtimes/native/*`, the harness (`nativeDriver.ts`, `conversation.ts`, `routeCall.ts`, `agentConfigStore.ts`) consumes `NativeDriver`/`NativeEvent`, `AgentConfig`, `DEFAULT_MAX_TURNS`, `envVarForProvider`, `parseAgentConfig`, `DEFAULT_AGENT_CONFIG`.
- `apps/web/server/lib/agentSource/clawbooNativeAgentSource.ts`, uses `agentConfigSchema` / `DEFAULT_AGENT_CONFIG` / `AgentConfig` to mint and persist native agent rows.
- `apps/web/server/api/onboardingSeed.ts` and `apps/web/server/api/runtimes.ts`, use `envVarForProvider` / `KNOWN_PROVIDERS` for native key routing.

## Source

Barrel: [`packages/adapters/native/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/adapters/native/src/index.ts). Single export entry (`.`); no subpath barrels.

## See also

- [@clawboo/executor](/reference/packages/executor), the `RuntimeAdapter` trait, `RuntimeEvent` union, and `createAsyncQueue` this adapter implements/uses.
- [Native runtime](/runtimes/native), the in-process harness end to end.
- [The RuntimeAdapter trait](/internals/runtime-adapter), the contract every adapter satisfies.
- [@clawboo/adapter-openclaw](/reference/packages/adapter-openclaw), [@clawboo/adapter-claude-code](/reference/packages/adapter-claude-code), [@clawboo/adapter-codex](/reference/packages/adapter-codex), [@clawboo/adapter-hermes](/reference/packages/adapter-hermes), the sibling runtime adapters.
