---
'clawboo': patch
---

Clawboo Native now lists the models your local Ollama has actually pulled, instead of always offering `llama3.2`.

Onboarding used to check only that Ollama answered. With Ollama running but `llama3.2` never pulled, you got through onboarding and then every run failed with "model not found".

The onboarding model dropdown and the Ollama row in **Settings → Runtimes → Clawboo Native → Manage** now list the chat models your Ollama has pulled. Embedding models such as `nomic-embed-text` are left out, because they can't run an agent, and a model that can't use tools is marked. If Ollama is running with no chat model, both places say so and show `ollama pull llama3.2` with a **Check again** button. Continue on the connect step now also checks that the model you picked is pulled, and gives the `ollama pull` command when it isn't.

Agents created without a model pick on Ollama start from your default Ollama model, or from `llama3.2` when none is recorded, and keep it when it's pulled. Otherwise they get the most recently pulled model that can use tools, the same one for the lead and the specialists, so Ollama doesn't swap models in memory between turns. The model the pickers preselect is a fallback recommendation worked out the same way from `llama3.2`. A run that still reaches a missing model, or one without tool support, now says which model and how to fix it instead of showing Ollama's raw error.
