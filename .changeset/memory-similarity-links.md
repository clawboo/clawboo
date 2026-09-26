---
'clawboo': patch
---

Similarity links in Memory now actually appear.

On a machine running Ollama without its embedding model, the graph said
similarity was waiting on data while every saved fact quietly lost its
vector. Clawboo now checks the model is installed, says plainly what is
missing, and offers the fix in place: install the model from the app with
progress, retry indexing, or switch provider. Facts saved while nothing could
embed them are indexed in the background as soon as a provider can, and
starting Ollama, pulling the model or adding a key takes effect without a
restart.

Local stays local. Once your memory has been indexed with Ollama, an OpenAI
key is never used on its own, even while Ollama is down: switching is a button
that says how many facts it sends, it lasts until Ollama is back or the key is
disconnected, and Memory shows while it holds.
