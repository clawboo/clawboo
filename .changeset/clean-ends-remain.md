---
'clawboo': patch
---

---

## "clawboo": patch

Team chat reliability, plus provider and model UX:

- **Replies no longer vanish** — every streamed team-chat reply now commits to the transcript (or is cleanly cleared), so a delegating agent's message can't disappear on the next update or on reload. A native 1:1 reply that fails mid-stream is preserved instead of silently dropped.
- **Live Working/Idle badges** — the sidebar agent and Group Chat status indicators update in real time for native / server-orchestrated team runs and native 1:1 chats, not just OpenClaw over a live Gateway.
- **Runtime provider manager** — the Runtimes panel's Manage view for Clawboo Native, OpenClaw, and Hermes lists the LLM providers you have actually connected (synced with Settings → Providers), each with per-provider connect/disconnect, one-click reconnect using an existing key, and a default-model picker for Native. A native runtime with no key now honestly reads "Disconnected" with a "Set up in Runtimes" shortcut instead of a false ed".
- **Reconnect any provider** — reconnecting Clawboo Native is no longer Anthropic-only; reconnect with any provider you have already configured.
- **Two-layer team model picker** — when creating a team, pick a provider first (only the connected ones), then its model. The picker shows the exact default model that will run instead of an opaque "Recommended", and opens on the provider the current model actually belongs to.
- **Onboarding tidy** — the Add-runtimes step shows connected providers read-only, with a Back button to the provider step where keys are added.
- **Sidebar tooltip** — the mascot's hover tooltip appears promptly and reads "Boo Zero", matching what clicking it opens.
