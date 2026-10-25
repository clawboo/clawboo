---
title: Codex runtime
description: 'The codex runtime: hosts each run in codex app-server, signs in with your ChatGPT subscription, takes comments mid-run, resumes threads across runs, reports no USD cost, and can lead a team.'
---

`codex` is the [runtime](/appendices/glossary) that drives OpenAI's Codex CLI: Clawboo installs the `codex` binary, starts a `codex app-server` for each run in an isolated home, and reshapes its notifications into the normalized [RuntimeEvent](/appendices/glossary) stream every other runtime emits. It is one of the five runtimes, a co-equal peer beside `openclaw`, `clawboo-native`, `claude-code`, and `hermes`.

Codex differs from the other CLI runtimes in two ways that matter operationally: it authenticates through an **interactive ChatGPT OAuth login** (`codex login`), not a pasted API key; and it reports **no USD cost**, so spend is surfaced as token usage with an explicitly estimated, null dollar figure. Because the credential is a ChatGPT account, Codex is also the runtime a **ChatGPT-subscription user without any API key** runs their whole team on: the onboarding wizard's OpenAI card offers **Sign in with ChatGPT** (Recommended, the economical path), deploys every agent on Codex, and designates a Codex agent as the team's universal leader. Use this page to understand its capabilities, how to install and connect it, how the driver works, and how a Codex agent leads a team.

<Note>
**Authentication posture.** Clawboo only ever drives OpenAI's official CLI, whether you run `codex login` yourself in a terminal or click **Sign in with ChatGPT** and let Clawboo's local server spawn that same command for you. It never performs the OAuth exchange itself, never reads or refreshes the token, and never calls the ChatGPT backend directly: the CLI does its own auth and you authorize in your own browser on OpenAI's page.
</Note>

## What it is

Codex is a [wrapped one-shot](/appendices/glossary) runtime. It is a thin [RuntimeAdapter](/appendices/glossary) (`@clawboo/adapter-codex`) constructed with a per-run driver factory. The real driver hosts each run in `codex app-server`, Codex's JSON-RPC server over stdio: it starts or resumes a thread, runs one turn, translates the server's notifications into the adapter's `CodexNativeEvent` union, and shuts the server down when the turn completes. The app-server is used rather than one-shot `codex exec` because it is the only Codex surface that takes input while a turn is running, which is how a comment on a task reaches a Codex agent mid-run (see [steering](#steering-a-running-task)). A Codex too old to have an app-server fails the handshake before any turn starts, and the run falls back to `codex exec --json`, which works as before but cannot be steered. The runtime differences live entirely in the mapper and the driver; the adapter's trait surface is identical to Claude Code's.

Two properties shape the whole runtime:

- **Text streams as deltas.** The app-server streams each agent message as `item/agentMessage/delta` notifications, which the driver passes on as `text` native events and the mapper turns into `text-delta` [RuntimeEvents](/appendices/glossary). A message that arrives whole (no deltas, or a block-emitting `codex exec` on the fallback) becomes one synthesized delta; the adapter declares `streaming: true` either way.
- **No USD cost.** Codex carries token `usage` but reports no dollar figure. A `result` with usage therefore yields a `cost` event with `costUsd: null` and `estimated: true`, never a concrete USD, the honest signal that the host's budget kill-switch sees usage but cannot price the run.

<Note>
Codex is a peer, not a substitute. Clawboo never migrates a `codex` agent into any other runtime's agent (or vice versa); the adapter package ships no cross-runtime agent-file mapping. A [team](/appendices/glossary) can mix a Codex specialist with agents on any other runtime.
</Note>

## Capabilities

The Codex adapter reports the following capabilities. Callers branch on these (never on the runtime id), so they describe what the host may do with a Codex run.

