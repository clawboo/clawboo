---
'clawboo': patch
---

fix(server): SPA root path now serves index.html in the bundled production server.

Replaces an Express 5 wildcard catch-all (`/{*splat}`) that failed to match the bare `/` path under path-to-regexp v8 with a version-agnostic `app.use(handler)` SPA pattern. Also adds a `smoke-test-bundle` CI job that boots the bundled server and curls `/` so this class of bug can't ship again.

Fixes the "Cannot GET /" that affected v0.1.1.
