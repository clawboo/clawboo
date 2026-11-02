---
'clawboo': patch
---

System Health no longer reports problems that are not there, and says plainly when trace export is off.

**OpenClaw Gateway check.** On an install that never set up OpenClaw, the check read **Degraded** on every start and the panel said "Running degraded." It now passes as skipped. It still runs, and still degrades when the Gateway is down, once Clawboo's settings name a Gateway or OpenClaw's `openclaw.json` exists.

**OpenTelemetry.** The observability line read "OTel exporter active" whenever an OTLP endpoint was set, even though the npm package does not include the OpenTelemetry SDK and nothing was exported. It now reads "OTel exporter active" only when the exporter started, and "local event log (OTLP endpoint set, exporter not running)" otherwise. The **OTel exporter** check says when the SDK is missing. `GET /api/health` gains `config.otelConfigured`, and `config.otelActive` now means the exporter started.
