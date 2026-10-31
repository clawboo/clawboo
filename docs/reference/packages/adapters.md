---
title: 'Runtime adapters'
sidebarTitle: 'Runtime adapters'
description: 'The six runtime adapter packages compared: how each one drives its runtime, what it reports, how it steers, and where its state lives.'
keywords:
  [
    '@clawboo/adapter-claude-code',
    '@clawboo/adapter-codex',
    '@clawboo/adapter-hermes',
    '@clawboo/adapter-native',
    '@clawboo/adapter-openclaw',
    '@clawboo/adapter-mock',
    'adapter-claude-code',
    'adapter-codex',
    'adapter-hermes',
    'adapter-native',
    'adapter-openclaw',
    'adapter-mock',
    'clawboo-mock',
    'fault injection',
    'CLAWBOO_ENABLE_MOCK_RUNTIME',
    'AgentConfig',
    'mapFrameToRuntimeEvents',
  ]
---

Each runtime Clawboo drives has an adapter package under `packages/adapters/`. Every adapter implements
`RuntimeAdapter` from `@clawboo/executor`, and only the server imports them; they reach users inside the bundled
server of the `clawboo` package.

Use this page when you change an adapter, need to know what a runtime really reports, or want the fault-injection
runtime for a test. The runtimes as users see them are on [Choose a runtime](/runtimes/index), and the steps for a
new one are on [Write a runtime adapter](/reference/packages/executor).

## At a glance

|                                  | Claude Code                | Codex                                 | Hermes                                | Clawboo Native                                 | OpenClaw                        | Mock           |
| -------------------------------- | -------------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------------- | ------------------------------- | -------------- |
| Package                          | `adapter-claude-code`      | `adapter-codex`                       | `adapter-hermes`                      | `adapter-native`                               | `adapter-openclaw`              | `adapter-mock` |
| Runtime id                       | `claude-code`              | `codex`                               | `hermes`                              | `clawboo-native`                               | `openclaw`                      | `clawboo-mock` |
| What runs                        | Claude Agent SDK `query()` | `codex app-server`, else `codex exec` | `hermes chat -q`, one process per run | Clawboo's own loop over the provider API       | the server's Gateway connection | nothing        |
| Healthy when                     | `claude` is found          | `codex` is found                      | `hermes` is found                     | a provider key or a set-up Ollama is connected | `agents.list()` answers in 2 s  | always         |
| Steering                         | live                       | live (not on `codex exec`)            | stop and resume                       | live                                           | live                            | none           |
| Model change mid-run             | no                         | no                                    | no                                    | yes, for later turns                           | yes                             | no             |
| Cost the adapter reports         | provider USD               | tokens, no price                      | nothing                               | Clawboo's list price, or tokens                | nothing                         | nothing        |
| Agent state                      | your own home folder       | a managed `CODEX_HOME` per agent      | a managed `HERMES_HOME` per agent     | a managed folder per agent                     | the Gateway's own folders       | none           |
| Clawboo MCP servers              | HTTP, in the SDK options   | the home's `config.toml`              | the home's `mcp.json`                 | in-process                                     | the Gateway's `mcp.servers`     | none           |
| Approval prompts in Clawboo runs | off                        | off                                   | off                                   | asked per shell command                        | Gateway exec approvals          | none           |

"Found" means the binary is on `PATH` or in a per-user install folder (for Hermes, the pip and pipx user
folders). A managed home lives at `<clawboo home>/runtimes/<runtime id>/<agent id>`. A Codex or Hermes run with no
agent identity gets a throwaway temporary home instead.

## What every adapter shares

- **Construction.** The Claude Code, Codex, Hermes and Native adapters take `(driverFactory, healthCheck?)` and
  create one driver per run. The OpenClaw adapter takes the Gateway client. The mock takes nothing.
- **Health.** `health()` races the check against two seconds. A timeout or a throw reads as unhealthy.
- **Runs.** `start()` returns `runId: null` (the mock returns `mock-<session key>`). `events()` subscribes when
  called, binds the run id from the first frame that carries one (falling back to the session key), and buffers
  through `createAsyncQueue`.
