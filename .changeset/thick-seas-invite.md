---
'@clawboo/gateway-client': patch
'clawboo': patch
---

fix: OpenClaw protocol-4 compatibility + Windows install support.

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
