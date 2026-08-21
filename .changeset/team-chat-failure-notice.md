---
'clawboo': patch
---

A team-chat run that ends without an answer now says why. Previously this was a silent non-response: you sent a message, the agent showed Working for a moment, and then nothing arrived, which is indistinguishable from an agent that simply chose not to answer. The reason was written only to the observability log, where nobody looking at the conversation would find it.

Two shapes of silence are covered. A run that fails before producing any text posts the reason, and the most common cause is also the most fixable, so an agent whose configured provider has no key answers with a notice pointing at Settings, Runtimes, Clawboo Native. A run whose stream simply stops without ever reporting a terminal now says that too, rather than leaving the chat empty. Both are posted as system messages, not as the agent's turn, so neither is mistaken for something the agent said or filtered out as a refusal.

A run the server itself ended reports that too, naming the cause: a budget cap, or a run that went quiet long enough for the watchdog to end it. These arrive as ordinary aborts, indistinguishable from someone pressing Stop, so they were previously swallowed as if the silence had been chosen.

Runs that should stay quiet still do. A run that dies part way through a reply commits the partial text it already streamed, which speaks for itself. A leader that delegates and has nothing to add speaks through the board. A delegated child run reports on the board too, where a notice would surface in a room the user never opened. And a run the user stopped is not a failure at all.

Telling those apart needed a fix in the Claude Code runtime. Stopping one of its runs reported a crash rather than a deliberate stop, because that runtime, alone among the four, did not mark its own aborts. It now does, the way the native, Codex and Hermes runtimes already did. That also changes what the board does with a stopped run: previously a Stop was recorded as a failure, which blocked the task and cancelled whatever depended on it, and it is now released the way a stop should be.