- **Control.** `abort()`, `setModel()` and `writeContext()` go to the run's driver. The Claude Code, Codex and
  Hermes drivers ignore `setModel()`, because the model is fixed when the run starts, and their `writeContext()`
  writes a file into the run's working folder (nothing when the run has none).
- **Steering.** The per-run adapters steer through `steerThroughDriver`. Their `sessionCodec` serializes the
  session key and the last native session id.
- **Server wiring.** `adapterFactoryFor(id)` in `apps/web/server/lib/runtimes/index.ts` builds the non-OpenClaw
  adapters, and gives the CLI drivers the attach secret so their MCP URLs pass the access gate. OpenClaw adapters
  come from the server's shared Gateway connection (`buildOpenClawServerAdapter`).

## Approvals and isolation

All five real adapters declare `toolApproval: true`, which describes the runtime and not Clawboo's runs:

- Claude Code runs with `permissionMode: 'bypassPermissions'`.
- Codex runs with approval policy `never` and sandbox `danger-full-access`; its `codex exec` fallback passes
  `--dangerously-bypass-approvals-and-sandbox`.
- Hermes runs with `--yolo` and `--accept-hooks`.
- Clawboo Native asks a person before every shell command, and its shell tool is off unless an agent's config
  turns it on.
- OpenClaw decides which commands ask first through its own exec policy; Clawboo shows those requests and relays
  your answer to the Gateway.

A per-task git worktree keeps file changes apart. It is not a sandbox: the process runs with your user's
permissions. See [What agents can do](/concepts/permissions).

## What each adapter reports as cost

The adapter reports what the runtime gives it; the host fills the gaps with estimates. The task runner serves
`POST /api/runtimes/<id>/run` and agent routines, and team chat covers team turns and delegations.

| Runtime                      | The adapter emits                              | Task runner records                         | Team chat records           |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------- | --------------------------- |
| Claude Code                  | a `cost` event with the SDK's `total_cost_usd` | the reported USD                            | the reported USD            |
| Codex                        | token usage with `costUsd: null`               | an estimate from the tokens                 | an estimate from the tokens |
| Hermes                       | nothing                                        | no spend, with a `spend_unreported` warning | an estimate from characters |
| Clawboo Native, priced model | per-turn USD from Clawboo's price list         | the reported USD                            | the reported USD            |
| Clawboo Native, other model  | token usage with `costUsd: null`               | an estimate from the tokens                 | an estimate from the tokens |
| OpenClaw                     | nothing                                        | not run (the task runner refuses OpenClaw)  | an estimate from characters |

An OpenClaw routine fire skips the task runner, and a successful one records an estimate from characters.

A token estimate prices the tokens at the model's rate. A model Clawboo has no price for, a local Ollama model
included, gets the shared default rate of $3 per million input tokens and $15 per million output tokens. The run
ledger records each figure as `reported`, `token-estimate` or `char-estimate`. What users see is described in
[Budgets and spend](/using/budgets-and-spend).

## Claude Code

The driver (`createClaudeCodeDriver`) loads the Claude Agent SDK on demand. The published `clawboo` package does
not ship the SDK, so a run on an install without it fails with a message that says how to install it alongside
Clawboo. The SDK's own `total_cost_usd` is passed through unchanged, and its `error_max_turns` result becomes
`done` with reason `max_turns`. A steer goes in as a user message with priority `next`, which the CLI reads at its
next turn boundary.

Clawboo provisions no home for Claude Code: the SDK runs as your user, with your own home folder and Claude
login. The connected Anthropic key, when there is one, is passed in the run's environment.

## Codex

The driver hosts each run in `codex app-server` and falls back to `codex exec` for a Codex without it. Only the
app-server path can be steered (`turn/steer`); on the fallback a steer is refused as `rejected`. A thread resumes
through `thread/resume`, or `codex exec resume <id>` on the fallback.

Each agent gets a managed `CODEX_HOME`, so session files survive between turns. The driver copies your
`codex login` credentials (`~/.codex/auth.json`) into it and never writes them back. A managed home with no
usable login and no API key fails fast with `no Codex credentials provisioned for managed home <path>` and asks
the user to run `codex login`. The adapter's `models` list is informational; nothing in the host reads it.

