---
title: System maintenance
description: Manage OpenClaw from the System panel: gateway control, default model, API keys, agent coordination, and updates.
---

Use the **System** panel when you want to operate the OpenClaw [Gateway](/appendices/glossary) and its config from inside the dashboard instead of the terminal: start/stop/restart the Gateway, pick the default model, store provider API keys, toggle agent-to-agent coordination, and check for OpenClaw updates. The panel manages **OpenClaw only**; the other runtimes (`clawboo-native`, `claude-code`, `codex`, `hermes`) are managed from the [Runtimes](/runtimes/connecting-runtimes) panel.

Everything on this page is `MaintenancePanel` (`features/maintenance/`) talking to the `/api/system/*` routes. The panel reads `GET /api/system/status` and `GET /api/system/openclaw-config` on mount and writes back through `PATCH /api/system/openclaw-config`, SSE `POST /api/system/gateway`, and SSE `POST /api/system/install-openclaw`.

## Prerequisites

<Note>
The System panel is built for the OpenClaw path. If you are running native-only (no Gateway), most sections still render but have nothing to act on; the Gateway controls report **Stopped**, and the Agent Coordination, Command Approval, and per-model hot-reload paths only render or take effect when a live Gateway `client` is connected.
</Note>

- OpenClaw installed (the System Info section shows the detected version, or "Not installed").
- The dashboard running (`npx clawboo`); the System panel is a nav view inside it.

## Where it lives

Open it from the **System** nav button in the left sidebar (the gear / `Settings` icon, in the secondary nav group), or press **Cmd/Ctrl + 6**. The panel is a single scrollable column of sections separated by thin dividers: Gateway, Default Model, API Keys, Boo Zero, Agent Coordination, Command Approval, and System.

## Steps

### Control the Gateway

The **Gateway** section (`GatewayControls`) shows a live status row and three control buttons.

- The status row is a pulsing dot + **Running** / **Stopped**, the bound port (e.g. `:18789`), and, when running and Clawboo manages the process, an **uptime** label. Status comes from `GET /api/system/status`, which the component polls every 10 seconds. `uptimeMs` is only populated when the Gateway PID is one Clawboo started (`managedByClawboo`); a Gateway you launched yourself reads as Running with no uptime.
- **Start** and **Restart** stream `POST /api/system/gateway` as Server-Sent Events. The component renders each line in a collapsible terminal log (**Show log** / **Hide log**). Start polls the port for up to 60 seconds before reporting success or a `TIMEOUT` error.
- **Stop** is a plain JSON `POST /api/system/gateway` (`{ action: "stop" }`); it sends `SIGTERM`, waits up to 2 seconds, then `SIGKILL`s if needed, and reports `{ ok, stopped }`.

The buttons disable themselves to match state: **Start** is disabled while running or busy; **Stop** and **Restart** are disabled while stopped or busy.

| Action  | Request                                            | Transport                            |
| ------- | -------------------------------------------------- | ------------------------------------ |
| Start   | `POST /api/system/gateway` `{ action: "start" }`   | SSE (progress/output/complete/error) |
| Restart | `POST /api/system/gateway` `{ action: "restart" }` | SSE (stops first, then starts)       |
| Stop    | `POST /api/system/gateway` `{ action: "stop" }`    | JSON `{ ok, stopped }`               |

The SSE start/restart stream emits the same event shapes as the install stream: `progress { step, message }`, `output { line }`, `complete { success, … }`, `error { code, message }`.

### Set the default model

The **Default Model** section (`ModelSelector`) is a cascading dropdown: a provider list on the left, that provider's models on the right.

1. Click the model pill (it shows the current model label, or **Not set**).
2. Hover or click a provider to reveal its models, or type in the search box to filter across all providers and models.
3. Click a model. The panel `PATCH /api/system/openclaw-config` with `{ model }`, which writes the id to `agents.defaults.model.primary` in `openclaw.json`. A success toast confirms **Default model updated**.

