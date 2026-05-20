---
'clawboo': patch
---

feat(connection): in-dashboard device pairing approval for OpenClaw 2026.5+.

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
