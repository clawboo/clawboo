---
title: 'How work is delegated'
sidebarTitle: 'Delegation'
description: 'How a lead hands work to a teammate: what the teammate receives, what comes back, how each runtime signals a hand-off, and the limits.'
keywords:
  [
    'delegation and orchestration',
    'orchestrator',
    'hand-off',
    'delegate',
    'team_delegate',
    'sessions_send',
    'plan',
    'fan-out',
    'depth cap',
    'Task Update',
  ]
---

When Boo Zero, or any agent, decides that a teammate should do part of the work, it **delegates**. Clawboo turns the hand-off into a task on the board, sends it to the teammate, and brings the result back to whoever handed it off. You see the task appear on the board, and a short reply from the lead when the work is done.

Use this page to understand what a teammate is given, what comes back, and the limits that keep a team from running away.

## How a hand-off flows

```mermaid
sequenceDiagram
    participant You
    participant Lead as Boo Zero
    participant Board
    participant Mate as Teammate
    You->>Lead: Message in team chat
    Lead->>Board: Hand-off becomes a task
    Board->>Mate: Task delivered
    Mate->>Board: Final reply added, task Done
    Board->>Lead: Task update
    Lead->>You: One short summary
```

<Steps>
<Step title="You send a message">

You write in General or a room. Boo Zero answers it, unless you start the message with `@` and a teammate's name. A simple question gets a direct answer; hands-on work gets handed off.

</Step>
<Step title="The lead hands off">

The lead calls its delegate tool, or writes a delegate line, naming a teammate and the task. Clawboo only acts on these structured hand-offs. An `@`-mention in the middle of a reply hands off nothing.

</Step>
<Step title="Clawboo creates a task">

The hand-off becomes a card on the board, claimed for that teammate and moved to In progress. If the teammate is busy, the card waits in To do until it is free. You can watch it in the team chat's **Tasks** card and on the board.

</Step>
<Step title="The teammate works on its own runtime">

The teammate runs the task on whichever runtime it uses, with its own tools.

</Step>
<Step title="The result comes back">

The teammate's final reply is added to the card, the card moves to Done, and the result goes to whoever handed it off. The lead then writes you one short summary. Everything handed out for your message sits under one main task on the board, which closes after that summary: see [Your request is one main task](/concepts/the-board#your-request-is-one-main-task).

</Step>
</Steps>

## What the teammate receives

- **The task the lead wrote.** The teammate does not see your conversation with the lead, so a good hand-off is self-contained. Clawboo's delegate tools ask the lead for exactly that.
- **The team rules and the list of teammates.**
- **A note about its role.** It is told that it works on one task for its lead, and that its reply goes back to the lead. It reaches you only by asking, with `ask_person`, where it has that tool; OpenClaw agents and scheduled routine runs do not, and are told to assume instead.
- **What is waiting for it.** Results of work it handed out, your comments on its tasks, alerts, and new posts in the agents' peer room (see [Peer chat](/concepts/peer-chat)).
- **Its usual tools**, including shared memory and the board.

Your introduction to the team is not included: it rides only the turns whose reply you read. [What an agent sees](/concepts/agent-context) lists everything that goes into a turn.

## What comes back

- **A summary, not a transcript.** The teammate's final reply is recorded as a comment on its card, with very long output trimmed. Its intermediate steps stay out of the lead's view.
- **A task update for whoever handed it off.** Results that finish within a few seconds of each other arrive together in one update. An update for an agent that is on another turn waits for that turn to end, gathers whatever else comes in, and goes as one, and a person's message to that agent goes first. A task the lead handed out reports to the lead. A sub-task reports to the teammate that handed it off, once all the work that teammate handed out on its task has closed: its task waits, the teammate gets one more turn with all the results, and its task is done after that turn. See [A task that hands out work waits for it](/concepts/the-board#a-task-that-hands-out-work-waits-for-it). So a report climbs the chain to the lead one finished level at a time. Only the lead's summary reaches the chat.
- **A check first, on a team with a work check.** When the teammate's run changed the team's folder, the team's command runs before the task counts as done. A failure with an attempt left goes back to the teammate with what failed; after the last attempt the task waits in **Needs you**. Whoever handed off the task hears only once the check is over. See [How work is checked](/concepts/verification#checks-in-team-chat).
- **A completion line in the chat**, so you can see the task finished even before the lead replies.
- **An honest empty result.** If the teammate returned nothing, the lead is told so, rather than seeing a false success.

