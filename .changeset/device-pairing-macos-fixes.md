---
'clawboo': patch
---

Fix device pairing on fresh macOS installs (v0.1.7):

- `POST /api/system/approve-device` now uses `spawnSync` for the `openclaw devices approve --latest` preview step so the CLI's preview-mode non-zero exit code no longer swallows the request-id stdout we need to parse. Step 2 (the real approval) keeps `execFileSync` but surfaces `stderr` / `stdout` from any thrown error instead of Node's `Command failed: <argv>` wrapper.
- The onboarding wizard's `StartGatewayStep` now catches `GatewayResponseError { code: 'NOT_PAIRED' }` and renders the in-product `DevicePairingApproval` card inline. Users no longer have to do a manual page refresh to escape the wizard's "Something went wrong" panel on a fresh-install machine with OpenClaw 2026.5.x. After approval, the wizard auto-retries the connect and advances normally.
