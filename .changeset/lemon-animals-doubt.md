---
'clawboo': patch
---

fix(bootstrap): always verify OpenClaw install state instead of trusting stale localStorage.

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
