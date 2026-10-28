---
'clawboo': patch
---

Clawboo Native now runs on a local Ollama with no API key and no environment variable, as onboarding has always promised.

Picking **Ollama** on the onboarding connect step used to record nothing. Without `OLLAMA_BASE_URL` set, the team you deployed next landed on Anthropic, no Boo Zero was created, and the first team message answered "Clawboo Native has no provider key connected". Even with the variable set, every deploy row read "Clawboo Native unavailable" and the 1:1 chat stayed disabled with a "Disconnected" badge while team chat worked.

Clawboo now records the Ollama choice itself, and that choice counts as a connected provider everywhere: the runtime reads Connected, agents deployed without a model pick run on Ollama, Boo Zero is created on it, and both team chat and 1:1 chat work. Ollama is reached at `http://localhost:11434/v1`, or at `OLLAMA_BASE_URL` when you set one. Pull the model first (`ollama pull llama3.2`, the default).

You can also turn Ollama on or off later from **Settings → Runtimes → Clawboo Native → Manage**, which now lists it beside your provider keys, with its default model and a **Disconnect Ollama** that leaves your keys alone.
