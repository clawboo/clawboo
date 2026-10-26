---
'clawboo': patch
---

Setting up or reconnecting OpenClaw now connects to the Gateway port in your OpenClaw config. `POST /api/system/auto-configure-openclaw` kept a `gateway.port` you had changed, but it always saved `ws://localhost:18789` as Clawboo's Gateway URL, so the Gateway started on your port while Clawboo tried to connect on 18789. The saved URL now uses the same port the Gateway route starts on.
