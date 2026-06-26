# clawboo

## 0.2.0

### Minor Changes

- The v0.2.0 liberated cut. Native agents are built in (paste a provider key, no external CLI), and OpenClaw, Claude Code, Codex, and Hermes join as peer teammates in one chat, sharing one durable board, one tiered memory, and one capability dashboard, all governed and verified. Includes the team-task scheduler, per-runtime native homes, an encrypted credential vault under `~/.clawboo/`, and a release-cut security audit. See CHANGELOG.md for the full arc.

## 0.1.9

### Patch Changes

- 53a05b2: Welcome redesign, lighter install, and team color collections:
  - **New calm Day-sky welcome** — a soft animated sky with drifting clouds (pure CSS/SVG) replaces the WebGL ShaderGradient atmosphere on the onboarding splash and home welcome, with a faint "boo-verse" of distant boo silhouettes drifting behind the clouds. The welcome is theme-independent (always the bright sky).
  - **Removed the WebGL/three.js stack** (`@shadergradient/react`, `@react-three/fiber`, `three`, `three-stdlib`) — smaller install/bundle, no GPU cost on first paint.
  - **Fresh installs default to light theme** so onboarding happens in light mode; switch to light/dark/system anytime after.
  - **Team color collections** — each team picks from 8 color palettes with per-team hue rotation, and the create-team preview matches the deployed palette (DB migration 0004).
  - **Token-usage tracking by team & agent**; onboarding flow improvements; removed the unused Ollama-check API.

- 6f718e2: Fixed a Windows hang in `/api/system/status` (hit by the onboarding DetectStep): the synchronous `where` / `which` binary probe (`findExecutable`) is now timeout-bounded, so a slow spawn under Windows Defender can no longer block the server's event loop and stall the request.

## 0.1.8

### Patch Changes

- 4ecda72: Light/dark theme with toggle + persisted preference, premium design-system pass (4-tier surfaces, type scale, motion), Atlas radial layout, GitHub star CTA, authentic provider brand marks + app-consistent model dropdown in onboarding, and onboarding-hang/atmosphere fixes.

## 0.1.7

### Patch Changes

- 9309ee0: Fix device pairing on fresh macOS installs (v0.1.7):
  - `POST /api/system/approve-device` now uses `spawnSync` for the `openclaw devices approve --latest` preview step so the CLI's preview-mode non-zero exit code no longer swallows the request-id stdout we need to parse. Step 2 (the real approval) keeps `execFileSync` but surfaces `stderr` / `stdout` from any thrown error instead of Node's `Command failed: <argv>` wrapper.
  - The onboarding wizard's `StartGatewayStep` now catches `GatewayResponseError { code: 'NOT_PAIRED' }` and renders the in-product `DevicePairingApproval` card inline. Users no longer have to do a manual page refresh to escape the wizard's "Something went wrong" panel on a fresh-install machine with OpenClaw 2026.5.x. After approval, the wizard auto-retries the connect and advances normally.