When the dropdown is open, providers without a configured API key show a **No key** badge, and selecting a model under an unconfigured provider is blocked (the right column shows **API key not configured**). Local providers (`ollama`, `sglang`, `opencode`, `opencode-go`) are never greyed out. The "configured" set comes from `GET /api/system/models`, which reports `configuredProviders` based on detected env keys and per-agent `auth-profiles.json`.

<Tip>
Need a model the catalog does not list? Use **Custom model…** at the bottom of the provider list and type a `provider/model-id` string (the **Use** button enables only once the value contains a `/`). The model id is sent through the same `{ model }` PATCH.
</Tip>

If a Gateway `client` is connected, the panel also attempts a best-effort hot reload (`config.get` for the snapshot hash, then `config.patch` at `agents.defaults.model.primary`). If the hot reload fails, the config file was still updated and the Gateway picks it up on the next turn.

### Manage API keys

The **API Keys** section (`ApiKeyManager`) lists provider rows: seven primary providers, then an **Additional Providers** group of seven more. Each row shows a status dot (mint = configured, grey = not set), the provider label, its env-var name, and a **Configured** / **Not set** label.

1. Click **Update** on a row to reveal an inline masked input (with an eye toggle to reveal/hide).
2. Paste the key and click **Save**.
3. The panel `PATCH /api/system/openclaw-config` with `{ apiKeys: [{ provider, key }] }`, which writes the key to OpenClaw's `.env` (keyed by env-var name) **and** updates every existing agent's `auth-profiles.json`. The row re-fetches and flips to **Configured**.

The provider → env-var mapping the rows use:

| Provider     | Env var written      |
| ------------ | -------------------- |
| Anthropic    | `ANTHROPIC_API_KEY`  |
| OpenAI       | `OPENAI_API_KEY`     |
| Google       | `GEMINI_API_KEY`     |
| OpenRouter   | `OPENROUTER_API_KEY` |
| xAI          | `XAI_API_KEY`        |
| Groq         | `GROQ_API_KEY`       |
| Mistral      | `MISTRAL_API_KEY`    |
| Moonshot     | `MOONSHOT_API_KEY`   |
| MiniMax      | `MINIMAX_API_KEY`    |
| Together     | `TOGETHER_API_KEY`   |
| NVIDIA       | `NVIDIA_API_KEY`     |
| Hugging Face | `HF_TOKEN`           |
| Cerebras     | `CEREBRAS_API_KEY`   |
| Venice       | `VENICE_API_KEY`     |

<Note>
These keys are OpenClaw config; they land in `~/.openclaw/.env` and the per-agent auth profiles, not Clawboo's encrypted runtime vault. The non-OpenClaw runtimes store their keys separately; see [Connecting runtimes](/runtimes/connecting-runtimes).
</Note>

### Toggle agent coordination

The **Agent Coordination** section (`AgentCoordinationToggle`) is a single switch for OpenClaw's `tools.agentToAgent.enabled`. When on, agents can use the routing defined in their `AGENTS.md` to message each other through the Gateway's `sessions_send` tool.

Flipping it `PATCH /api/system/openclaw-config` with `{ agentToAgent: { enabled } }`. The handler also auto-sets `tools.sessions.visibility: "all"` whenever you enable it. The toggle only renders when a Gateway `client` is connected and the current value could be read from `openclaw.json`.

<Note>
A sibling **Command Approval** section sets the default `tools.exec.ask` posture (**Run Freely** / **Ask for Unknown** / **Always Ask**), written via `PATCH /api/system/openclaw-config` `{ exec: { ask } }`. Individual agents can override it. It is OpenClaw-specific and renders only when a Gateway client is connected.
</Note>

### Find Boo Zero settings

The **Boo Zero** section is a breadcrumb, not an editor. The display name and global brief moved to Boo Zero's own agent view (the **Brief** tab), and per-team brief + rules moved to each team's settings sheet (the gear on the team-chat header). The two cards here jump you straight there:

