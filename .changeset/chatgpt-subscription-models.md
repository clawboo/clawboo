---
'clawboo': patch
---

Agents running on a ChatGPT subscription work again. OpenAI's backend now refuses the models Clawboo used to pick for subscription runs ("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account"), so every such run failed. Clawboo no longer names a subscription model of its own: which models a ChatGPT plan may use is OpenAI's call, per account, and it changes.

- **Hermes** on the subscription now runs your plan's own default, which Hermes asks the backend for, instead of a fixed model.
- **OpenClaw** set up on the subscription gets your plan's own default model, read live from your Codex CLI. When that list is unknown, OpenClaw applies its own default.
- **The model pickers** list your plan's models, read live from your Codex CLI, instead of a fixed list. Hermes's ChatGPT subscription group also offers **Plan default**, which works even before that list is known.

**Codex too old for your plan.** An older Codex CLI cannot read your plan's current models and quietly falls back to the ones it shipped with, which OpenAI refuses (codex 0.136 did this). A failed Codex run now reports OpenAI's own reason and says to update the CLI, instead of an unrelated line from the CLI's log, and the Codex card in Settings → Runtimes shows an **Update** button when it detects an outdated CLI.
