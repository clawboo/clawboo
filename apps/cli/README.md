# clawboo

> Your AI agents, visible. — The open-source AI Agent Team Studio for [OpenClaw](https://github.com/openclaw/openclaw) agent teams.

## Quick start

```bash
npx clawboo
```

That's it. The first run launches an onboarding wizard that:

1. Detects whether Node.js, OpenClaw, and the Gateway are installed.
2. Guides you through any missing pieces (provider API key, gateway start).
3. Opens the dashboard in your browser at `http://localhost:18790` (auto-fallback through `18809` if busy).

If you already have OpenClaw running, the CLI auto-connects.

## What you get

- **Browse 304 first-class agents** across 82 prebuilt teams (workflow templates from [agency-agents](https://github.com/msitarzewski/agency-agents) + [awesome-openclaw-usecases](https://github.com/hesamsheikh/awesome-openclaw-usecases) + Clawboo's own catalog).
- **Deploy a team in one click** — name, icon, color, then provisioned to your local OpenClaw with full per-agent `SOUL.md` / `IDENTITY.md` / `TOOLS.md` / `AGENTS.md`.
- **Group chat with structured `<delegate>` routing** — the leader (Boo Zero) coordinates parallel workstreams and multi-step plans; teammates respond inside `DelegationCard`s with progress, completion, and synthesis cues.
- **Ghost Graph** — live force-directed visualisation of your fleet: every Boo, every skill, every routing edge, every team.
- **Approvals, cost tracking, cron scheduler, skill marketplace** — bundled.

## Requirements

- Node.js **22+**
- An OpenClaw provider API key (Anthropic, OpenAI, Google, Ollama, or one of 11 OpenRouter-tier providers) — the wizard prompts you.

## Where state lives

All your state stays on your machine:

- `~/.openclaw/clawboo/clawboo.db` — Clawboo's SQLite metadata (teams, settings, cost records, etc.).
- `~/.openclaw/clawboo/settings.json` — connection + auth token.
- `~/.openclaw/agents/<agentId>/` — each agent's own workspace (managed by the OpenClaw Gateway).

The npm package ships only template content (the marketplace catalog and the orchestration generators). Nothing you do at runtime touches the package.

## Full docs

For the full architecture, screenshots, contributing guide, and roadmap, see the [main repo README](https://github.com/clawboo/clawboo#readme).

## License

MIT
