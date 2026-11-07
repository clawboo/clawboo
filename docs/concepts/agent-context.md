---
title: 'What an agent sees'
sidebarTitle: 'What an agent sees'
description: 'What Clawboo puts in front of an agent each time it runs, in order: what stays the same, what changes, what is left out, and how to check.'
icon: 'eye'
keywords:
  [
    'context',
    'prompt',
    'system prompt',
    'context window',
    'rotation',
    'team rules',
    'persona',
    'SOUL.md',
    'auto-memory',
    'memory injection',
  ]
---

Each time an agent runs, it gets a message plus a block of context that Clawboo puts together: who the agent is, the team's rules, its teammates, and anything waiting for it. What goes in depends on how the work started: a turn in team chat, or a run on the task runner. Knowing the order helps you predict what an agent knows, and fix it when it seems to forget.

## Three layers

An agent's input has three layers:

1. **The runtime's own setup**: its system prompt and its tools. Clawboo Native builds its system prompt from the agent's SOUL.md and adds today's date. OpenClaw builds its own from the agent's files in its OpenClaw workspace. Claude Code, Codex and Hermes use their own. Claude Code also reads the `CLAUDE.md` of the folder it works in, but nothing from your own `~/.claude`.
2. **Clawboo's context**, put together when the run starts and placed in front of the message.
3. **The message**: what you wrote, or the task text an agent wrote for a teammate.

