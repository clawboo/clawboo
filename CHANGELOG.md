# Changelog

All notable changes to the released `clawboo` product are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Changesets](https://github.com/changesets/changesets)
to version the one published package, the `clawboo` CLI. Every `@clawboo/*` library is
`private: true` and is inlined into that CLI's bundle, so the machine-generated per-release history
lives in [`apps/cli/CHANGELOG.md`](./apps/cli/CHANGELOG.md).

## v0.3.1 - 2026-07-20

A patch on top of native-first. Nothing architectural moved; the changes are the ones you feel while
running a native team day to day.

### Added

- **Runtime provider manager.** The Runtimes panel's Manage view for Clawboo Native, OpenClaw, and
  Hermes lists the LLM providers you have actually connected (synced with Settings → Providers),
  each with per-provider connect / disconnect, one-click reconnect using an existing key, and a
  default-model picker for Native.
- **Live Working / Idle badges.** The sidebar agent and Group Chat status indicators update in real
  time for native and server-orchestrated team runs and for native 1:1 chats, not only for OpenClaw
  over a live Gateway.
- **Two-layer team model picker.** Creating a team picks a provider first (only the connected ones),
  then its model, and the trigger shows the exact default model that will run instead of an opaque
  "Recommended".

### Changed

- Reconnecting Clawboo Native is no longer Anthropic-only; reconnect with any provider you have
  already configured.
- Onboarding's Add-runtimes step shows connected providers read-only, with a Back button to the
  provider step where keys are added.

### Fixed

- **Replies no longer vanish.** Every streamed team-chat reply now commits to the transcript or is
  cleanly cleared, so a delegating agent's message cannot disappear on the next update or on reload;
  a native 1:1 reply that fails mid-stream is preserved instead of silently dropped.
- A native runtime with no key now reads "Disconnected" with a "Set up in Runtimes" shortcut.
- The sidebar mascot's hover tooltip appears promptly and reads "Boo Zero", matching what clicking
  it opens.

## v0.3.0 - 2026-07-15

Native-first. v0.2.0 made Clawboo runtime-agnostic; v0.3.0 is what that unlocked. The first run
needs one provider key and nothing else: no OpenClaw install, no Gateway, no external CLI. Every
other runtime becomes something you add to a working setup rather than a prerequisite for having
one.

### Added

- **Native-first onboarding.** Connect a provider key, optionally add Claude Code / Codex / Hermes /
  OpenClaw, then deploy a real marketplace team.
- **Providers hub** in Settings, with live per-provider model lists so the model picker offers what
  your key can actually reach.
- **Per-agent runtime and model pickers** in create-team, and an editable model on the agent view.
  Runtimes that manage their own model show a note rather than a dropdown that cannot take effect.
- **First-run capability tour**, a one-time, skippable spotlight over the real sidebar controls.
- **Ghost Graph runtime badges, model orbitals, and MCP connector nodes**, so every agent surfaces
  its attached MCP servers and built-ins.

### Changed

- **Native teams chat and delegate end to end.** A native leader hands work to teammates through a
  structured delegate signal the engine observes, so the claim / run / report-up loop fires for
  native teams exactly as it does for OpenClaw.
- **Orchestration runs server-side**, per team, with the browser a thin client over REST and SSE, so
  a cascade survives a tab close.
- A degraded OpenClaw Gateway no longer blocks the dashboard: a non-blocking banner offers the
  recovery that actually applies.

## v0.2.0 - 2026-06-20

The first liberated cut. Clawboo is now a TypeScript orchestrator for heterogeneous AI agent runtimes:
native agents are built in, and OpenClaw, Claude Code, Codex, and Hermes join as peer teammates in one
chat, sharing one board, one memory, and one capability dashboard, all governed and verified.

### Added

- **Native agent runtime, built in.** Paste a provider key (Anthropic / OpenAI / OpenRouter / Ollama) and
  Clawboo runs agents in-process, with no external CLI and no OpenClaw Gateway required. Native-first
  onboarding seeds a working leader + specialist team in about a minute.
- **Mixed-runtime peer chat.** Native, OpenClaw, Claude Code, Codex, and Hermes agents are named peers in
  one durable team room, and any runtime can lead. Peer posts are tagged as untrusted evidence, never user
  instructions.
- **Durable kanban fused with live chat.** The board is the canonical, refresh-surviving source of truth for
  task state with race-free claiming; chat is the narration. Delegations become real board mutations.
- **Unified, tiered memory.** A shared memory store every runtime reads and writes through the Memory tool,
  scrubbed of secrets on write and scope-isolated per team; each runtime keeps its own private cognitive
  memory, untouched.
- **One capability dashboard.** A single inventory of every skill, tool, and connector across all runtimes,
  with manageability-gated actions; each capability is shown with its availability and owning runtime.
- **Native-capability preservation.** Each runtime keeps its native powers: OpenClaw keeps its channels and
  always-on heartbeat; Hermes keeps its self-improvement and skills, in a stable per-identity home that
  persists across runs.
- **Multi-runtime connect + manage from the UI.** Install, connect, and manage Claude Code, Codex, Hermes,
  or a local OpenClaw Gateway from the Runtimes panel, with per-runtime diagnostics and a unified
  fleet-health overview. Runtime API keys live in an AES-256-GCM encrypted vault.
- **Team-task scheduler / routines.** Schedule recurring team work with an external wake, alongside a
  unified view of each runtime's own-life schedules.
- **Verification, governance, observability.** Builder-is-not-the-judge verification gates "done"; a budget
  kill-switch with depth/fan-out caps, approvals, and tool-loop circuit breakers; OpenTelemetry traces,
  structured logs, and an error taxonomy, all on by default.
- **Per-task worktree system-of-record + cross-runtime handoff.** Each file-mutating task runs in its own
  isolated git worktree with a structured handoff artifact, so work can move between runtimes.
- **MCP spine.** Clawboo hosts Tasks, Memory, Tools, and TeamChat MCP servers that every runtime consumes
  over one channel for both injection and observation.
- **A 300+ agent catalog + 80+ team templates**, a three-tab marketplace, the Atlas org-graph, Ghost Graph
  team halos, light/dark theming, and a public-facing README + onboarding.

### Changed

- **OpenClaw is now one runtime among several, not the substrate.** Clawboo runs natively and integrates
  every runtime as a black box behind one adapter interface.
- **Full graduation.** Every subsystem is on by default; there is no feature-flag regime.
- **State lives under `~/.clawboo/`** (its own home: the SQLite database, settings, the secrets vault, and
  per-runtime homes), separate from any runtime's state directory.

### Removed

- The legacy regex / prose-scraping delegation orchestration, replaced by structured lifecycle events + MCP
  calls.
- The experimental "Labs" UI and the per-subsystem feature flags.

### Security

A release-cut audit covered the encrypted vault, the redaction layer, provider-key flows, runtime-install
integrity, the shared-memory scrub + scope isolation, the capability-write injection defense, the peer-chat
trust boundary, the scheduler's atomic claim, and per-runtime home isolation. The findings were fixed with
regression tests; the provider SDKs are pinned to exact versions; the dependency + license sweeps are clean
of strong copyleft. See the project's security policy for reporting.

### Roadmap (not yet shipped)

- **Humans in the graph**, humans as first-class participants on the board and in the room.
- **Multi-tenant**, hosted / organization deployments with per-tenant scoping.

## v0.1.x

Initial public placeholder releases on npm: the package name claim plus a series of first-run install
fixes (SPA serving, CLI port discovery, Windows spawn compatibility, in-dashboard device pairing) and the
first feature release (light/dark theming + the design-system pass).