## Hermes

The driver runs `hermes chat -q <prompt> -Q` once per run. In that quiet mode, response lines become message
frames, the `session_id:` line on stderr becomes the resume handle, and the final result is built from the exit
code. Hermes reports no tool calls and no token usage, so a Hermes run shows no tool activity and emits no `cost`
event.

Steering is stop and resume (`interrupt-resume`): the driver stops the process and resumes the same session with
the message as the next input, and the host still sees one run. A passive steer is refused, because it must never
stop a run. Each agent gets a managed `HERMES_HOME` where its skills and memory persist, and the driver writes all
four Clawboo MCP servers into that home's `mcp.json`. Hermes ships its own scheduler, but Clawboo never
runs it for teammates.

Hermes works one task at a time from Clawboo's board: its own task board is not synced, and Clawboo never starts
`hermes gateway`, so Hermes's chat channels stay off. The home is seeded once from your `~/.hermes/config.yaml`;
with no config, the driver picks `--provider` from whichever key is connected (OpenRouter, Anthropic or OpenAI).

## Clawboo Native

The package holds the adapter, the event mapper and the `AgentConfig` schema; the conversation loop, provider
clients and MCP bridge live in `apps/web/server/lib/runtimes/native/`. Each agent's config is stored in the
`settings` table under `native-agent-config:<agent id>` and validated with `agentConfigSchema` on every load, so a
corrupt value falls back to `DEFAULT_AGENT_CONFIG` instead of crashing a run.

- **Fields.** `systemPrompt`, `primaryProvider`, `primaryModel`, `fallbacks`, `envVar` (the vault slot's name,
  never the key), `tools` (`memory`, `tools`, `tasks` as `true`, `false` or `'read'`, `teamchat`, an optional
  `shell` that is off when absent, `custom`), `maxTurns`, and `budgetUsd`. A `budgetUsd` value creates an
  agent-scope hard-cap budget when the agent is created; `null` keeps the track-and-warn default.
- **Providers.** `KNOWN_PROVIDERS` lists `anthropic`, `openai`, `openrouter` and `ollama`, plus the
  OpenAI-compatible `google`, `xai`, `groq`, `mistral`, `together`, `cerebras` and `moonshot`. The schema accepts
  any provider string, but only these route: an unknown primary provider fails with `unknown provider: <id>`.
  `envVarForProvider` returns each provider's key variable, and `null` for keyless Ollama.
- **Defaults.** An agent created without a provider takes the user's recorded default native provider, else the
  first connected provider in `KNOWN_PROVIDERS` order. `DEFAULT_AGENT_CONFIG` (Anthropic, `claude-haiku-4-5`,
  read-only Tasks, no shell) only fills in for an agent with no stored config.
- **Cost.** Each provider response produces a `turn` frame with that response's token delta. Clawboo prices it
  from a short list of pinned model ids; any other model gets `costUsd: null` and is estimated by the host. A 1:1
  chat with a native agent records spend only for priced turns.
- **Context window.** `contextWindowTokens` is a deliberate over-estimate, because one number cannot fit every
  provider. A run that overflows a smaller window ends with a typed error instead.

## OpenClaw

The adapter drives agents over the server's live OpenClaw Gateway connection. It takes a structural
`OpenClawGatewayClient`, so tests pass an in-memory double. Team chat builds one per delivery through
`buildOpenClawServerAdapter()` (which returns `null` while the Gateway is down), and the Routines wake bridge
builds one for OpenClaw routine fires.

- **Start.** `start()` sends `chat.send` with `deliver: false` and a fresh idempotency key, the context placed above
  the message. An acknowledgement that did not start a run (`accepted: false`, or a no-run status) throws, so the
  caller can release the task instead of waiting for frames that never come.
- **Events.** `events()` subscribes at once and keeps observing the session across runs, rebinding the run id from
  each frame.
- **Control.** `abort()` sends `chat.abort` for the bound run and always `sessions.abort` as a backstop.
  `setModel()` is `sessions.patch`. `writeContext()` sets an agent file, which a running session does not re-read.
