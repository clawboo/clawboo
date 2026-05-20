---
'clawboo': patch
---

Windows compatibility hardening (bundled into v0.1.7):

**Round 1 — `.cmd` spawn failures**: Windows users hit "Network error" at the install-OpenClaw step because Node 18.20.2+ refuses to launch `.cmd` / `.bat` files without `shell: true` (CVE-2024-27980 hardening). The throw escaped the request handler after SSE headers were flushed and the browser surfaced the dropped connection as a generic network failure. Added `shell: isWindows` to six `child_process` call sites that target `.cmd` shims (detectOpenClaw, approveDevicePOST steps 1+2, installOpenclawPOST, gatewayControlPOST start, getModelsFromCli) and wrapped the two SSE-emitting sites in try/catch so synchronous spawn errors surface as clean SSE events instead of crashing the request handler.

**Round 2 — Windows polish after live testing**: real-laptop testing of round-1 surfaced four more issues:

- `cmd.exe` console window popped up in front of the dashboard on every shellout — `shell: true` opens a visible console on Windows by default. Added `windowsHide: isWindows` alongside every `shell: isWindows` (six sites).
- CLI dashboard poll timed out after 15s — bumped to 45s (90 × 500ms) in `apps/cli/src/index.ts` because the bundled CJS cold-boot on Windows is slow (Windows Defender real-time scanning + Node's first-load module compile).
- `agents.create` timed out at 30s on team deploy — bumped the gateway-client's default RPC timeout from 30s to 60s and added per-call 120s overrides to `agents.create` and `agents.files.set` to cover the worst-case OpenRouter model-capabilities fetch on Windows (observed up to 74s in user logs).
- "Retry" button at the Gateway-start step didn't recover (only page refresh did) because the 15s server-side polling fired before the Gateway finished binding (~51s on Windows), and a Retry click would spawn a duplicate openclaw process racing the first for port 18789. Bumped server polling to 60s (120 × 500ms), extracted the polling loop into a `pollUntilReachable` helper, and added a mid-launch detection check via `readGatewayPid` + `isProcessAlive` — if a previous request already spawned the Gateway and its pid is alive, the new request joins the existing polling instead of spawning a duplicate.

All Round-2 options are no-ops on Unix; macOS compatibility is preserved.
