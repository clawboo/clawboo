# Changelog

All notable changes to the `clawboo` product are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Changesets](https://github.com/changesets/changesets)
to version the individual `@clawboo/*` libraries (see their per-package `CHANGELOG.md`).

## v0.2.0 - 2026-06-11

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
