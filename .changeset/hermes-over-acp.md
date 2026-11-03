---
'clawboo': patch
---

Hermes agents now run over Hermes's Agent Client Protocol mode (`hermes acp`), so you see their text, reasoning and tool calls as they happen, their runs report token counts, and a comment on a running task reaches the agent without stopping the run.

**Live runs.** Each Hermes run is one `hermes acp` process: Clawboo opens a session (or loads the one a task resumes), sets the model, sends one prompt and streams Hermes's session updates into the run. The cost is now estimated from Hermes's token counts instead of the length of its text. A comment goes in as `/steer`, which Hermes reads after the tool call in progress; one that arrives while Hermes writes its final answer is sent as one more turn, so it is never dropped. Stop cancels the turn. A task or comment that starts with a slash reaches Hermes as text, never as one of its own commands such as `/model` or `/reset`. Runs keep the same headless posture as before: no prompts before commands or edits, Clawboo's MCP servers attached, and the agent's own Hermes home.

**Failures stay failures.** Hermes's ACP mode answers a failed turn as a finished one. Clawboo reads a turn that reports no token counts as failed, with the error Hermes logged as the reason.

**Install and fallback.** Clawboo now installs `hermes-agent[anthropic,acp]<1`. A Hermes installed earlier without the `acp` extra keeps working: each run falls back to the quiet `hermes chat` mode, which steers by stopping and resuming, and Clawboo skips ACP for ten minutes after such a fallback. Reinstall with `pipx install --force 'hermes-agent[anthropic,acp]<1'` to get live runs. `CLAWBOO_HERMES_TRANSPORT=quiet` keeps every run on `hermes chat`.

The ACP client is agent-neutral, so another ACP agent can reuse it later.
