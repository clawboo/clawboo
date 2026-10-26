---
'clawboo': patch
---

Clawboo Native agents now run on the provider you picked as your default.

A team deployed without a per-agent model pick used to take the first provider with a key in a fixed order (Anthropic, then OpenAI, then OpenRouter, then Ollama). An `ANTHROPIC_API_KEY` in your shell or in OpenClaw's `~/.openclaw/.env` therefore put every agent on Anthropic, a billed provider, even after you picked another provider as your default, while the deploy dialog still read "Default · <your model>".

Agents now use your default provider whenever it is set up. The leader runs your default model and the specialists run that provider's faster, cheaper model. On Ollama every agent runs the model you picked, as long as Ollama still has it pulled. The fixed order only applies when you have no default, or its provider is no longer set up. Each row of the deploy dialog now names the model that row will actually get, so the leader and the specialists can read differently.
