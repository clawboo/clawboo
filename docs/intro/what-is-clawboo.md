---
title: What is Clawboo
description: A TypeScript orchestrator for heterogeneous AI agent runtimes, the three design wedges that distinguish it from running runtimes standalone.
---

Clawboo is an open-source orchestrator for **teams of AI agents that run on different runtimes**. You deploy a team of agents, mix the engines they run on, Clawboo's own in-process native harness, Claude Code, Codex, Hermes, or an OpenClaw Gateway, and watch them collaborate in one room, on one durable board, under one set of guardrails. It runs locally, installs with `npx clawboo`, and is built for the developer who wants to coordinate several coding/agentic runtimes as a single fleet instead of babysitting each one in its own terminal.

The hard part of multi-agent work is not getting one agent to do one thing; every runtime already does that. The hard part is **heterogeneous coordination**: getting agents that don't share a protocol, a memory, or a notion of "done" to work as a team, durably, without one runaway agent burning your budget or shipping broken work. Clawboo exists for that problem. This page explains what Clawboo is, the three design wedges that distinguish it, who it's for, and why it's worth running over wiring the runtimes together yourself.

## What it is, and what it isn't

Clawboo is a **coordination and governance plane**, not a new agent runtime. It does not reimplement an agent loop; it wraps each runtime behind one [`RuntimeAdapter`](/appendices/glossary) interface, supervises it, and relays its work. The five runtimes stay first-class; Clawboo owns the _shared plane_ (the registry, the [board](/concepts/the-board), [peer chat](/concepts/peer-chat), shared [memory](/concepts/memory), the tools broker, [verification](/concepts/verification), [governance](/concepts/governance), the [event log](/concepts/observability), the [worktree system-of-record](/concepts/worktrees-and-handoff)) and each runtime keeps its _private plane_ (its own channels, cron/heartbeat, native memory, built-in tools, and session resume). The split is resolved from each runtime's declared capabilities, not hardcoded per id, so a runtime gets exactly the integration depth its architecture allows.

This is the deliberate opposite of a "brain-only, replace-everything" architecture. Clawboo never resells inference, never serves a runtime's messaging channels, and never clobbers a runtime's native memory or connectors. It is additive: it multiplies what the runtimes can do together rather than disintermediating them.

Concretely, every agent on a Clawboo team, a [Boo](/appendices/glossary), is a real agent record backed by an [AgentSource](/appendices/glossary), keyed by its `sourceId` (its runtime). SQLite is the [registry of record](/appendices/glossary) for _who exists_; the runtime is the source of truth for _how an agent runs_; the board is the source of truth for _current task state_. No decorative agents, no fake edges, no view-model a writer keeps in sync.

![The Clawboo team space: a Ghost Graph of agents above a shared group chat](/images/team-space.png)

## The wedge: three things standalone runtimes can't give you

Three design choices distinguish Clawboo from a hand-rolled fan-out script that pipes prompts to several runtimes. Each is grounded in a concept page; the short version is here.

### 1. Mixed-runtime peer chat: every runtime is a named peer, any runtime can lead

In most multi-runtime setups, cross-runtime messaging is a privileged parent/child relay: one orchestrator dispatches to subordinate runtimes, and a subordinate can never _be_ the orchestrator. Clawboo's [peer chat](/concepts/peer-chat) is a flat room instead. Every team member, whether it runs on the native harness, OpenClaw, Claude Code, Codex, or Hermes, posts into one durable room as a **named peer**, and _any_ of them can be the one to lead. The leader is one peer among equals; the speaker-selection policy is a pure function that any runtime can be the output of.

Two properties make the flat room safe to run across heterogeneous runtimes:

- **Identity is bound at attach time, not by the model.** A runtime cannot post as a peer it isn't. The room author and team are authoritative from a connection binding that Clawboo writes into the runtime's MCP config; the model never controls it, and a forged author in tool arguments is ignored.
- **Peer posts are evidence, never instructions.** Every delivered post is wrapped with the safety-critical `isUser=false` token (borrowed verbatim from OpenClaw's inter-session wire format), so a teammate that says "ignore your instructions" can never land with user authority. Escalation is prevented by construction, not by the receiver's judgement.

A bounded _exchange_ drives a sequence of peer turns, picks who speaks next deterministically, and caps how many turns run, so two agents can't chatter forever.

### 2. Board + chat fusion: the board is canonical, chat is narration

A chat transcript can't be transactionally claimed, can't survive a refresh as authority, and can't tell a crashed run from a slow one. So Clawboo splits the two: the durable [board](/concepts/the-board) is the **source of truth** for task and coordination state, and chat is **narration** of that state.

A board mutation is the decision of record. A chat message is a _description_ of a decision, never a write path back to the board. When a board mutation happens it _reflects_ itself into the team room as a system line, but only _after_ the canonical write, so the narration can never become the authority. That single rule is what buys durability (state survives restart), race-freedom (a single conditional `UPDATE` lets exactly one assignee claim a task, and a lost claim is a `409` the caller must never retry), and recoverability (boot-time orphan reconciliation and a stale-task backstop release stuck work).

The same discipline runs all the way down: [delegation and orchestration](/concepts/delegation-and-orchestration) reads _structured_ signals from typed runtime events, a `sessions_send` tool call, or a `<delegate>`/`<plan>` directive parsed from a terminal `done`, never a regex over model prose. A delegation becomes a board task with a claim, an execution ledger, and a status; the result rounds back to the board and reflects to the leader. The board is the dispatcher; the [worktree](/concepts/worktrees-and-handoff) is the isolated world the dispatched work happens in.

### 3. Builder ≠ judge verification, plus hard governance

A generator self-grading is a known failure mode, and "the agent said it's done" is not evidence. Clawboo makes `done` mean _verified_ through the **builder ≠ judge** principle: the agent that did the work never certifies its own work. The only two signals into `done` for file-mutating work are a machine truth (the task's own verify command, judged by its exit code) and a structurally-independent reviewer (a read-only critic in a _detached, push-less_ checkout who literally cannot mutate the builder's branch). See [verification](/concepts/verification).

The gate is **intrinsic to the board state machine**, not an opt-in step; any transition to `done` with a non-promotable verdict is rejected for _every_ caller (the REST route, the Tasks-MCP tool, the orchestrator), the only escape being an explicit, audited `humanOverride`. When the fix loop runs out of budget, a task lands `completed_with_debt` rather than deadlocking, but that exit is itself gated: debt over a _green_ gate ships with a paper trail; debt over a _red_ gate routes to a human.

Alongside verification, [governance](/concepts/governance) makes a runaway agent _impossible_, not just visible:

- **A budget kill-switch.** A USD cap per agent, mission (delegation tree), or team. In `cap` mode, crossing 100% aborts the live run and releases the task; the shipped default is `warn` mode (track and warn, no enforcement) so a fresh install enforces no dollars until you opt in.
- **Five circuit breakers.** A deterministic, cross-runtime backstop that halts a run thrashing on a repeated failing call, making no progress, or burning tokens with nothing to show, keyed on typed `RuntimeEvent` fields, never on prose.
- **Caps and approvals.** A depth cap (a delegation tree goes at most two levels deep), a fan-out cap, a per-run cost ceiling, and a human approval handshake for risky delegations that **fails closed** if the approval endpoint is unreachable.

Every signal keys on a structured field, because the alternative, scraping the model's free text for "I'm stuck" or "permission denied", is both unparseable and trivially manipulable.

## Who it's for

Clawboo is for a developer running **a team of AI agents**, not a single assistant. You feel its value when:

- you want to mix runtimes on one team, a native agent that needs no Gateway, a Claude Code worker, a Hermes teammate that keeps its own skills and memory, and have them coordinate instead of running in separate windows;
- you need coordination that _survives a refresh_: a durable board, race-free claiming, crash recovery, and cross-runtime handoff, not a chat scrollback you have to babysit;
- you want a USD budget, a kill-switch, and a verification gate around agentic work before you let several agents loose on a repo;
- you want one place to see what the fleet is doing, a [Ghost Graph](/using/ghost-graph) and [Atlas](/using/ghost-graph) over a single event log, with traces, fleet-health, and cost.

If you only run one agent at a time, the standalone runtime is enough. Clawboo's surface area earns its keep when there are several agents, several runtimes, and a need for the work to be durable and bounded.

## Why this over running the runtimes standalone

You _could_ wire the runtimes together yourself. The cost of doing so is exactly the shared plane Clawboo already built:

| You need                    | Standalone runtimes give you                      | What Clawboo adds                                                                        |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cross-runtime collaboration | A relay you script per pair, usually parent→child | A flat peer room any runtime can lead, with identity bound at attach time                |
| Durable coordination        | A chat transcript that vanishes on refresh        | A transactional board: atomic claim, dependency chains, crash recovery                   |
| One shared memory           | Each runtime's private memory, siloed             | A shared Memory-MCP tier all five runtimes read/write, on top of each one's private tier |
| "Done" means _done_         | The agent's own say-so                            | A builder ≠ judge gate intrinsic to the board state machine                              |
| Bounded spend and effort    | Per-runtime, if any                               | A USD kill-switch, five circuit breakers, and depth/fan-out/cost caps                    |
| Visibility across the fleet | Per-runtime logs                                  | One append-only event log every view is a projection of                                  |

The trade-off is honest: Clawboo is a second coordination layer beside each runtime's own state, with more moving parts than a single-runtime setup. The design accepts that cost in exchange for durability, race-freedom, governance, and a flat topology that no single runtime offers, and it pays the cost _additively_, leaving every runtime's native power intact rather than replacing it.

## Boundaries and non-goals

- **Not a new agent runtime.** Clawboo coordinates the five it supports; it does not implement an agent loop or compete with them. A teammate is a `RuntimeAdapter`.
- **Not a privilege boundary.** Budgets and breakers bound _spend and effort_; a worktree bounds _concurrency_. A real privilege boundary (a container) is a documented, opt-in escalation, not something governance provides.
- **OpenClaw is a connected substrate, not a Clawboo-spawned CLI.** OpenClaw agents live inside an always-on Gateway Clawboo drives as an operator client; a server-side executor run is _refused_ for a connected-substrate runtime (it has no isolated worktree to drive). It is the fifth runtime, handled differently for that architectural reason.
- **Single implicit tenant today.** Multi-tenant scoping (`tenant_id` columns, a reserved budget scope) is a dormant future seam, not a shipped feature. So is a human participant posting into a room.

<Note>
These docs describe Clawboo **v0.3.0**, the current release.
</Note>

## See also

- [How it works](/intro/how-it-works): the end-to-end architecture overview
- [Why Clawboo](/intro/why-clawboo): the differentiators against running runtimes standalone, in depth
- [Peer chat](/concepts/peer-chat): the mixed-runtime team room
- [The board](/concepts/the-board): the durable, canonical task substrate
- [Verification](/concepts/verification): the builder ≠ judge gate on `→ done`
- [Governance](/concepts/governance): budgets, the kill-switch, circuit breakers, and caps
- [The agent model](/concepts/agent-model): Boos, Boo Zero, and the five runtime classes
- [Getting started](/getting-started/index): install and run your first team
- [Glossary](/appendices/glossary): canonical term definitions
