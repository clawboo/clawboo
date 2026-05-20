---
'clawboo': patch
---

Fix Windows `.cmd` spawn compat (bundled into v0.1.7):

Windows users hit a "Network error" message at the install-OpenClaw step in the onboarding wizard (and would have hit the same failure mode at gateway start, device-pair approval, and the model-list cache if they got past install). Root cause: Node 18.20.2+ / 20.12.2+ / 22+ refuse to spawn `.cmd` / `.bat` files without `shell: true` (CVE-2024-27980 hardening). The throw happened SYNCHRONOUSLY at the spawn call site, escaped the request handler after SSE headers were already flushed, and the browser surfaced the dropped connection as "Network error" with no actionable detail.

Added `shell: isWindows` to all six `child_process` call sites that target `.cmd` shims on Windows:

- `detectOpenClaw` (system.ts) — `execFileSync(openclaw.cmd, ['--version'])`
- `approveDevicePOST` step 1 (system.ts) — `spawnSync(openclaw.cmd, ['devices', 'approve', '--latest'])`
- `approveDevicePOST` step 2 (system.ts) — `execFileSync(openclaw.cmd, ['devices', 'approve', <UUID>])`
- `installOpenclawPOST` (system.ts) — `spawn(npm.cmd, ['install', '-g', 'openclaw@^2026.5'])`
- `gatewayControlPOST` start (system.ts) — `spawn(openclaw.cmd, ['gateway', ...])`
- `getModelsFromCli` (modelCache.ts) — `execFileAsync(openclaw.cmd, ['models', 'list', '--all', '--json'])`

The two SSE-emitting spawn sites (install + gateway start) additionally got wrapped in try/catch so synchronous spawn throws now produce a clean `SPAWN_THROW` SSE error event with the actual error message instead of crashing the request handler. The misleading comment in `detectOpenClaw` claiming Node 22 handles full-path `.cmd` invocation correctly was corrected. `shell: isWindows` is a no-op on Unix, so the change is Windows-only at runtime.
