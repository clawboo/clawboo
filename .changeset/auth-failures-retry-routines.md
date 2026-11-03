---
'clawboo': patch
---

A refused key, login or account now reads as what it is: the task waits in **Needs you** with **Fix sign-in**, nothing retries it into the same refusal, and a routine keeps its schedule through a rate limit or a provider outage.

**Sign-in and billing failures.** Two new error classes, `Auth` (a missing, revoked or expired key or login) and `Billing` (no credit, an account on hold, a pending verification), replace the old filing of these under `UnexpectedEnv` and `ProviderError`, and neither is a harness bug. An empty OpenAI balance (`insufficient_quota`), which arrives as a 429, is now `Billing` instead of a rate limit. The class comes from the runtime's own error, never from what the agent wrote, and a run the idle guard ended is a `Timeout`. Claude Code, Codex and Hermes put the cause they know on the error's code, in the same words where they mean the same thing: Codex's typed app-server causes, and the `code` or `type` of the provider error Hermes prints. Network drops (a reset or refused connection, `fetch failed`, a dropped stream) are `ProviderError`, and a plan's usage limit is `RateLimited`. Each failed run's class is stored on its ledger row.

**Needs you and Retry.** A task whose run failed on `Auth` or `Billing` shows **Sign-in failed** or **Billing problem**, and leads with **Fix sign-in**, which opens **Settings > Runtimes** at the runtime that ran it with its row open. **Retry** moves to the card's menu and asks first, quoting the error. The same goes for a card that groups several such tasks, and for the task drawer. Clawboo never retries such a task by itself.

**Team chat.** When a delegated run fails on its sign-in or billing, the task's comment says so, and the report to the lead tells it not to re-delegate or retry the task and to tell you. Once you have fixed the sign-in, asking the lead to try again works.

**Routines.** A routine keeps its schedule through a failure that may pass by itself (a rate limit, a timeout, a provider error or a dropped connection), records the error, and runs at its next time; a success clears it. Three such failures in a row, or any other failure, stop it until you resume it, and resuming starts the count again. The task a failed fire set aside says whether the routine runs again.

**Claude Code.** A run whose conversation outgrew the model's context window (`terminal_reason: 'prompt_too_long'`) is out of room rather than failed: the task runner continues it in a fresh session with a handoff note, as it does at the turn limit.
