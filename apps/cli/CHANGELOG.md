# clawboo

## 0.1.3

### Patch Changes

- aef820f: fix(cli): HTTP-verify Clawboo identity during port discovery, don't TCP-probe blindly.
  The OpenClaw Gateway listens on auxiliary ports (18791, 18792) in addition to its main 18789. Those fall inside Clawboo's 18790-18809 fallback window. v0.1.2's `findRunningDashboard()` did a TCP-only probe, so when 18790 was free but 18791 was held by Gateway (or by Chrome's --remote-debugging-port, or any other listener), the CLI mistook the unrelated port for Clawboo's already-running dashboard, skipped spawning the bundled server, and opened the browser to that port's 401 page (rendered as "Unauthorized" plain text).
  Fix: new `probeClawbooDashboard()` does a TCP probe AND a Clawboo-shaped JSON check on `/api/settings`. Only ports that return a real Clawboo response are accepted.
  Also adds `scripts/test-clean-install.mjs` — a full clean-install simulation that boots a fake non-Clawboo listener on 18791 before invoking the CLI, guaranteeing this exact regression class can't ship again. Wired into both `ci.yml` (PR gate) and `publish.yml` (last-line defense before npm publish).

## 0.1.2

### Patch Changes

- e7b9363: fix(server): SPA root path now serves index.html in the bundled production server.

  Replaces an Express 5 wildcard catch-all (`/{*splat}`) that failed to match the bare `/` path under path-to-regexp v8 with a version-agnostic `app.use(handler)` SPA pattern. Also adds a `smoke-test-bundle` CI job that boots the bundled server and curls `/` so this class of bug can't ship again.

  Fixes the "Cannot GET /" that affected v0.1.1.

## 0.1.1

### Patch Changes

- be71923: First real release. Replaces the v0.0.0 / v0.1.0 placeholder builds.

  Ships the v0.1.0 marketplace-redesign milestone:
  - 304 first-class agent catalog entries across 3 sources (agency-agents, awesome-openclaw, clawboo builtin)
  - 82 workflow team templates (5 builtin, 5 agency-workflows, 42 awesome-openclaw, 30 synthetic excellence partitions)
  - 3-tab marketplace (Skills / Agents / Teams) with single-agent deploy flow
  - Atlas global org-graph + Group Chat team halos with Boo Zero as universal leader
  - Multi-agent orchestration: structured `<delegate>` protocol, multi-step `<plan>` state machine, parallel workstreams with auto-synthesis, relay-batching, override-fix retry
  - DelegationCards / PlanCards / WorkstreamCards with tint-aware borders, accordion topology, completion flash
  - Auto-install onboarding (Detect → Install → Configure → StartGateway → Team → Deploy)
  - Dynamic API port resolution (default 18790, auto-fallback through 18809) — never collides with other dev servers
  - Hybrid agent knowledge delivery (AGENTS.md essentials + CLAWBOO.md reference + self-documenting `[Team Update]` envelopes)
  - Local-DB ghost cleanup + per-agent KV cleanup on agent delete
  - 857 unit tests, 12 e2e tests, full CI gating via `pnpm verify:ingest` on marketplace codegen