- **Steering.** A steer is `chat.send` with `queueMode: 'steer'`, delivered when the Gateway confirms the steer's
  own run. Frames for a steer's run id are kept out of `events()`. A steer still unread when the run ends is
  cancelled and reported as `run-ended`, and so is a steer for a session this adapter has no live run on.
- **No worktrees, no task runner.** `runtimeClass: 'connected-substrate'` makes the task runner refuse OpenClaw
  (`connected_substrate`) before it claims anything, and `worktrees: false` means OpenClaw works in its own
  Gateway-owned folders.
- **No MCP attach.** `mcp: false` means the adapter attaches nothing. The OpenClaw agent source registers Clawboo's
  Memory, Tasks and Tools servers in the Gateway config's `mcp.servers`, without an agent identity, so the MCP
  servers treat OpenClaw sessions as unverified callers. See [@clawboo/mcp](/reference/packages/mcp).
- **No cost events.** The Gateway sends no token usage, so Clawboo estimates OpenClaw spend from characters.

`mapFrameToRuntimeEvents` is pure. The server's session activity watcher also uses it on its own, to show tool
activity from OpenClaw runs Clawboo did not start (an OpenClaw cron job, a message from a chat channel).

| Gateway frame                       | Events                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `chat` delta                        | assistant and reasoning `text-delta`, plus any tool calls and results in the message |
| `chat` final                        | tool calls and results, then `done` with reason `success`                            |
| `chat` aborted                      | `done` with reason `aborted`                                                         |
| `chat` error                        | a fatal `error`, then `done` with reason `error`                                     |
| `agent` lifecycle start, end, error | `status` running, `status` turn-complete, a fatal `error`                            |
| `agent` tool stream                 | `tool-call` on start and `tool-result` on result; updates are dropped                |
| `agent` other streams               | `text-delta` (reasoning when the stream is a reasoning stream)                       |
| `session.message`                   | `tool-call` and `tool-result` only, never text or `done`                             |
| anything else                       | nothing                                                                              |

Tool results from the `agent` tool stream and from `session.message` frames are cut at 4,000 characters and end
with a note of how many were not recorded.

## Mock (fault injection)

`@clawboo/adapter-mock` is a real runtime, `clawboo-mock`, not a test double. It reproduces silence, crashes, open
tool calls and slow starts through the same server paths a real runtime uses. It executes nothing: every tool
call is a synthesized event.

The server offers it only when `CLAWBOO_ENABLE_MOCK_RUNTIME` is exactly `1`. Then team turns, delegations and agent
routines can route to an agent whose runtime is `clawboo-mock`, and `GET /api/runtimes` lists it under `runtimes`
(never under `available`). The dashboard draws runtime cards from its own catalog, so it never shows the mock,
and a test seeds that agent row directly (as the wake bridge tests do).

The run's message and context carry the faults as directives, one per line: a `!word` at the start of a line,
optionally indented. Other lines are ignored, and a message with no directive ends in `done: success` with the
summary `mock run complete`.

| Directive          | Effect                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| `!ok <text>`       | emits the text (default `ok`), which also becomes the run's summary     |
| `!silent <ms>`     | emits nothing for that long (default 1 second)                          |
| `!toolcall <name>` | a tool call that never gets a result (default name `build`)             |
| `!error <message>` | one fatal `error` with code `mock`, then the stream ends with no `done` |
| `!abort`           | holds the run open until it is aborted, then `done: aborted`            |
| `!loop <n>`        | n identical tool call and result pairs (default 3, at most 50)          |
| `!slowstart <ms>`  | delays `start()` (default half a second)                                |
| `!crash`           | throws from `events()`                                                  |

Delays are capped at ten minutes. The mock declares no worktrees, no resume and no steering, and `setModel()` and
`writeContext()` do nothing.

## Related

- [Write a runtime adapter](/reference/packages/executor): build and test a new adapter.
- [The RuntimeAdapter trait](/internals/runtime-adapter): the interface and the server wiring checklist.
- [Choose a runtime](/runtimes/index): the runtimes and their capabilities as users see them.
- [What agents can do](/concepts/permissions): the safety posture of each runtime.
- [Budgets and spend](/using/budgets-and-spend): how real and estimated costs reach the dashboard.
