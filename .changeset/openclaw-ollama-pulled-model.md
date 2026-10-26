---
'clawboo': patch
---

`POST /api/system/configure-openclaw` with the `ollama` provider now writes a config OpenClaw can run. Before, every OpenClaw run on that config failed with "Unknown model: ollama/llama3.2", whether or not the model was pulled.

OpenClaw only runs Ollama models once it has an Ollama credential, and Clawboo wrote none. It now writes `OLLAMA_API_KEY=ollama-local`, the local marker OpenClaw accepts, which isn't a secret.

The default model is now one your Ollama has actually pulled: the requested model (or `llama3.2`) when it's pulled, otherwise the most recently pulled model that can use tools, the same pick a new Clawboo Native agent gets.

If you set `OLLAMA_BASE_URL`, OpenClaw now uses that Ollama too. OpenClaw doesn't read the variable itself, so Clawboo writes it into OpenClaw's config.
