---
'clawboo': patch
---

A Marketplace deploy now starts each member on a runtime you have connected. When the suggested runtime is not connected, the member moves to the first one that is: Clawboo Native (with an API key or a local Ollama), then OpenClaw, Claude Code, Codex and Hermes. With only a ChatGPT sign-in, that is Codex. It used to move every member to Clawboo Native, which cannot run without a provider. The note on the row now names the runtime it uses, for example "OpenClaw unavailable · using Codex".

Pressing Deploy again after "No agents could be created" now works. The failed attempt left an empty team behind, and the retry tried to create a team with the same id, which the server refused. Clawboo now removes that empty team when no agent could be created, so the retry starts clean. If it cannot remove it, the message says so, so you can delete it before trying again.
