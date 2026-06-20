# clawboo

> A TypeScript orchestrator for heterogeneous AI agent runtimes. Native agents are built in; Claude Code, Codex, Hermes, and OpenClaw join as peer teammates in one chat.

## Quick start

```bash
npx clawboo
```

That's it. The first run opens an onboarding wizard:

1. Pick a runtime. **Clawboo Native** is the default: agents run in-process and talk to your provider directly, no external CLI.
2. Paste one provider API key (Anthropic, OpenAI, OpenRouter, or a local Ollama with no key).
3. Clawboo seeds a starter team and opens the dashboard. Your team is ready in about a minute.

The dashboard opens at the port written to `~/.clawboo/api-port.txt` (default `http://localhost:18790`, auto-fallback through `18809` if busy).

## What you get

- **Mixed-runtime peer chat.** Native, Claude Code, Codex, Hermes, and OpenClaw agents are named peers in one room, and any runtime can lead. Coordination flows over lifecycle events and MCP calls, never terminal-output scraping.
- **One board, one memory, one capability dashboard.** A durable kanban (the canonical task state) fused with live chat (the narration), a shared memory every runtime reads and writes, and one unified inventory of skills, tools, and connectors.
- **Connect any runtime from the Runtimes panel.** Install and connect Claude Code, Codex, or Hermes, or point at a local OpenClaw Gateway. Each runtime keeps its own native powers.
- **Verified and governed.** Builder-is-not-the-judge verification for autonomous completions, spend tracking and warnings with depth and fan-out caps and approvals, plus traces, structured logs, and an error taxonomy. Hard caps that auto-pause a run are opt-in.
- **A 300+ agent catalog.** Browse 304 first-class agents across 82 prebuilt teams, one click to deploy.

## Requirements

- Node.js **22+**
- One provider API key (Anthropic, OpenAI, OpenRouter, or a local Ollama with no key). The wizard prompts you.

## Where state lives

Everything stays on your machine, under `~/.clawboo/`:

- `~/.clawboo/clawboo.db`: the durable board, registry, memory, settings, and cost records (SQLite).
- `~/.clawboo/secrets/`: runtime API keys, AES-256-GCM encrypted.
- `~/.clawboo/api-port.txt`: the dashboard port.

The npm package ships only the dashboard and the agent catalog. Nothing you do at runtime touches the package.

## Full docs

Architecture, screenshots, configuration, and contributing guide: [main repo README](https://github.com/clawboo/clawboo#readme).

## License

MIT