- **Boo Zero: Display name & Global brief** → opens the Boo Zero agent view.
- **Per-team brief & rules** → opens the currently-selected team's chat (or the first team).

See [Boo Zero](/using/boo-zero) for the editors themselves.

### Check version and updates

The **System** section at the bottom shows OpenClaw version, Node.js version, the state dir, and whether `openclaw.json` was found, all from `GET /api/system/status`.

**Check for Updates** runs the OpenClaw installer in place: it streams `POST /api/system/install-openclaw` (which runs `npm install -g openclaw@^2026.5`) as SSE, renders the output in the update log, and on success re-fetches status to show the new version.

## Options / variations

| Section            | What it writes                                                      | Backing route                                          |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------ |
| Gateway            | Process lifecycle (no config write)                                 | `POST /api/system/gateway`                             |
| Default Model      | `agents.defaults.model.primary` in `openclaw.json`                  | `PATCH /api/system/openclaw-config` `{ model }`        |
| API Keys           | `.env` + per-agent `auth-profiles.json`                             | `PATCH /api/system/openclaw-config` `{ apiKeys }`      |
| Agent Coordination | `tools.agentToAgent.enabled` (+ `tools.sessions.visibility: "all"`) | `PATCH /api/system/openclaw-config` `{ agentToAgent }` |
| Command Approval   | `tools.exec.ask`                                                    | `PATCH /api/system/openclaw-config` `{ exec }`         |
| Check for Updates  | reinstalls OpenClaw globally                                        | `POST /api/system/install-openclaw` (SSE)              |

## Verify it worked

- **Gateway**: after **Start**, the status dot turns mint and reads **Running** with a port; the 10-second poll keeps it current. `GET /api/system/status` returns `gateway.running: true`.
- **Default Model**: the model pill updates to the new label and a toast confirms it. Re-open `GET /api/system/openclaw-config` and check `config.agents.defaults.model.primary`.
- **API Keys**: the row's status dot turns mint and the label reads **Configured**; `GET /api/system/openclaw-config` returns the matching `env.has<Provider>Key: true`.
- **Agent Coordination**: the switch shows **Agents can delegate tasks to each other**; `config.tools.agentToAgent.enabled` reads `true`.

## Troubleshooting

<Warning>
**Start times out.** On a cold start (especially Windows) the Gateway can take 30–50 seconds to bind. The start stream polls for up to 60 seconds; if it still has not bound it emits an `error` event with code `TIMEOUT`. Open the log (**Show log**) to see why, then click **Start** again; a second start joins the in-flight launch rather than spawning a duplicate.
</Warning>

<Warning>
**A key shows "Not set" right after saving.** The presence flag requires a non-empty value after `=` in `.env`; a bare `VAR=` line reads as unconfigured. Re-open the row and confirm the key was actually pasted before **Save**.
</Warning>

<Warning>
**The Agent Coordination or Command Approval section is missing.** Both render only when a Gateway `client` is connected and the value could be read from `openclaw.json`. If you are native-only, or the Gateway is stopped, they are hidden by design.
</Warning>

<Danger>
**Check for Updates reinstalls globally.** It runs `npm install -g`, which can hit `EACCES` on a system Node install. If the log shows a permission error, prefer a Node version manager (nvm/fnm) or Homebrew over `sudo`. Pinning is to `openclaw@^2026.5` to stay protocol-compatible with this Clawboo.
</Danger>

## See also

- [Connecting runtimes](/runtimes/connecting-runtimes), manage the non-OpenClaw runtimes (Runtimes panel)
- [OpenClaw](/runtimes/openclaw), the Gateway runtime, device pairing, and channels
- [Boo Zero](/using/boo-zero), where the display name, global brief, and team rules editors live
- [Cost and budgets](/using/cost-and-budgets), track and cap spend on the chosen model
- [`/api/system/*` reference](/reference/rest-api/system), full request/response shapes for every route on this page
