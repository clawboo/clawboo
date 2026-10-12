---
'clawboo': patch
---

Task costs are now honest, teammate replies stay out of the team chat unless you asked for them, and the team lead knows what each teammate does.

**Task cost.** A task's cost is now the sum of every run of it, recorded on each run in the execution ledger. Failed, stopped and timed-out runs are counted, and a retried task no longer shows only its last run. When a runtime reports no charge, Clawboo prices the run from its token usage, or from prompt and reply length when there is none, and the card marks it as an estimate (`~$0.02 est.`). A task that has not run shows no cost instead of `$0.000`, and the drawer says "None recorded". The execution ledger names the runtime that actually ran. Claude rates were corrected to Anthropic's list prices (Haiku 4.5, Haiku 3.5, Opus 4.5 and later, Sonnet 5), and dotted model ids such as `anthropic/claude-haiku-4.5` now match their rate. `GET /api/board` rows carry `runCost`, and execution rows carry `runtime` and `costSource`.

**Team chat.** A teammate's reply reaches the chat only when you addressed it or it is the lead's summary:

- A teammate that handed part of its task to others and got the results back after finishing no longer answers in the chat as if you had asked. Its follow-up is added to its task card and passed to whoever gave it the task, so the lead's summary is what reaches the chat. A task you assigned keeps it on the card.
- Stop now also stops a reply or task that was about to start (waiting behind another run on the same agent), and a run from before the Stop no longer starts new work after it or frees the slot of a run started after it.
- A delegated task still waiting to start is no longer failed as silent after 8 minutes, and one released while waiting no longer runs into the chat.
- A message you send an agent that is working on a task is always shown.

**Team lead routing.** On the lead's turn, the team roster now lists each teammate with its runtime and a one-line role read from its `SOUL.md`, so Boo Zero routes work by what a teammate does instead of by name alone. Other turns still list teammates by name. OpenClaw teammates show only their runtime, because their files live on the Gateway.
