---
'clawboo': patch
---

You can now chat one-to-one with a Claude Code, Codex or Hermes agent from its page, with no OpenClaw Gateway.

The message box on these agents' pages used to go through the OpenClaw Gateway, which does not run them. Without a Gateway it read "Gateway not connected…", and with one a message went nowhere. These chats now run on the Clawboo server, the same way Clawboo Native chats do, and the reply streams back into the chat. Each agent picks up its own session from one message to the next, so it remembers the conversation, and `/reset` starts it fresh. Claude Code, Codex and Hermes also get the agent's persona (its `SOUL.md`) on every turn, as they do in team chat.

Every 1:1 chat, Clawboo Native included, now starts in the agent's team working folder, `~/.clawboo/workspaces/<team id>` (`workspaces/_no-team` for an agent on no team, such as Boo Zero), never in Clawboo's own data folder. For Claude Code, Codex and Hermes the folder only sets where the run starts; they keep your full file access. A Clawboo Native agent can now read and write files in its 1:1 chat, only inside that folder, and one with **Running commands** switched on can ask to run a command there, which waits for your approval in the chat. Native's file tools also refuse a symlink that leads outside their folder.

A turn that fails before it answers now leaves a notice in the chat with the reason, a run that goes silent for too long is ended and reported instead of holding the agent forever, and the send button stays on Stop for the whole turn, including a Hermes reply that only arrives at the end.