- 9038cab: Windows compatibility hardening (bundled into v0.1.7):

  **`.cmd` spawn failures**: Windows users hit "Network error" at the install-OpenClaw step because Node 18.20.2+ refuses to launch `.cmd` / `.bat` files without `shell: true` (CVE-2024-27980 hardening). The throw escaped the request handler after SSE headers were flushed and the browser surfaced the dropped connection as a generic network failure. Added `shell: isWindows` to six `child_process` call sites that target `.cmd` shims (detectOpenClaw, approveDevicePOST steps 1+2, installOpenclawPOST, gatewayControlPOST start, getModelsFromCli) and wrapped the two SSE-emitting sites in try/catch so synchronous spawn errors surface as clean SSE events instead of crashing the request handler.

  **Windows polish**: further testing surfaced four more issues:
  - `cmd.exe` console window popped up in front of the dashboard on every shellout — `shell: true` opens a visible console on Windows by default. Added `windowsHide: isWindows` alongside every `shell: isWindows` (six sites).
  - CLI dashboard poll timed out after 15s — bumped to 45s (90 × 500ms) in `apps/cli/src/index.ts` because the bundled CJS cold-boot on Windows is slow (Windows Defender real-time scanning + Node's first-load module compile).
  - `agents.create` timed out at 30s on team deploy — bumped the gateway-client's default RPC timeout from 30s to 60s and added per-call 120s overrides to `agents.create` and `agents.files.set` to cover the worst-case OpenRouter model-capabilities fetch on Windows (observed up to 74s in user logs).
  - "Retry" button at the Gateway-start step didn't recover (only page refresh did) because the 15s server-side polling fired before the Gateway finished binding (~51s on Windows), and a Retry click would spawn a duplicate openclaw process racing the first for port 18789. Bumped server polling to 60s (120 × 500ms), extracted the polling loop into a `pollUntilReachable` helper, and added a mid-launch detection check via `readGatewayPid` + `isProcessAlive` — if a previous request already spawned the Gateway and its pid is alive, the new request joins the existing polling instead of spawning a duplicate.

  All of the above are no-ops on Unix; macOS compatibility is preserved.

## 0.1.6

### Patch Changes

- 7a8c3ff: fix(bootstrap): always verify OpenClaw install state instead of trusting stale localStorage.

  Users running 'npx clawboo' on a machine where they'd previously
  onboarded an OLDER clawboo but then uninstalled OpenClaw got dumped
  straight to the 'Connect to an OpenClaw Gateway' screen. The connect
  attempt then failed with 'Gateway closed (1011): upstream error'
  because no OpenClaw was running, and there was no way to re-run the
  install wizard from that point.

  Root cause: GatewayBootstrap had a fast-path optimization that
  returned early when localStorage['clawboo.onboarded'] was set, never
  calling /api/system/status. localStorage persists by browser origin
  (localhost:18790) — it survives uninstalling the npm package AND
  clearing ~/.openclaw/. So a once-onboarded user couldn't re-enter
  the wizard even after a full system reset.

  Fix: always fetch /api/system/status. If OpenClaw is installed AND
  configured, mark onboarded (idempotent) and skip the wizard.
  Otherwise clear the stale localStorage flag and sw the wizard so
  the user can re-install + reconfigure. The on-disk system state is
  the source of truth; localStorage is just a hint cleared whenever
  they disagree.

## 0.1.5

### Patch Changes

- 1cc97fe: feat(connection): in-dashboard device pairing approval for OpenClaw 2026.5+.

  OpenClaw 2026.5.x dropped auto-pair-on-first-connect. Every fresh
  Clawboo install hits a NOT_PAIRED rejection on first connect, requiring
  the user to drop into a terminal and run two openclaw CLI commands.

  This release adds an inline "Approve this device" UI in the Gateway
  connect screen. When the connect throws NOT_PAIRED, the form swaps to
  a single button that hits a new POST /api/system/approve-device
  endpoint. The server shells out to `openclaw devices approve --latest`
  to extract the pending requestId, then `openclaw devices approve <UUID>`
  for the actual approval (--latest alone is a preview-only flag; the
  explicit ID is required for approval).

  After approval, the SPA auto-retries the original connect attempt with
  the same URL + token state. Users complete onboarding with a single
  button click instead of context-switching to a terminal.

  The approval UI also shows the manual CLI fallback (openclaw devices
  approve --latest → openclaw devices approve <requestId>) as a footer
  hint for power users who prefer terminal workflows or whose openclaw
  CLI is on a non-standard PATH.

## 0.1.4

### Patch Changes

- 68ebc29: fix: OpenClaw protocol-4 compatibility + Windows install support.

  Two independent blockers prevented users from completing onboarding:
  1. PROTOCOL MISMATCH. OpenClaw 2026.5.18 (latest) bumped the WS connect
     protocol from 3 to 4. Clawboo's gateway-client advertised maxProtocol: 3
     only, so every fresh install (which ran `npm install -g openclaw@latest`)
     got an incompatible openclaw and hit "Something went wrong: protocol
     mismatch" at connect time.

     Fix: bump maxProtocol to 4 in packages/gateway-client/src/client.ts.
     minProtocol stays at 3 so older openclaw (2026.3.x and earlier) still
     negotiates correctly. Also pinned the install spec to `openclaw@^2026.5`
     so a future minor bump landing protocol 5 doesn't silently break users.

  2. WINDOWS SPAWN ENOENT. Windows users saw `Error: spawn npm ENOENT` when
     clicking Install in onboarding, AND the OpenClaw detection step always
     reported "not installed" even after a successful manual `npm install -g`.
     Both root-caused to Unix-only commands: `execFileSync('which', ...)` and
     `spawn('npm', ...)` (Windows npm is npm.cmd).

     Fix: new apps/web/server/lib/platform.ts helper with findExecutable
     (cross-platform which/where) and resolveShimName (appends .cmd on
     Windows). Applied at system.ts:57+343, modelCache.ts:59, and
     processManager.ts:74 (which also gained a netstat-based fallback for
     port-to-PID lookup on Windows). CI smoke-test-bundle now runs on a
     matrix of [ubuntu-latest, windows-latest] so Windows regressions can't
     ship undetected.

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
