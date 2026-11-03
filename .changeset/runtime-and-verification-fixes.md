---
'clawboo': patch
---

Hermes teammates get Clawboo's tools, Claude Code login and billing errors stop counting as finished work, and a task's verdict says who chose its check and whether its review happened.

**Hermes.** Clawboo now attaches its Tasks, Memory, Tools and TeamChat servers through the `mcp_servers` block of the Hermes home's `config.yaml`, the only place Hermes reads them from. The servers go inside your own `mcp_servers` mapping when the copied config has one, so your servers keep working. A Hermes run also reports that it is still alive every minute, so a delegated Hermes task that works for more than eight minutes is no longer stopped as unresponsive.

**Claude Code.** A run that ends on an API error (an invalid key, an expired login, a billing limit, a rate limit) now fails with the error and its cause, instead of finishing as done with the error text as its result.

**Native agents.** Google agents default to `gemini-3.6-flash` (Google shut down `gemini-2.0-flash` on 2026-06-01), and Gemini 3 tool calls keep their thought signatures, so multi-step tool turns work. Anthropic runs, direct or through OpenRouter, use prompt caching, and cached prompt tokens are priced at the cache rates.

**Verification.** A team can set its verify command with `PUT /api/team-verify-command/:teamId`; the gate runs it in place of the command in the task's `init.sh`, and new task worktrees are set up with it. Every verdict records where its command came from, and the task drawer flags a check the agent wrote itself. A review that failed or came back empty is shown as such instead of "Reviewed by".