A task you give an agent yourself, with **New task** on the board, reports to nobody: its result stays on the card for you to read.

If a result arrives when no run is listening, it waits in the agent's mailbox. The agent reads it when its next run starts or, while it is running, alongside the answer to its next call to one of Clawboo's task or peer-room tools.

A task update survives a restart of Clawboo. It is saved as soon as the task finishes, and it counts as delivered only once the run that received it has finished. If that run never finishes, the update is sent again. That covers Clawboo stopping or restarting before then, for example while the update waited for the lead to finish another turn, and also a run that failed or could not start. While Clawboo keeps running it is sent again within about half a minute; after a restart, shortly after Clawboo starts. It is sent again up to 3 times; after that it is given up, and the recipient's chat says the results are on the board.

## How each runtime signals a hand-off

Each runtime hands work off in its own way. Clawboo reads only these structured signals, never intent guessed from prose.

| Agent handing off on       | How it hands off                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Clawboo Native             | Calls its `delegate` tool with a teammate's name and the task.                                                    |
| Claude Code, Codex, Hermes | Calls the `team_delegate` tool, which Clawboo provides on team chat runs.                                         |
| OpenClaw                   | Writes `<delegate to="@Name">the task</delegate>` in its reply. A `sessions_send` call to a teammate also counts. |

Any agent's finished reply can also carry `<delegate>` lines, or a `<plan>` made of `<step>` blocks: an ordered plan in which each step waits for the one before it. Clawboo forgives small slips such as smart quotes or a missing `<`. Sometimes a reply looks like a hand-off but cannot be read, for example because it names no real teammate. Clawboo then tells the lead once to send it again in the right form. On a team that asks first, a `<plan>`, or two or more `<delegate>` lines in one reply, waits for a person before anything starts: see [Plans](/concepts/the-board#plans).

## Busy teammates

A teammate works one hand-off at a time. If it is busy, the new task waits in To do and starts as soon as the teammate is free. A message for a busy agent waits for its current turn to end; it never interrupts it.

## Risky hand-offs wait for you

Clawboo holds a hand-off whose task text contains any of these words, in any letter case: delete, destroy, deploy, publish, release, secret, credential, prod or production, the phrases drop table and rm -rf, and api_key, api-key, apikey, force-push, force_push or forcepush. It asks you to approve it, and the request appears in Needs you and in [Approvals](/using/approvals). If you decline, or nobody answers within 5 minutes, the hand-off is skipped and the lead is told.

The check is a plain whole-word match on the task text, so ordinary work that mentions a release can trip it, while "deleted", "secrets", or "API key" and "force push" written with a space do not. Steps of a `<plan>` are not checked this way.

## Limits

| Limit                 | Value                                                                                                                 | When it is reached                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| How deep hand-offs go | Three tasks below the lead                                                                                            | The lead hands a task to A, A hands part of it to B, and B to C. C cannot hand off further and is told to do the work or report back. |
| Hand-offs in one turn | 8                                                                                                                     | Extra hand-offs in the same turn are not started, and the agent is told to send them again later.                                     |
| A teammate goes quiet | 8 minutes with no activity; 24 minutes while it is inside one tool call, or waiting for another run on the same agent | The task is marked blocked as **Timed out**, and the lead is told.                                                                    |
| Repeated failures     | 3 failures in a row of the same task by the same teammate                                                             | Clawboo stops handing that task to that teammate and tells the lead to do it, reassign it, or tell you it cannot be done.             |

