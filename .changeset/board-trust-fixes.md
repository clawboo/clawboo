---
'clawboo': patch
---

The board no longer says work started, or was handed off, when nothing happened.

**Deleted chat rooms.** Deleting a room now waits for its work to stop, then moves its unfinished tasks to General, still stopped, so Retry, Assign or a reply runs them there. Before, those tasks stayed filed under the deleted room, where nothing could run them, while Retry, Assign and a reply all answered that they had started. Clawboo moves the tasks of rooms deleted before this update when it starts. A task left behind by a deleted team is now refused as having no team. Stopping a room also releases every task its work was running, not only the first.

**Boo Zero's own chat.** Boo Zero is told that it cannot hand out work from its own chat, and sends you to the team's chat instead. A hand-off that still appears in a reply there shows as a **Not handed off** note, not as a "Delegated to" card for work that never starts.

**Hand-offs to no one.** When a lead hands work to a name that is not a teammate in the chat, or to itself, it is now told the hand-off did not start, with the names it can use. The delegate tools now answer that the work is queued, since they answer before Clawboo has matched the name.

**Agents' board tools.** On team chat runs, Claude Code, Codex and Hermes agents no longer get the tools that claim tasks or change their status, which the team engine does itself: a stray claim used to strand a card nothing could recover, and an agent marking its own task done cost its lead the result. They can still mark their own task blocked, and the task then waits in Needs you while the lead is told why. OpenClaw agents get no claim or status tools at all, since their tools cannot tell one agent from another. Elsewhere, `claim_task` claims for the agent that calls it.

**Long tool calls.** A team chat run that is silent inside one tool call, such as a long build or a command that prints nothing, is no longer stopped after 10 minutes. It now gets 25 minutes, a minute past the 24 minutes a delegated task is allowed inside one tool call, so the task's own limit decides and the lead hears the real reason.

**Cancelling through the task tools.** Cancelling a task with `update_task_status` now cancels the plan steps waiting on it, as Dismiss on the board does, and tells the agent that handed the task out. Before, those steps waited in To do forever.
