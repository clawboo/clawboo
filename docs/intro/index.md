---
title: Clawboo documentation
description: Clawboo is an open-source, local-first multi-agent mission-control dashboard and orchestrator you install with npx clawboo.
---

Clawboo is an open-source, local-first dashboard and orchestrator for teams of AI agents. You install it with one command, `npx clawboo`, and it runs entirely on your machine: a single Node server binds to loopback by default, persists everything to one local SQLite file, and opens a browser dashboard. There is no cloud account, no managed control plane, and no telemetry leaving your laptop.

What makes Clawboo more than a chat wrapper is that it runs _heterogeneous_ runtimes as one team. Native agents are built in; paste a provider key and Clawboo runs them in-process, while Claude Code, Codex, Hermes, and the OpenClaw Gateway connect as peer teammates in the same room. They share one board, one memory, and one capability inventory, and their autonomous work is independently verified before it counts as done.

![The Clawboo team space: a leader and three specialists in a team graph above a live group chat](/images/team-space.png)

## What you get

Clawboo's surface is wide on purpose; it's a mission-control dashboard, not a single feature. The capabilities below are all shipped and on by default.

- **Five runtimes, one team.** [clawboo-native](/runtimes/native), [OpenClaw](/runtimes/openclaw), [Claude Code](/runtimes/claude-code), [Codex](/runtimes/codex), and [Hermes](/runtimes/hermes) all join as named peers. Each keeps its own native powers: OpenClaw keeps its channels and heartbeat, Hermes keeps its skills and self-improvement, while coordinating over the shared plane. See the [runtime capability matrix](/runtimes/index).
- **A durable board fused with live chat.** [The board](/concepts/the-board) is the canonical source of truth for task state; [group chat](/using/group-chat) is its narration. Tasks survive restarts, claims are race-free, and every [delegation](/concepts/delegation-and-orchestration) is a real board mutation; coordination flows over structured lifecycle events, never terminal-output scraping.
- **Watch agents collaborate.** The [Ghost Graph and Atlas](/using/ghost-graph) render your team as a live org chart; [peer chat](/concepts/peer-chat) lets any runtime lead a bounded multi-turn exchange in one room.
- **Builder ≠ judge verification.** Autonomous completions pass through a [verification gate](/concepts/verification): a deterministic check plus an independent critic. A failing verdict can't reach `done` without an audited override, and ambiguous results are marked `completed_with_debt` rather than silently passed.
- **Governance and observability, on by default.** [Budgets](/concepts/governance) with spend warnings, depth and fan-out caps, circuit breakers, and approvals, plus an [event log](/concepts/observability) with traces, fleet health, and an error taxonomy. Hard spend caps that auto-pause a run are opt-in.
- **Shared memory and a capability inventory.** Every runtime reads and writes the same tiered [memory](/concepts/memory) store and shows up in one [capabilities](/concepts/capabilities) dashboard, while its private self-model stays its own.
- **A 304-agent, 82-team marketplace.** Browse and deploy from a [catalog](/using/marketplace) of curated agents and teams, then customize and route them.

![The Ghost Graph: a team's leader and specialists as a live org chart with dependency edges](/images/ghost-graph.png)

## Version

<Note>
These docs describe Clawboo **v0.2.1**, the current release.
</Note>

## Where to go next

<Columns cols={2}>
  <Card title="Getting Started" icon="rocket" href="/getting-started/index">
    Two install paths: native-first (paste a key, no Gateway) or the OpenClaw Gateway. Start with installation and the native quickstart.
  </Card>
  <Card title="Core Concepts" icon="layers" href="/concepts/index">
    The mental model: the agent model, teams and planes, the board, verification, and the architecture invariants.
  </Card>
  <Card title="Runtimes" icon="cpu" href="/runtimes/index">
    The five-runtime capability matrix and how to connect each one as a peer teammate.
  </Card>
  <Card title="Reference" icon="book-open" href="/reference/index">
    The REST API, database schema, environment variables, MCP tools, and the CLI.
  </Card>
</Columns>

## See also

- [What is Clawboo?](/intro/what-is-clawboo): positioning and the wedge
- [How it works](/intro/how-it-works): the end-to-end architecture
- [Glossary](/appendices/glossary): canonical term definitions