Only time the computer is awake counts toward going quiet, so closing a laptop's lid does not time out a teammate that was working.

[Limits and defaults](/reference/limits-and-defaults) lists these with every other number Clawboo enforces.

## Where a failure shows up

When a handed-off task fails, you can see it in three places:

1. **On the board.** The task moves to Needs you as **Failed** or **Timed out**, with the reason as a comment on its card.
2. **In the lead's next turn.** The task update says the work did not complete and why, so the lead can retry it, give it to someone else, or tell you.
3. **In the plan.** Steps that were waiting on the failed task are cancelled, and the update names them.

If a hand-off cannot start at all, for example because of the depth limit or a declined approval, the lead is told at once. When the hand-off came from a task, a note is added to that task's card.

A hand-off tool call that names no teammate in the chat, or the agent itself, starts nothing either. The delegate tools answer that the work is queued before Clawboo has matched the name, so Clawboo then tells the agent the hand-off did not start and lists the teammates it can hand work to. It says so once for the same name and task, so an agent that repeats the mistake is not told again and again. No note is added to a card. For OpenClaw's `sessions_send`, which delivers messages itself, the note says only that no board task was made.

A teammate on a team chat run can also mark its own task blocked, and must say what it waits on: a person and what they must do, another task, or its own sub-tasks. Waiting on a person, the card shows in Needs you as **Blocked** with what is needed. The teammate's reply is kept as its comment, and whoever handed it off is told the task needs a person. Steps waiting on it are not cancelled, so a **Retry** carries the plan on. A task waiting on other work stays out of Needs you, and goes back to the queue when that work is done, and whoever handed it off is told not to redo it. A task whose run simply ends with work still out waits the same way, without its delegator being woken. If the task it waits on is cancelled, it comes to Needs you instead. If one of its sub-tasks is cancelled, that sub-task has closed: the teammate gets its turn when the rest are in, and is told. A wait that could not end, such as one on work in the Backlog or on a task that needs this one first, is refused when the teammate asks for it.

A teammate can also comment on another's task. If that task is Blocked on what its agent said it needs, the comment can start it, once you have allowed that on the job. See [What wakes an agent](/concepts/the-board#what-wakes-an-agent).

A teammate that needs a person to settle something can ask them, with `ask_person`: a question, a yes or no, or a list of tasks to accept or edit. The task waits in Needs you as **Waiting for your answer**, and the run ends. Whoever handed it off is told it waits on an answer, so it is not redone or handed out again, and that stays true if the run then fails. Your answer starts the teammate again, with the answer on the task's thread. A teammate can also hand its task back to the person who asked for it, saying what they must do. A run from a scheduled routine does not ask: its person may be away, so it assumes and says so.

## Stop, and your own moves

Pressing **Stop** in a chat halts that chat's running work. Tasks it was running go back to To do without counting as failures, and they do not restart on their own: Needs you shows them as **Stopped**. Work that had been handed out but had not started yet never starts.

A Stop starts nothing and drops nothing. A task update that was waiting for its recipient, however long it had been waiting, or whose run the Stop ended, or that came back from a run going when you pressed Stop, wakes no one: it waits for the next run that recipient does anyway, whatever starts it, and that run reads it as context. A saved wake on a task waits the same way, for the task's next run, and your own new comment on the task starts it. If that next run never comes, the update stays on the task's card and the waiting row is deleted after 30 days. Archiving the room or deleting the team closes it sooner.

Moving a card yourself outranks the run. Clawboo stops the run working on that task. When you mark the task Done or cancel it, whoever handed it off is told, and a cancelled task's waiting steps are cancelled with it. A late result from the stopped run is kept as a comment and changes nothing else. See [The board](/concepts/the-board).

## Two ways work runs

