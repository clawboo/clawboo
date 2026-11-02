---
'clawboo': patch
---

Connecting OpenClaw with a Google key now sets a Gemini model that still runs. Clawboo wrote `google/gemini-2.0-flash` as OpenClaw's default model, but Google shut that model down on 2026-06-01 and OpenClaw's config validation now rejects it as an unknown model. The default is now `google/gemini-3.6-flash`, Google's named replacement, and the OpenClaw model picker lists Gemini 3.6 Flash in place of Gemini 2.0 Flash.

Setup never replaces a default you already have, so if an earlier version set `google/gemini-2.0-flash`, pick another model under **Manage > Default model**.