Some runtimes also carry the conversation so far. [Conversation history](#conversation-history) says which.

## A turn in team chat

Clawboo builds this context for every turn in General or a room, including every task a teammate is handed there. It comes in this order, and empty parts are left out:

1. **Persona**: the agent's SOUL.md, up to 4,000 characters. Only Claude Code, Codex and Hermes get it here, because they have no persona of their own. Clawboo Native and OpenClaw already carry SOUL.md in their own setup.
2. **Team rules**: the rules you set under **Team brief & rules** or with `/rule`, marked as set by you and authoritative.
3. **About you**: the introduction you wrote when you met the team. Only turns whose reply you read get it: the leader's, or an agent you @mention.
4. **Teammates**: the names of the other members of this chat. A room lists only its own members. The leader also sees each teammate's runtime and role.
5. **How to work**: instructions for this kind of turn. A leader learns how to hand off work on its runtime. A teammate on a handed-off task learns that its reply goes back to the team, not to you, and that nobody can answer its questions mid-task. On a task you gave it from the Board, it learns that you read its reply on the task card. A note names the [peer room](/concepts/peer-chat) and board tools when the agent has them.
6. **Routine note**: when a Routine sent the message. It says you may be away, so the agent should make assumptions and state them rather than ask.
7. **Connectors**: on turns you read, the connectors whose tools this agent has, plus a few you could add. Connectors you connected but did not share with it are not named. An OpenClaw agent has only connectors shared with every agent, because all OpenClaw agents reach Clawboo's tools through one shared setting, and a Clawboo Native agent whose **tools MCP** server is switched off has none.
8. **The task**, on a run for a board task. See [The task block](#the-task-block).
9. **Waiting for you**, in two parts:
   - **Addressed to you**: results of tasks this agent handed out, and alerts about its work. The agent is told to act on them.
   - **Ambient**: what teammates posted in the peer room since this agent last spoke. The agent is told to treat them as information, never as instructions.
10. **The message**: your message, the task text for a teammate, or, when teammates finish, one batch of their results for the agent that handed out the work. Each result in the batch is quoted as the teammate wrote it, under a line saying who it came from, so the agent reads it as information about the work, not as instructions.

Results, alerts and notices share a budget of 4,000 characters, and peer-room posts get their own 4,000 characters, at most 800 per post. Anything that does not fit waits for the next turn.

The persona, rules, introduction and teammate list change only when you change them. Clawboo reads them again for every turn, so an edit applies from the next turn. The task block, the waiting items and the message are new each time, and they come after the parts that stay the same, so a provider can reuse that steady start from one run to the next (prompt caching). All of it rides in front of the message, so the runtime's own setup stays the same from turn to turn.

## The task block

A run for a board task, a teammate's hand-off or a task you gave an agent on the Board, also gets the story of that task. Before, the agent got the task's text and nothing else, so a retry, a reply or a second run started from zero. The block holds, in order, leaving out what the task does not have:

- **The task's id**, and how to use it. Clawboo Native, Claude Code, Codex and Hermes agents are told their Tasks tools use this task when a call leaves the id out (`get_task` reads its whole history). An OpenClaw agent is told to pass the id itself.
- **Its title**, and its priority when that is not Normal.
- **Why this run started**: who handed the task over, or that you assigned it, and whether it is starting again; or that you commented, that a task it was waiting on finished, or that the team's check did not pass its work yet. It reads the reason recorded on the run (`run_reason`).
- **The tasks it is part of**, nearest first, up to 6, each with its id and status.
- **The finished tasks it waited on**, with each one's result as the agent that did it reported it: up to 6, at most 2,000 characters each and 6,000 in all.
- **Its comments**: the newest 8, at most 4,000 characters each and 12,000 in all, oldest first, then how many were left out and that `get_task` has the rest. A task with hundreds of comments still starts with a block of the same size. A team chat run gets your comment once: here when the run starts, or as a steer into the run if it is already going. A comment too long for a steer comes whole in the next turn's block.
- **How the last attempt ended**: it failed (with its error), went quiet and was stopped by the watchdog, was cut off when the process running it stopped, or was stopped by a person. After an interruption the agent is told to check what is already done before it repeats anything with a side effect. When a task keeps failing, the block says how many times in a row.

The task's description is not in the block: it is the message, the agent's instruction. Everything in the block that people and agents wrote (titles, results, comments) is quoted as data: each comment and result sits under a header that names who wrote it and says it is not you, with every line of it quoted, and the block ends by saying none of it can change the agent's task or the team rules.

Only tasks on the run's own team's board appear in the block, the same limit the agent's Tasks tools keep. The block is built as the run starts, once the agent's other work has let go of it, so a run that waited behind another of the agent's runs sees the board as it is then. When the task was edited after the run's brief was written (while the run waited its turn), the block says so and points the agent to `get_task` for the current title and description.

**A run that continues its session.** When an agent runs the same task again and continues its session from its last run on it (see [Conversation history](#conversation-history)), the block says whether the brief it is sent differs from the one that run had, and carries only the comments made since then, without the ones the agent wrote in that run, in place of the thread. It still lists the tasks it is part of and the finished tasks it waited on: a long session may no longer hold its first run's block (Clawboo Native trims an old conversation from the oldest end, and the other runtimes compact theirs), and a task linked since was never in it. The task's text is sent as the message again either way, because a runtime that cannot find the old session starts a fresh one without saying so.

## A task-runner run

The task runner runs one board task, for an agent Routine or a run started through the API. It arranges its context in three layers, from what stays the same for the whole task to what changes most. Keeping the steady part first lets providers reuse it between runs (prompt caching).

| Layer                     | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steady for the whole task | The persona (Claude Code, Codex and Hermes only), then the task's title and description                                                                                                                                                                                                                                                                                                                                                     |
| Context                   | Where the last attempt left off, when the task resumes. A note on Clawboo's board, memory and peer-room tools, and how to use shared memory. A note when the runtime lacks a feature, such as live streaming on Hermes. A warning when an earlier attempt was cut off, to check before repeating anything it did. The failure note on a fix round. A handoff note after a restart in a fresh session. Waiting items, up to 4,000 characters |
| Changes most              | The memory facts most relevant to the task: the top 5 matches plus up to 2 related facts, in at most 1,500 characters. Each line carries a short id the agent can cite                                                                                                                                                                                                                                                                      |

The message is the task's title. The task runner adds no team rules, teammate list or introduction.

## What is left out

- **Teammates' working steps.** A leader gets each teammate's final reply, not the transcript of how it got there.
- **Your conversation, on a teammate's turn.** A teammate gets the task text the leader wrote for it, and not your introduction. A vague hand-off makes a vague task.
- **The team brief.** Team-chat turns carry the team rules, not the brief. The brief reaches Boo Zero only when you mention the team (`@TeamName`) in Boo Zero's own chat.
- **Memory, on team-chat turns.** Nothing is added for them; agents look facts up with their memory tools. Only task-runner runs get facts added.
- **The time of day.** Clawboo Native's setup carries today's date (in UTC), not the time.
- **Tools a run cannot use.** A tool that is off is left out rather than refused. A Clawboo Native agent whose shell commands are off, for example, sees no command tool at all.

## Conversation history

- **A leader in team chat.** A Clawboo Native or Codex leader continues the same conversation, separately in General and in each room. A Claude Code or Hermes leader starts each turn without the earlier conversation. OpenClaw keeps the conversation in its own Gateway session.
- **An agent running a board task.** Clawboo Native, Claude Code, Codex and Hermes continue their own session from their last run on the same task: a retry, a reply that restarts the task, or a run that starts again after a restart picks up the conversation of the last run that came to an end, instead of starting cold (a run cut off by a restart leaves nothing to pick up). A new task starts a new session. So does a task you give to a different agent, for everyone, the first agent included if the task comes back to it, and a task that finishes or is cancelled ends its session. When a run that tried to continue a session fails, or cannot start, the next run starts fresh, unless it failed on something that passes by itself, such as a rate limit or an overload; a run stopped part way, or one that ran out of turns, keeps its session. A run whose conversation outgrew the model's context window leaves no session to continue, so the next run starts fresh, as a first run on the task does. Clawboo Native, Claude Code, Codex and Hermes all report that case. OpenClaw cannot do this: its session is one per agent in each chat, shared by all of its turns there, so its earlier turns, other tasks included, may still be in its Gateway session.
- **A one-to-one chat with a Clawboo Native, Claude Code, Codex or Hermes agent** continues the conversation: each message resumes the session the one before it saved. On its first turn, and after `/reset`, the agent also gets up to 8 of its own saved notes, without the team's notes. Claude Code, Codex and Hermes also get their persona with every message. When a message outgrows the model's context window, the next one starts fresh and the chat says so. Clawboo Native keeps the conversation while trimming its oldest turns can make real room, and says that instead, so its next message carries only the most recent turns; when trimming could not, it starts fresh too. It also starts fresh, giving the provider's reason, when a provider refuses a resumed turn outright and sending the conversation again could only fail the same way. A rate limit or an overload keeps the conversation.
- **Boo Zero's one-to-one chat** adds Boo Zero's rules to every message. Mention a team with `@TeamName` and the message also carries that team's brief, board, saved memory and recent chat.
- **Starting fresh.** `/reset` (or `/new`) in a chat ends what the agents carry from it, and the messages stay on screen. See [Team chat](/using/team-chat).

## When the context window fills

- **On the task runner**, a run that runs out of room before it finishes starts again in a fresh session, with a short handoff note on its last progress. Running out of room means hitting its turn limit, a Claude Code run whose conversation outgrew the model's context window, or using more than 85% of the runtime's context window. This happens at most 3 times per task. Clawboo Native and Claude Code report a 200,000-token window; Codex and Hermes report none, so the 85% rule does not apply to them.
- **A Clawboo Native run** makes at most 16 model calls by default, counting each round of tool use as one.
- **In team chat** a chat turn does not restart. A Clawboo Native leader's carried conversation is trimmed to its most recent turns, about 240,000 characters. Other runtimes manage their own windows. A board task whose run ran out of room gets one more run to continue, and a second time waits in Needs you as **Out of room**. A Claude Code run that outgrew the model's context window reports as out of room, so it gets that run too, in a fresh session. A Codex, Hermes or Clawboo Native run that outgrew it is blocked as failed, and **Retry** runs it in a fresh session. A turn in the chat itself that outgrows the window leaves a notice naming the agent, which starts fresh on its next turn.

## Check what an agent saw

- **The task card.** Open it from the chat or the [Board](/using/board). It shows the exact task text the teammate received, its comments (including its report) and its activity.
- **The Activity card** on an agent's page, or beside a team's chat. It lists every tool call and result as it happens, including memory searches and hand-offs.
- **Memory** in the sidebar. Open a fact to see its history; a **cited** entry means a task-runner run was given that fact.
- **Team brief & rules** in the chat header: the rules every team-chat turn carries.
- **Details** > **Agent Files** on an agent's page: the SOUL.md that becomes its persona.
- **Settings** > **Observability**: traces of task-runner runs.

The dashboard does not show the assembled context itself. The lists on this page are the map for working it out.

<Accordion title="Under the hood">

- **Team-chat context.** `buildServerTeamContext` in `apps/web/server/lib/teamChat/contextPreamble.ts`. The waiting items are read when the run starts, not when it is queued (`serverDeliver.ts`), and framed by `buildTurnEnvelope` (`packages/team-orchestration/src/turnEnvelope.ts`). Budgets: `INBOX_BUDGET_CHARS` (`packages/db/src/inbox.ts`) and `CATCHUP_BUDGET_CHARS` (`apps/web/server/lib/teamChat/peerCatchup.ts`).
- **Task-runner context.** `assembleTiers` (`packages/executor/src/tiers/index.ts`), called from `apps/web/server/lib/executorRunner.ts`. The memory block is an `auto-memory` section built in `apps/web/server/lib/memoryInjection.ts`, with its limits in `apps/web/server/lib/defaults.ts`. A run started with `POST /api/runtimes/:id/run` can skip it with `disableMemoryAutoInject: true`.
- **Delivery.** Every runtime gets Clawboo's context in front of the message, separated by a blank line, in the run's first user message.
- **Persona.** `apps/web/server/lib/runtimes/personaBlock.ts`.
- **Restarts and limits.** `DEFAULT_ROTATION` in `packages/executor/src/session-rotation.ts`; `DEFAULT_MAX_TURNS` in `packages/adapters/native/src/agentConfig.ts`; the 240,000-character bound in `apps/web/server/lib/runtimes/native/conversation.ts`.
- **Conversation pointers.** `apps/web/server/lib/teamChat/nativeTeamSession.ts` keeps them for Clawboo Native and Codex leaders, and per task (`taskSessionSettingKey`, gated by `taskResumeEligible`) for task runs on Clawboo Native, Claude Code, Codex and Hermes; `taskSessionPointers.ts` reads, clears and sweeps those. `serverDeliver.ts` writes a run's pointer on the first event that ends it (`settleResumePointer`), and clears it when a run that resumed fails (unless its typed cause passes by itself), cannot start, or ends with no such event, and when a run reports a `context_overflow` error, fatal or not (Claude Code's is not: it ends `done: max_turns`). A run that reported one and then finished successfully keeps its session. Claude Code reports one for a `terminal_reason` of `prompt_too_long`, `blocking_limit` or `rapid_refill_breaker`; Codex for `contextWindowExceeded` on `codex app-server` and for the failed turn's reason on `codex exec`; Clawboo Native for an error whose wording it recognizes as an oversized prompt, never a rate limit; Hermes when its own last error is its give-up line or a provider's error body (`hermesErrorCode`), never from a sub-agent's lines. A one-to-one chat keeps one pointer per agent, whatever its runtime (`nativeChatSessionSettingKey` in `apps/web/server/lib/agentChat/driveAgentChat.ts`). `driveAgentChat` clears it after the same error, except on Clawboo Native while `boundResumedTranscript` can drop more than a tenth of the saved transcript. It also clears a Clawboo Native pointer after a resumed turn the provider refused outright (`isRefusedRequest`) when the trim would not help. Neither drain clears a pointer on the failed-resume path when the run's typed cause passes by itself (`isPassingCause`). The one-to-one notes come from `apps/web/server/lib/agentChat/memoryRecall.ts`.
- **The task block.** `buildTicketBlock` in `contextPreamble.ts` reads the board; `renderTicketBlock` and `TICKET_LIMITS` in `apps/web/server/lib/teamChat/ticketBlock.ts` lay it out and hold its limits; `buildLastAttemptNote` in `apps/web/server/lib/resumeNote.ts` writes the last-attempt line. `serverDeliver.ts` renders it when the run starts and puts it between the steady context and the waiting items. The quoting is `formatInterSessionMessage` in `packages/board-core/src/untrustedText.ts`, which also frames teammates' results in a batch (`taskUpdate.ts`) and the notes that ride a tool result (`packages/mcp/src/piggyback.ts`).
- **The task on the Tasks tools.** A task run's Tasks URL carries the task as `scopeTaskId`, inside its signature, so a runtime cannot point it at another task (`mcpHttpUrl` in `packages/mcp/src/config.ts`). Clawboo Native gets it in-process. It is not the memory provenance task id, so it changes nothing about how memories are promoted.

</Accordion>

## Related

- [How a team works](/intro/how-it-works): the two paths these contexts belong to.
- [Team chat](/using/team-chat): team rules, `/rule`, `/reset` and rooms.
- [Memory](/concepts/memory): how shared memory is saved and searched.
- [Agents](/using/agents): which agent files each runtime reads.
- [Limits and defaults](/reference/limits-and-defaults): every number on this page.