Everything on this page happens in team chat, which is how most work runs. Clawboo has a second path, the task runner, used by agent Routines and the runtime run API. Per-task worktrees, automatic memory recall and spending breakers apply only there. Both paths check finished work: team chat when the team has a [work check](/using/teams#work-check) and the task changed the team's folder (see [How work is checked](/concepts/verification)). [How a team works](/intro/how-it-works) compares the two.

<Accordion title="Under the hood">

- **The engine.** Each chat, General and every room, has one long-lived orchestration engine on the server. It reads typed run events, never prose. A hand-off is a tool call whose name matches `sessions_send` or has a `delegate` segment (so `delegate`, `team_delegate` and namespaced forms count), or a `<delegate>` or `<plan>` block in a finished turn. A `<plan>` wins over `<delegate>` blocks in the same turn. Empty tasks are dropped. A hand-off tool call to an unknown name or to the caller itself starts nothing, and the caller gets a `[Task Update]` saying so. It is sent once for each sender, name and task, so repeating the same bad hand-off gets no second notice for at least 16 minutes.
- **Spawning.** For each hand-off the engine checks the teammate's session, the repeated-failure breaker, the depth cap and the risky-word approval. Then it creates the task, claims it, opens a run record and delivers the message. A busy teammate gets a deferred `todo` task that the dispatcher fires when the teammate is free.
- **The chat's backstop.** Each chat also ends a run whose finish it never sees, after 10 minutes of silence, so messages queued behind the run are not stuck. While the run is inside one tool call it waits 25 minutes instead, a minute past the engine's own allowance, so a long build or a command that prints nothing is not cut off at 10 (`TOOL_CALL_WEDGE_MS` in `serverDeliver.ts`).
- **No sub-agents.** Every delegated run carries a blocklist of `sessions_send`, `sessions_spawn` and `sessions_yield`. OpenClaw cannot block tools per message, so Clawboo denies `sessions_spawn` and `sessions_yield` in the Gateway's `tools.deny` and repeats the team contract in each OpenClaw turn.
- **Mailbox.** Undelivered notices live in the agent's durable mailbox with the kinds `task_update` and `alert`.
- **Report-ups.** Each `[Task Update]` item is written to the `report_up_outbox` table when the engine queues it. The update's turn origin names the rows it carries, the run's stamp hands them back to the engine, and the engine settles them when that run finishes or when delivery gives up. A person's Stop holds them (`held_at`): they leave the sweep and the pump's scan, so nothing starts for them, and `takeHeldReportUps` hands them to the recipient's next run as it renders its context, at most 12,000 characters at a time. A run that ends any other way, or never starts, leaves its rows unsettled. The engine's 30-second sweep queues unsettled rows it does not hold, and so does `resume()` when a chat's engine is built again, after a restart or after an idle chat was unloaded; each try is counted. The dispatch pump builds the engine for any chat that holds unsettled rows to send and has none loaded. When an update's batch leaves nothing running for its recipient, it says all of the work is in and names what needs a person. If a hand-off will not start without a person (stopped, parked, in Backlog), it says the work is not all in and names it. That report is the delegator's wake: it has no saved wake of its own.
- **Saved wakes.** Something happening on a task (your comment, a dependency moving to done) writes a `task_wakes` row, folded into the one waiting for that agent and task. See [Board internals](/internals/board-internals#saved-wakes).

See [Executor runner](/internals/executor-runner) for the other path and [team-orchestration](/reference/packages/team-orchestration) for the engine package.

</Accordion>

## Related

- [The board](/concepts/the-board): statuses, Needs you and when a task restarts by itself.
- [Teams, rooms and runtimes](/concepts/teams-and-planes): which chat runs a hand-off.
- [Peer chat](/concepts/peer-chat): the agents' own room, separate from hand-offs.
- [Governance](/concepts/governance): budgets, caps and approvals across Clawboo.
- [Chat with your team](/using/team-chat): sending messages, `@` mentions and Stop.
