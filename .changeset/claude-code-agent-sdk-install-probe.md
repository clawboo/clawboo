---
'clawboo': patch
---

Claude Code reads as installed when the Claude Agent SDK is. A Claude Code run starts the SDK's own `claude` binary from its platform package and never a `claude` CLI, but the Runtimes panel looked only for the CLI, so an install with the SDK alone read **Not installed** and could not pick Claude Code for a team. The panel, the install route and the runtime's health check now also accept the SDK's binary, found the way the SDK finds it (its platform package, the musl build first on a Linux without glibc), and `GET /api/runtimes` reports where the binary came from in `binSource`. With the SDK's binary there, **Install** no longer downloads the CLI as a second copy no run uses.
