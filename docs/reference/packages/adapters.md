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

|                                  | Claude Code                | Codex                                 | Hermes                                                                  | Clawboo Native                                 | OpenClaw                        | Mock           |
| -------------------------------- | -------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------- | -------------- |
| Package                          | `adapter-claude-code`      | `adapter-codex`                       | `adapter-hermes`                                                        | `adapter-native`                               | `adapter-openclaw`              | `adapter-mock` |
| Runtime id                       | `claude-code`              | `codex`                               | `hermes`                                                                | `clawboo-native`                               | `openclaw`                      | `clawboo-mock` |
| What runs                        | Claude Agent SDK `query()` | `codex app-server`, else `codex exec` | one Hermes gateway Clawboo supervises; a run is a `POST /v1/runs` on it | Clawboo's own loop over the provider API       | the server's Gateway connection | nothing        |
| Healthy when                     | `claude` is found          | `codex` is found                      | Clawboo's own install is there and its gateway has not failed           | a provider key or a set-up Ollama is connected | `agents.list()` answers in 2 s  | always         |
| Steering                         | live                       | live (not on `codex exec`)            | live                                                                    | live                                           | live                            | none           |
| Model change mid-run             | no                         | no                                    | no                                                                      | yes, for later turns                           | yes                             | no             |
| Cost the adapter reports         | provider USD               | tokens, no price                      | tokens, no price                                                        | Clawboo's list price, or tokens                | nothing                         | nothing        |
| Agent state                      | your own home folder       | a managed `CODEX_HOME` per agent      | a Hermes profile per agent in the gateway's home                        | a managed folder per agent                     | the Gateway's own folders       | none           |
| Clawboo MCP servers              | HTTP, in the SDK options   | the home's `config.toml`              | the profile's `config.yaml` `mcp_servers`, one live URL each            | in-process                                     | the Gateway's `mcp.servers`     | none           |
| Approval prompts in Clawboo runs | off                        | off                                   | Hermes's own policy, asked on a Clawboo card                            | asked per shell command                        | Gateway exec approvals          | none           |

"Found" means the binary is on `PATH` or in a per-user install folder. Hermes counts only Clawboo's own install in
its runtimes folder. A managed home lives at `<clawboo home>/runtimes/<runtime id>/<agent id>`; a Hermes agent's
state lives in its profile, `<clawboo home>/runtimes/hermes/_gateway/profiles/cb-<agent id>`. A Codex run with no
agent identity gets a throwaway temporary home instead, and a Hermes run a throwaway profile.

## What every adapter shares

- **Construction.** The Claude Code, Codex, Hermes and Native adapters take `(driverFactory, healthCheck?)` and
  create one driver per run. The OpenClaw adapter takes the Gateway client. The mock takes nothing.
- **Health.** `health()` races the check against two seconds. A timeout or a throw reads as unhealthy.
- **Runs.** `start()` returns `runId: null` (the mock returns `mock-<session key>`). `events()` subscribes when
  called, binds the run id from the first frame that carries one (falling back to the session key), and buffers
  through `createAsyncQueue`.
- **Control.** `abort()`, `setModel()` and `writeContext()` go to the run's driver. The Claude Code, Codex and
  Hermes drivers ignore `setModel()`, because the model is fixed when the run starts. The Claude Code and Codex
  drivers' `writeContext()` writes a file into the run's working folder (nothing when the run has none); the
  Hermes driver's does nothing, since a run's context rides its input.
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
- Hermes follows its own approval policy (`approvals.mode` and, for its own jobs, `approvals.cron_mode`, which
  Clawboo sets before every run to the person's own choice, else `manual` and `deny`; always those with agents as
  their own user). Each command it flags waits on a Clawboo approval card, and the answer goes back to Hermes as
  `once` or `deny`. The card is a check, not a lock: the agent can reach its own profile's key and settings.
- Clawboo Native asks a person before every shell command, and its shell tool is off unless an agent's config
  turns it on.
- OpenClaw decides which commands ask first through its own exec policy; Clawboo shows those requests and relays
  your answer to the Gateway.

A per-task git worktree keeps file changes apart. It is not a sandbox: the process runs with your user's
permissions. See [What agents can do](/concepts/permissions).

## What each adapter reports as cost

The adapter reports what the runtime gives it; the host fills the gaps with estimates. The task runner serves
`POST /api/runtimes/<id>/run` and agent routines, and team chat covers team turns and delegations.

| Runtime                      | The adapter emits                              | Task runner records                        | Team chat records           |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------ | --------------------------- |
| Claude Code                  | a `cost` event with the SDK's `total_cost_usd` | the reported USD                           | the reported USD            |
| Codex                        | token usage with `costUsd: null`               | an estimate from the tokens                | an estimate from the tokens |
| Hermes                       | token usage with `costUsd: null`               | an estimate from the tokens                | an estimate from the tokens |
| Clawboo Native, priced model | per-turn USD from Clawboo's price list         | the reported USD                           | the reported USD            |
| Clawboo Native, other model  | token usage with `costUsd: null`               | an estimate from the tokens                | an estimate from the tokens |
| Clawboo Native, local Ollama | per-turn `costUsd: 0` with `local: true`       | $0, recorded as `local`                    | $0, recorded as `local`     |
| OpenClaw                     | nothing                                        | not run (the task runner refuses OpenClaw) | an estimate from characters |

On both paths, a run that ends without a cost report (a Claude Code run that fails first, say) is estimated from
characters; on the task runner it also logs a `spend_unreported` warning unless it was aborted. An OpenClaw
routine fire skips the task runner. Every fire that runs records an estimate from characters, whether it
succeeded, failed, timed out or was stopped, priced at the routine's model or else the agent's model in
`openclaw.json`.

