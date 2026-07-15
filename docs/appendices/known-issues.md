---
title: Known issues & limitations
description: Code-verified list of Clawboo's genuine current limitations, deferrals, and dormant seams, not fixed bugs.
---

This page lists the **genuine current limitations** of Clawboo v0.3.0. Every item is confirmed against current source; these are deliberate deferrals, dormant seams, and runtime-imposed constraints, **not** bugs awaiting a fix. Each entry states the impact and a workaround where one exists.

<Note>
These docs describe Clawboo **v0.3.0**, the current release.
</Note>

## Not on this list (already fixed)

Three things you may have read about in older notes are **fixed in current code**; do not treat them as open:

- **Access-gate case bypass: fixed.** The gate lower-cases the request path before its `/api/` prefix test, so an uppercased route like `/API/settings` can no longer evade the token check. The loopback `/api/mcp/*` control-plane exemption is also case-folded and is the only unauthenticated `/api/*` path. See [Security](/operating/security).
- **Connected coding-agent reload trap: fixed.** A user who finishes onboarding with a _connected_ non-OpenClaw runtime (a key in the vault) lands back in the dashboard on reload, not the wizard. The fix keys on `onboarded && hasConnectedRuntime`. (The *un*connected SKIP path is a separate, still-open deferral: see [item 5](#5-coding-agent-skip-path-re-onboards-on-reload).)
- **Budget hard-cap stop: fixed.** A cap-mode budget that crosses 100% aborts the live run, and a paused cap blocks the next dispatch pre-flight (before the claim). Budgets are uncapped by default, so this enforces nothing until you set a limit. See [Governance](/concepts/governance).

---

## 1. Local-first / single-tenant: the `tenant_id` columns are a dormant seam

Clawboo is a local-first, single-user tool. Many tables carry a `tenant_id` column (and the budget table reserves a `scope: 'tenant'`), but **no per-tenant scoping is active**. Every row is written with `tenantId: null`, and every read that _could_ be tenant-scoped accepts an optional `scope` that no caller populates; so reads always return the single implicit tenant.

- **Impact**: there is no multi-tenant isolation. All teams, agents, board tasks, memory facts, budgets, and audit rows share one global namespace. Do not run Clawboo as a shared multi-user service expecting per-user data boundaries.
- **Workaround**: run one Clawboo instance per user/tenant (each gets its own `~/.clawboo` state directory via `CLAWBOO_HOME`). See [Data & state](/operating/data-and-state) and [Architecture invariants](/concepts/architecture-invariants).

<Note>
This is a deliberate **future seam, not built**. The `tenant_id` columns and the `scope: 'tenant'` budget value exist so a future multi-tenant / Postgres swap is a column-population change, not a rewrite. They are inert today.
</Note>

## 2. OpenClaw cost is an estimate (a lower-bound budget signal, not an exact charge)

The OpenClaw [runtime](/appendices/glossary) is a connected substrate driven over the Gateway. Its [RuntimeAdapter](/appendices/glossary) emits **no `cost` events and no terminal USD**; the `done` events carry only a `reason` and a `summary`. So when a scheduled OpenClaw fire completes and the terminal carries no `costUsd`, the dispatcher **estimates** spend from the produced text: it approximates token counts from the input-prompt and output-summary character lengths (the ~4-chars/token heuristic) and prices them via the shared model table.

- **Impact**: for OpenClaw runs, the budget ledger and the cost dashboard show an **approximation**, not a metered charge. It is used only to keep a budget moving and a cap engaged; it is never presented as an exact bill. The estimate is char-derived, so it will diverge from the provider's real token accounting (especially for tool-heavy turns whose tool I/O is not reflected in the dispatch prompt + summary lengths).
- **Workaround**: treat OpenClaw spend as a lower-bound signal; cross-check against your provider's own billing. The other four runtimes that report real or token-exact cost are more accurate. The estimate is forward-safe: if a future cost-bearing Gateway emits a real `costUsd`, it is used as-is and the estimate is skipped.

See [Governance](/concepts/governance) and [Cost & budgets](/using/cost-and-budgets).

## 3. OpenClaw shared-memory scope is global

The four executor-driven runtimes (`clawboo-native`, `claude-code`, `codex`, `hermes`) attach the Memory MCP with a **per-run team scope** carried on the attach URL. OpenClaw is different: its agents are cross-team, and its MCP servers are registered into the Gateway's **process-wide** config (`mcp.servers`), which cannot carry a per-run team binding. So OpenClaw memory reads and writes use a **global** fact scope.

- **Impact**: a fact an OpenClaw agent saves is visible to every OpenClaw agent regardless of team. There is no per-team memory boundary for OpenClaw the way there is for the other runtimes. For the local-first single-user model this is an _organizational_, not a security, boundary.
- **Workaround**: none at the runtime level; this follows from the Gateway's process-wide config. If you need strict per-team memory isolation, drive the work through a non-OpenClaw runtime, whose attach URL carries the team scope.

<Note>
The multi-tenant horizon (a per-run scoped OpenClaw attach) is parked. TeamChat is *deliberately not* registered for OpenClaw at all for a related reason; a process-wide static URL can't carry a per-run author binding, which would break the peer-chat anti-spoof property. See [Memory](/concepts/memory) and [Peer chat](/concepts/peer-chat).
</Note>

## 4. Codex requires an interactive `codex login` (no API-key connection)

Codex authenticates through an interactive ChatGPT OAuth login. Its runtime descriptor declares `authKind: 'oauth'` with `envVar: null` and `headlessAuth: false`; it **cannot be connected head-less with a pasted API key** on current versions.

- **Impact**: you cannot paste a key for Codex in the Runtimes panel. The connect call is a key-less no-op that returns the terminal login command (`codex login`); the card stays in `needs-login` until you complete the OAuth flow in a terminal.
- **Workaround**: install Codex, then run `codex login` in a terminal and re-check the card. See [Codex runtime](/runtimes/codex) and [Connecting runtimes](/runtimes/connecting-runtimes).

## 5. Coding-agent SKIP path re-onboards on reload

The onboarding wizard lets you pick a coding-agent runtime (`claude-code`, `codex`, `hermes`) and then **skip connecting it**, finishing onboarding with no runtime credential, no native agent, and no team. The completion sets the `onboarded` flag, but on the next reload the bootstrap's onboarding decision only treats a coding-agent user as "returning" when `onboarded && hasConnectedRuntime` is true (a key actually in the vault). A user who skipped has `onboarded: true` but `hasConnectedRuntime: false`, so the decision **does not** route them to the dashboard; they re-enter the wizard.

- **Impact**: picking a coding agent and connecting nothing means a reload drops you back into onboarding instead of the dashboard.
- **Workaround**: actually connect a runtime during onboarding (paste a key for `claude-code`/`hermes`, or complete `codex login`), or connect one from the **Runtimes** panel afterward. Once a credential is in the vault, `hasConnectedRuntime` is true and reloads land on the dashboard. See [Connecting runtimes](/runtimes/connecting-runtimes).

<Note>
This is a documented sub-decision of the onboarding bootstrap, not an accident; the `onboarded &&` guard is load-bearing so that merely *having a provider env var* (without finishing onboarding) doesn't skip the wizard. The trade-off is that the connect-nothing path has no durable "returning user" marker.
</Note>

## 6. No per-process cap on concurrent `/api/obs/stream` subscriptions

The observability live-tail (`GET /api/obs/stream`) is a Server-Sent Events stream. Each subscription opens a **fresh better-sqlite3 handle** plus two timers (a 750 ms DB-tail poll and a 20 s keep-alive). There is **no global counter or per-process limit** on how many of these streams can be open at once; every connection is independent and cleans up its own handle and timers only when the client disconnects.

- **Impact**: a client (or many tabs) opening many concurrent obs streams holds one DB handle + two timers each, with nothing throttling the total. On the local-first single-user model this is fine, but it is an unbounded resource-exhaustion risk if Clawboo is exposed to many clients.
- **Workaround**: this is a local-first deferral; behind a wider bind, front Clawboo with a reverse proxy that limits concurrent connections, and keep the [access gate](/operating/security) enabled. See [Observability dashboard](/using/observability-dashboard) and the [Observability API](/reference/rest-api/observability).

## See also

- [Glossary](/appendices/glossary), runtime, RuntimeAdapter, the board, tenant seam
- [Security](/operating/security), access gate, loopback bind, the `/api/mcp/*` exemption
- [Governance](/concepts/governance), budgets, the kill-switch, cap-mode auto-pause
- [Memory](/concepts/memory), shared MCP tier vs per-runtime private tier; OpenClaw global scope
- [Architecture invariants](/concepts/architecture-invariants), local-first, registry of record
- [Data & state](/operating/data-and-state), `CLAWBOO_HOME`, one instance per user
- [Changelog](/appendices/changelog), release history (0.1.x → 0.3.0)
