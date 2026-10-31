---
'clawboo': patch
---

Spend tracking now counts what agents really cost, and a hard cap no longer throws away work that was already paid for.

- **Local Ollama models are free.** A run on a model your own Ollama serves was charged the $3/$15 per million token default rate and shown as an estimate. It is now recorded at $0, a task that only ran locally reads **free** on the Board, and no budget is charged. This covers Clawboo Native agents on Ollama and OpenClaw agents whose model is an `ollama/` one. Ollama's cloud models (a `-cloud` tag) still count, because they do not run on your machine.
- **A hard cap keeps a finished result.** Claude Code and Codex report what a run cost only as it ends. When that last report took a budget past its hard cap, the run was recorded as cancelled, its result was dropped and the task went back to To do, so a retry paid for the same work again. The finished result is now kept and posted, the task moves on as usual, a comment says the cap was reached, and the next run is refused until you raise the cap or resume. A run that keeps working past the cap is still stopped.
- **Every run is charged.** An OpenClaw routine run that failed, timed out or was stopped charged no budget, and an agent routine or API run that ended without a cost report (a Claude Code run that failed first, or a Hermes run that reported no usage) recorded nothing. These are now estimated from the length of the prompt and reply, the same way team chat already estimated them.
- **Tokens Used lists every runtime.** The view counted OpenClaw agents only, so Clawboo Native, Claude Code, Codex and Hermes agents always read zero. Their runs are now listed too: Board and API runs, routines and team-chat runs. Earlier runs are not backfilled.