A token estimate prices the tokens at the model's rate. A model Clawboo has no price for gets the shared default
rate of $3 per million input tokens and $15 per million output tokens. A model the user's own Ollama serves is
free: a Clawboo Native turn on the Ollama provider, or an `ollama/` model id, is recorded at $0, unless its tag
marks one of Ollama's cloud models (`-cloud` or `:cloud`). The run ledger records each figure as `reported`,
`local`, `token-estimate` or `char-estimate`. What users see is described in
[Budgets and spend](/using/budgets-and-spend).

## Claude Code

The driver (`createClaudeCodeDriver`) loads the Claude Agent SDK on demand. The published `clawboo` package does
not ship the SDK. A run loads it from Clawboo's runtimes folder first (`ownAgentSdkDir`, imported by file URL),
else from next to the server, and a run with neither fails with a message that points to Settings, Runtimes,
Install. The SDK's own `total_cost_usd` is passed through unchanged, and its `error_max_turns` result becomes
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
the user to run `codex login`. The adapter's `models` list is empty: OpenAI decides which models a ChatGPT
login may use, so a run names no model unless the agent has one, and Codex runs the plan's default. A failed
run reports the turn's own error, unwrapped from the JSON body OpenAI sends, ahead of the CLI's stderr; a
refused model on a run that named none adds that the Codex CLI is too old for the plan and how to update it.

## Hermes

The driver lives in `apps/web/server/lib/runtimes/hermes/`. It runs every Hermes agent through one long-lived
Hermes gateway that the server supervises, the way OpenClaw agents live in OpenClaw's Gateway. The adapter
declares `streaming: true`, `steering: 'live'`, `toolApproval: true`, `nativeChannels: 'none'` and
`nativeScheduler: true`.

- **Install** (`release.ts`, `install.ts`). `release.ts` pins the release: its tag, commit, tarball sha256 and
  extras. `install.ts` installs it into Clawboo's runtimes folder at `hermes/<tag>`, with the uv and CPython builds
  the release's own `pm/lock.json` pins, each checked against its sha256, and runs `uv sync --frozen` from the
  release's lock file. Clawboo runs only this install; a `hermes` on `PATH` is not used.
- **Gateway** (`gateway.ts`). One `hermes gateway run --external-supervisor -v` with only its API server on, on
  `127.0.0.1` (port 8642, the next free one when it is taken, or `CLAWBOO_HERMES_GATEWAY_PORT`). It starts with a
  short allow-listed environment, never the server's own. The supervisor starts it on demand and at boot when
  there are Hermes agents, restarts it with backoff after an exit it did not ask for, and stops it with the
  server. Health is a keyed call to its API answering, not the process being alive.
- **Profiles** (`profiles.ts`). Each agent is a Hermes profile, `profiles/cb-<agent id>` in the gateway's home,
  reached at `/p/<profile>/` with its own key, derived from one master key in the vault. Before each run the
  driver writes the profile's `.env` (its key, the provider keys, and the run's folder as `TERMINAL_CWD`) and
  keeps three things in its `config.yaml`: a marked `mcp_servers` block, the pinned `terminal:` keys, and
  `approvals.mode` and `approvals.cron_mode`, pinned before each run to the person's own choice, else `manual`
  and `deny` (always those with agents as their own user). When the run lets go of the profile, `TERMINAL_CWD`
  points at the agent's jobs folder, `<work folder>/agents/<agent id>/hermes-jobs`. An agent's old per-agent home moves into its profile on
  its first run, with its memory, skills and sessions.
- **Runs** (`gatewayDriver.ts`, `client.ts`, `sse.ts`, `runSettings.ts`). A run is `POST /p/<profile>/v1/runs`
  with the input (the context block, then the message), a session id, and the provider and model
  `runSettings.ts` picks. Its server-sent events become frames as they arrive: `message.delta` is streamed text,
  `tool.started` and `tool.completed` are a tool call and its result (a preview of the arguments, and whether it
  failed, but no output), and `run.completed` carries the token usage. A steer is `POST .../steer`, which
  reaches the turn after its current tool calls or before its next model call; one that arrives while Hermes
  writes its final answer runs as a follow-up turn in the same run. A passive steer goes in only while a tool
  call is open, so it never buys a turn of its own. Stop is `POST .../stop`. `failure.ts` reads a provider's
  error code out of a failed run's reason.
- **Approvals** (`approvals.ts`). Each `approval.request` on a run's stream becomes a `run_command` approval card
  of kind `hermes`, and the answer goes back to Hermes as `once` or `deny`. "Always" is never sent: Hermes would
  keep it in its own allow list, out of Clawboo's sight.
- **Clawboo's MCP servers.** The gateway connects to them once per profile and keeps the connection, so a
  profile's `mcp_servers` block lists one live URL per server that names only the agent (`live=1`, signed). The
  server binds each call to the agent's run in progress. A run with no identity home (the reviewer's) gets a
  throwaway profile with its own per-run URLs, removed when it ends.

Hermes works one task at a time from Clawboo's board: its own task board is not synced. Its chat channels stay
off, because the gateway runs only its API server. Its own scheduled jobs are listed and changed through the
`hermes-gateway-jobs` schedule source (see [Capability and schedule sources](/internals/seams)). A profile's
`config.yaml` is copied once from your `~/.hermes/config.yaml`; when it names no provider, a run asks for the one
whose key is connected (OpenRouter, Anthropic or OpenAI), or for the ChatGPT sign-in. See
[Hermes](/runtimes/hermes).

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
  from a short list of pinned model ids. A turn the Ollama provider served costs an exact $0 and is flagged
  `local` (Ollama's cloud models excepted); any other model gets `costUsd: null` and is estimated by the host.
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