| Capability        | Value                                      | Meaning                                                                                                 |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `streaming`       | `true`                                     | Text surfaces as deltas (synthesized from whole blocks when needed)                                     |
| `mcp`             | `true`                                     | Attaches Clawboo's MCP servers via a generated `config.toml`                                            |
| `worktrees`       | `true`                                     | Gets an isolated git [worktree](/appendices/glossary) for file-mutating tasks                           |
| `resume`          | `true`                                     | Thread continuity via `thread/resume` (see [session resume](#session-resume))                           |
| `toolApproval`    | `true`                                     | Tool calls go through the broker's approval pipeline                                                    |
| `steering`        | `'live'`                                   | A comment is added to the turn in progress with `turn/steer` (see [steering](#steering-a-running-task)) |
| `models`          | `['gpt-5-codex', 'gpt-5', 'o4-mini']`      | A routable surface, not an exhaustive list                                                              |
| `runtimeClass`    | `'wrapped-oneshot'`                        | Resolves to the plain one-shot integration plan                                                         |
| `nativeHome`      | `{ scope: 'per-identity', persist: true }` | A managed per-agent `CODEX_HOME` that persists sessions across runs                                     |
| `nativeSkills`    | `'none'`                                   | No native skills dir to preserve                                                                        |
| `nativeMemory`    | `'none'`                                   | No cross-run self-improvement substrate                                                                 |
| `nativeChannels`  | `'none'`                                   | The shared MCP spine is the only voice                                                                  |
| `nativeScheduler` | `false`                                    | The host owns when-to-run                                                                               |

Because `nativeHome` is `{ scope: 'per-identity', persist: true }`, the integration planner materializes a **persistent managed `CODEX_HOME`** per agent under Clawboo's own state dir, which is what makes session resume work: Codex writes its session files there, and a later run can resume them. Your real `~/.codex` is never the run home; the driver seeds a copy of its `auth.json` into the managed home (see [authentication](#2-authenticate-with-codex-login-oauth)). The shared plane (board, memory, tools) is reached through MCP.

## How to install and connect

The install/connect/disconnect mechanics are shared with the other CLI runtimes and run from the **Runtimes** panel; see [Connecting runtimes](/runtimes/connecting-runtimes) for the card UI, the encrypted vault, and the resolution chain. The Codex specifics are below.

### 1. Install the CLI

Codex is installed via npm. From the `not-installed` state, the card opens `POST /api/runtimes/codex/install`, a Server-Sent Events stream that runs:

```bash
npm install -g @openai/codex@0
```

The package is pinned to the current `0.x` major so a future `1.0` is never auto-installed. If `npm` is not found, the stream emits an `error` event with code `NPM_MISSING`. The runtime's health binary is `codex`, resolved by `resolveRuntimeBin` over PATH plus the well-known user-install dirs.

### 2. Authenticate with `codex login` (OAuth)

This is where Codex departs from the other api-key runtimes. Codex authenticates via an interactive ChatGPT OAuth flow, and it **cannot be connected with a pasted API key on current versions**. The descriptor declares `authKind: 'oauth'`, `envVar: null`, and `headlessAuth: false`; there is no vault slot for a Codex credential.

`POST /api/runtimes/codex/connect` is therefore a no-op on storage. It probes the login (`codex login status`) and returns the CURRENT state, plus the terminal login command when one is still needed:

```json
{ "ok": true, "connectionState": "needs-login", "loginCommand": "codex login" }
```

The card offers a one-click **Sign in with ChatGPT**: Clawboo's local server spawns `codex login` for you (`POST /api/auth/cli-login/codex`, an SSE stream that relays the CLI's own user-facing output), the CLI opens your browser and waits on its localhost callback, and you approve there, with nothing to type. When the login lands, the server re-probes the real auth store and the card re-checks itself. If the CLI is missing, the platform is unsupported, or the spawn fails, the card degrades to the copyable `codex login` command: run it in your own terminal, then click **Re-check**. The status probe DETECTS an existing login (`codex login status` is parsed, never the token file), so a user who signed in before ever opening Clawboo reads `ready` immediately. Once signed in, every spawned run gets a managed `CODEX_HOME` seeded with a copy of your `~/.codex/auth.json` (copy-only, freshness-checked so a rotated refresh token in the managed home is never clobbered; the real `~/.codex` is never written). Clawboo never stores a Codex credential in its vault, and `disconnect` is likewise a no-op for Codex.

<Info>
The connection state machine reflects this: an installed `oauth` runtime reads `ready` when the login probe detects a signed-in Codex, `needs-login` otherwise; it never reaches `ready` from a vault key.
</Info>

### 3. Run a board task

`POST /api/runtimes/codex/run` drives a board task on Codex end to end: claim → worktree → run → report-up. The driver:

1. Uses the managed per-agent `CODEX_HOME` (created `0700` on first run; a run with no agent identity falls back to a throwaway `mkdtemp` home).
2. Seeds a copy of your `~/.codex/auth.json` into the managed home if the managed copy is missing, unusable, or older than yours (Codex rotates refresh tokens inside the managed home, so a blind re-copy would break it). No usable auth anywhere and no API key → the run fails fast with `no Codex credentials provisioned` instead of sending an unauthenticated request.
3. Writes a `config.toml` pointing Codex's MCP client at this server's hosted Tasks, Memory, Tools, and TeamChat servers (the run's [memory](/concepts/memory) scope is appended to the Memory server's URL only).
4. Starts `codex app-server` with `CODEX_HOME` set, as a process-group leader so the whole tree can be killed on abort. Over its stdio it sends `initialize`, then `thread/start` with approval policy `never` and sandbox `danger-full-access` (or `thread/resume` with the prior thread id when a resume handle is provided), then one `turn/start` carrying the prompt.
5. If the app-server handshake fails (a Codex without app-server), falls back to `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [--model <m>] <prompt>`, or `codex exec resume <session-id> …` when a resume handle is provided.

The headless posture is deliberate on both paths: the worktree is the isolation boundary (and already a git repo), so Codex's own sandbox and approval prompts are turned off and Clawboo gates externally instead. A request the app-server sends anyway (an approval, an elicitation, a question for the user) is answered with a refusal, so a turn never waits on a person who is not there. Clawboo's own server secrets are scrubbed from the child environment before the untrusted subprocess inherits it; only the explicitly granted env is merged on top.

## How the driver works

The driver buffers native events until the adapter subscribes (so frames emitted between `start()` and the first listener are never dropped), and it produces **exactly one terminal `result` per run**.

### Event translation

The app-server speaks newline-delimited JSON-RPC: responses to the driver's requests, notifications about the turn, and the occasional request of its own. The driver translates the notifications:

| App-server message                                                                               | Native event                          | Notes                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `thread/start` or `thread/resume` response                                                       | `thread`                              | The thread id is the run's resume handle                                                 |
| `item/agentMessage/delta`                                                                        | `text`                                | Incremental; a second message in the same turn starts on its own paragraph               |
| `item/completed` (`agentMessage`)                                                                | `text`, only if it streamed no deltas | The last completed message is the run's summary                                          |
| `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`                                    | `text` (channel `reasoning`)          | Private reasoning, separated from assistant text                                         |
| `item/started` (`commandExecution`, `mcpToolCall`, `fileChange`, `webSearch`, `dynamicToolCall`) | `tool-call`                           | A shell command is named `shell`; an MCP tool keeps its bare name (e.g. `team_delegate`) |
| `item/completed` for those items                                                                 | `tool-result`                         | `isError` from the item's status, the command's exit code, or the MCP error              |
| `thread/tokenUsage/updated`                                                                      | _(accumulated)_                       | The run reports its own tokens: thread usage from before its first request is subtracted |
| `error` that will not be retried                                                                 | _(remembered)_                        | Becomes the failure reason if the turn fails                                             |
| `turn/completed`                                                                                 | `result`                              | `completed` is a success; `failed` carries the turn's error                              |

### The terminal `result`

The run's one terminal comes from `turn/completed`, after which the driver shuts the app-server down. If the app-server exits before the turn completes, the driver synthesizes the terminal itself:

- A deliberate abort (Clawboo killed the process tree) → `result` with `aborted: true`, mapped to a clean `done: aborted` terminal rather than a spurious error.
- Anything else → `result` with `ok: false` and the last reported error (or the server's stderr) as `errorMessage`.

### The `codex exec` fallback

A run that falls back to `codex exec --json` parses stdout line by line with a tolerant translator. Codex 0.136 wraps a content item as `{ type: 'item.completed', item: { ... } }` (older versions as `{ msg: { ... } }`), so the parser reads the inner item when present:

| Codex frame (matched substring)                | Native event                 | Notes                                                  |
| ---------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `thread_id` / `session_id`                     | `thread`                     | The first one becomes the run's late-bound `runId`     |
| `output_text.delta`                            | `text`                       | Incremental Responses-style delta                      |
| `agent_message` / `message`                    | `text`                       | A whole agent-message block (synthesized into a delta) |
| `reasoning`                                    | `text` (channel `reasoning`) | Private reasoning, separated from assistant text       |
| `function_call` / `tool_call` / `exec_command` | `tool-call`                  | Tool/function invocation                               |
| `usage`                                        | _(accumulated)_              | Carried into the terminal cost event                   |
| `completed` / `task_complete` / `turn.done`    | `result`                     | Terminal completion                                    |

If the stream never produced a `result`, the driver synthesizes one when the process exits: a clean exit is `ok: true`, a deliberate abort is `aborted: true`, and any other exit is `ok: false` with `errorMessage` from stderr (or `codex exited with code <n>`). The synthesis is idempotent, so a spawn that fires both `error` and `close` still yields one terminal.

### The cost mapping

Codex reports token usage but no USD, so the pure mapper translates a `result` with usage into a `cost` event with `costUsd: null` and `estimated: true`. The accompanying `done` event also carries `costUsd: null`. This is the deliberate asymmetry versus the runtimes that report real dollars; the host gets honest usage counts and an explicit "not priced" signal instead of a fabricated cost.

## Session resume

The adapter defines a `sessionCodec` and the driver captures the thread id from `thread/start`. On a later run the host passes it back and the driver opens the run with `thread/resume`, so the run continues the SAME Codex thread (its rollout lives in the managed `CODEX_HOME`; the `exec` fallback resumes it with `codex exec resume <id>`). This is what gives a Codex team LEADER conversation continuity: each leader turn resumes the previous one via a per-agent-per-team resume pointer, exactly like the native leader. A cross-runtime pickup still rides the prose handoff note in the [worktree](/concepts/worktrees-and-handoff) like any other runtime, and a resume attempt against a stale id self-heals (the failed run clears the pointer, the next turn starts fresh).

## Steering a running task

When you comment on a task a Codex agent is working on, the driver sends the comment with `turn/steer` (`threadId`, the in-progress turn's id as `expectedTurnId`, and the comment as input). Codex adds it to the turn in progress and reads it at its next model call; a command that is already running finishes first. Nothing is stopped, so the run carries on as the same run and reports one result.

- A comment that arrives before the turn has started waits for `turn/start` and then goes in.
- A comment that arrives after the turn completed is refused (the turn id no longer matches); it stays in the agent's mailbox for its next run.
- A run on the `codex exec` fallback cannot be steered; its comments reach the agent through the mailbox at its next run.

See [steering a running task](/runtimes/index#steering-a-running-task) for how comments reach every runtime.

## Leading a team

A Codex agent can be a team's universal leader, which is what makes the ChatGPT-subscription onboarding work end to end (no native key, no Gateway — nothing else can lead):

- **Delegation is a tool call.** Team-orchestrated Codex runs attach a `team_delegate` MCP tool (hosted on the TeamChat server, bound to the run's team). The orchestration engine observes the tool call by NAME and turns it into a real board task — the same signal path every runtime's leader uses. The tool is attached ONLY on orchestrator-driven team runs, so it can never silently no-op elsewhere.
- **The leader is taught per turn.** A coding-runtime leader turn carries a coordination block that teaches `team_delegate` (answer simple questions directly, delegate real work, one summary after results) — injected in the volatile per-turn context, so it reaches existing agents too.
- **Designation is explicit.** A Codex-preferred deploy designates the lead and promotes it to the universal Boo Zero via `POST /api/boo-zero/override` (only when nothing else resolves — an existing native or OpenClaw Boo Zero is never stomped).

## Verify it worked

- `GET /api/runtimes` should show the `codex` entry with `installed: true` once the CLI resolves, `authKind: "oauth"`, `envVar: null`, and `connectionState: "ready"` when you are signed in (`needs-login` otherwise). It never reads `ready` from a stored vault key.
- A successful **Sign in with ChatGPT** re-checks the card for you. After the manual fallback (`codex login` in your own terminal), click **Re-check** in the card to re-probe.
- Run a board task via `POST /api/runtimes/codex/run`. A clean run returns `doneReason: 'success'` with `costUsd: null` and `usedWorktree: true`.

## Troubleshooting

<Warning>
**Codex shows "Needs login" after a successful `codex login`.** Click **Re-check** to re-probe (`codex login status` is parsed; a signed-in Codex reads `ready`). Codex never reaches `ready` from a vault key; its auth lives in `CODEX_HOME`, and `connect`/`disconnect` are no-ops on storage.
</Warning>

<Warning>
**A run reports `costUsd: null`.** This is correct, not a bug. Codex reports token usage but no USD, so the mapper surfaces `cost` with `costUsd: null, estimated: true`. The budget kill-switch sees usage but cannot enforce a dollar cap on a Codex run.
</Warning>

<Warning>
**Comments on a Codex task only arrive at the agent's next run.** The run fell back to `codex exec` because the installed Codex has no `app-server` (the handshake failed). Update the CLI (`npm install -g @openai/codex@0`) so runs are hosted in the app-server and can take comments mid-turn.
</Warning>

<Warning>
**A run fails with `no Codex credentials provisioned`.** The managed `CODEX_HOME` had no usable auth to seed: run `codex login` in your terminal (it writes `~/.codex/auth.json`, which the next run seeds into the managed home), then retry. Clawboo deliberately fails fast here rather than sending an unauthenticated request.
</Warning>

## Related

- [Connecting runtimes](/runtimes/connecting-runtimes): the install/connect/disconnect lifecycle and the encrypted vault
- [Runtimes overview](/runtimes/index): the capability matrix across all five runtimes
- [`/api/runtimes` reference](/reference/rest-api/runtimes): full request/response shapes for connect, run, and the install SSE stream
- [The board](/concepts/the-board): the durable task substrate a Codex run drives
- [Worktrees and handoff](/concepts/worktrees-and-handoff): the isolated world a Codex task carries
- [Claude Code](/runtimes/claude-code) · [Clawboo Native](/runtimes/native) · [Hermes](/runtimes/hermes): the sibling runtimes — Hermes and [OpenClaw](/runtimes/openclaw) can ALSO run on the same ChatGPT subscription (each via its own `openai-codex` login)
- [Environment variables](/reference/environment-variables): `CLAWBOO_HOME`, `CLAWBOO_SECRETS_MASTER_KEY`
