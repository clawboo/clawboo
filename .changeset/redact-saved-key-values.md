---
'clawboo': patch
---

Keys saved in Clawboo are now masked by value wherever Clawboo scrubs secrets before saving: tool-call records, observability events, governance audit entries, memory, run summaries and the verify gate's output. The scrub only knew the shapes of a few providers' keys, so a supported key of another shape (a Groq `gsk_` key, a Mistral key, an xAI `xai-` key) was stored in clear, for example when an agent ran `printenv GROQ_API_KEY`. Every provider key, connector credential and connector sign-in token in the vault is now replaced with `[REDACTED]` as written, inside JSON text and inside URLs, and the mask follows the vault as keys are added, replaced and removed. Values shorter than 12 characters are left alone so they cannot wipe ordinary words, and field names are never changed.
