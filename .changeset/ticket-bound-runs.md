---
'clawboo': minor
---

An agent working a board task now knows which task it is on, and starts from that task's story instead of from zero.

**The task, in the run.** A run on a board task, a teammate's hand-off or a task you gave from the Board, now gets a task block before its waiting items: the task's id and title, its priority when not Normal, why the run started, the tasks it is part of, the results of finished tasks it waited on, its newest comments, and how the last attempt ended (it failed with an error, went quiet and was stopped, or was cut off). Every part has a limit, and a task with hundreds of comments still starts with a block of the same size, saying `get_task` has the rest. Only tasks on the run's own team's board appear in it. Before, the agent got only the task's text: a retry, a reply or a second run started with no idea what happened last time.

**Text from the board is data.** The titles, results and comments in the block, each teammate's result in a task update, and the notes that reach an agent with a tool result are quoted under a line naming who wrote them, so nothing in them can pass for an instruction from Clawboo or from you.

**The task id, for the agent's tools.** On Clawboo Native, Claude Code, Codex and Hermes, `get_task` and `add_comment` use the run's own task when a call leaves the id out, and `block_task` does too on a team run. The task rides the run's Tasks address inside its signature, so a runtime cannot point it elsewhere. OpenClaw agents are told the id to pass.

**The same session for the same task.** Clawboo Native, Claude Code, Codex and Hermes continue their own session from their last run on a task, and are told what changed since: whether the title or description changed, and only the new comments. A task given to a different agent starts fresh, a finished or cancelled task ends its session, and a run that fails to continue its session leaves the next one to start fresh. OpenClaw keeps one session per agent in each chat, so it cannot do this.

**Priority.** A task has one of four priorities: Urgent, High, Normal and Low. Set it in the task drawer; cards mark Urgent and High. An agent waiting on several tasks starts the highest first. Any number written to a task's priority is now held to those four levels, so no task can jump ahead of an urgent one.

**Comments name their real author.** An agent's `add_comment` call is always posted as an agent comment, under that agent's own name where Clawboo knows who is calling, whatever author the call names. A comment in the task block can never claim to come from you or from Clawboo when an agent wrote it.
