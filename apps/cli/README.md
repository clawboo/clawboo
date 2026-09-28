# clawboo

> Put a whole team of AI agents on it. Boo Zero, your team lead, splits the work into jobs on one board and hands each job to a teammate: Claude Code, Codex, Hermes, OpenClaw or Clawboo's own built-in agents. Free and open source. Runs on your computer.

## Quick start

```bash
npx clawboo@latest
```

That's it. Clawboo opens in your browser and walks you through setup:

1. **Connect a model.** Paste one API key (OpenAI, Anthropic, OpenRouter, or seven more), use a local Ollama with no key, or pick **Sign in with ChatGPT** to use your ChatGPT subscription through the Codex CLI.
2. **Add your AI tools (optional).** Connect Claude Code, Codex, Hermes or OpenClaw now, or later from **Settings → Runtimes**.
3. **Pick a team.** Choose a ready-made team from the marketplace and deploy it. Boo Zero runs it, and you land in the team's group chat.

The dashboard opens at the port written to `~/.clawboo/api-port.txt` (default `http://localhost:18790`, auto-fallback through `18809` if busy).

Want Claude Code teammates? Install globally with the Claude Agent SDK, which the package does not bundle: `npm install -g clawboo @anthropic-ai/claude-agent-sdk`, then run `clawboo`.

## What you get

- **Ask once, get it back done.** Boo Zero splits your request into jobs, hands them to teammates, and pulls the results together in the group chat.
- **Your AI tools, one team.** Teammates can run on Claude Code, Codex, Hermes, OpenClaw or the built-in agents. You pick each one's tool when you deploy the team, and every job lands on the same board.
- **One board, one chat, one memory.** A durable board that survives restarts, a group chat where the team talks it through, and a shared memory that any teammate can read and write.
- **For work and for life.** 400+ ready-made agents and 80+ teams, from launch plans and pricing pages to a morning brief, a family calendar and a trip desk.
- **Run it with confidence.** Spend tracking, budgets with warnings (hard caps that auto-pause are opt-in), depth and fan-out limits in code, and approvals for risky tool calls.

## Requirements

- Node.js **22.12** or newer. OpenClaw teammates need 22.22.3+, 24.15+ or 25.9+.
- A way to reach a model: an API key, a local Ollama, or a ChatGPT subscription. The setup wizard asks.

## Where state lives

Your data stays on your machine, under `~/.clawboo/`:

- `~/.clawboo/clawboo.db`: the board, registry, memory, settings, and cost records (SQLite).
- `~/.clawboo/secrets/`: API keys, AES-256-GCM encrypted.
- `~/.clawboo/api-port.txt`: the dashboard port.

The npm package ships the dashboard and a small built-in agent pack, so first run works offline. The rest of the marketplace is fetched at runtime. Prompts go only to the model providers and apps you connect.

## Commands

| Command                 | What it does                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `clawboo`               | Find or start the dashboard server and open it in your browser                       |
| `clawboo stop`          | Stop the running dashboard server                                                    |
| `clawboo restart`       | Stop it and start a fresh one on the same port                                       |
| `clawboo backup [dest]` | Copy the database to a single checkpoint-consistent file, safe while the server runs |

The server keeps running after the CLI exits, so `stop` and `restart` are how you reach it again, and `restart` is what makes a fresh `npm install -g clawboo@latest` actually take effect. `clawboo` also compares the version of any server it finds against its own, and offers to restart an older one rather than silently attaching to it. Run `clawboo --help` for the full list, or see the [CLI reference](https://docs.claw.boo/reference/cli).

## Learn more

Watch the launch film and read the full guide in the [main repo README](https://github.com/clawboo/clawboo#readme). Documentation: **[docs.claw.boo](https://docs.claw.boo)**. Website: **[www.claw.boo](https://www.claw.boo)**.

## License

MIT

Claude Code, Codex, Hermes and OpenClaw are products of their respective owners. Clawboo is an independent open-source project, not affiliated with or endorsed by them.
