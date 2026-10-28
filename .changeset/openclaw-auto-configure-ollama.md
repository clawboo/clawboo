---
'clawboo': patch
---

Setting up OpenClaw now works on a local Ollama. If Ollama is the provider you connected for Clawboo Native, **Set up OpenClaw** configures OpenClaw on it instead of asking for an Anthropic, OpenAI or OpenRouter key.

`POST /api/system/auto-configure-openclaw` has a new Ollama step, the last one before the key prompt: a connected key, OpenClaw's own ChatGPT sign-in and the offer of that sign-in to a signed-in `codex` CLI all come first. It writes `OLLAMA_API_KEY=ollama-local` to OpenClaw's `.env` and a default model your Ollama has pulled, and points OpenClaw at `OLLAMA_BASE_URL` when you set one. Like the rest of the route it never replaces a default model you already set, and it keeps an `OLLAMA_API_KEY` that already has a value.

The response also says whether Ollama has that default model. When it doesn't (or Ollama isn't running), the setup stops before starting the Gateway and shows the `ollama pull` command, instead of reporting a success whose first message would fail.

`POST /api/system/configure-openclaw` now returns the `model` it wrote, which for Ollama can differ from the one requested.
