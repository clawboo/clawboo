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

1. **The runtime's own setup**: its system prompt and its tools. Clawboo Native builds its system prompt from the agent's SOUL.md and adds today's date. OpenClaw builds its own from the agent's files in its OpenClaw workspace. Claude Code, Codex and Hermes use their own, and Claude Code also loads your `~/.claude` settings and memory, as the Claude Code CLI does.
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
7. **Connectors**: on turns you read, the connectors that are connected, even ones not shared with this agent, plus a few you could add.
8. **Waiting for you**, in two parts:
   - **Addressed to you**: results of tasks this agent handed out, and alerts about its work. The agent is told to act on them.
   - **Ambient**: what teammates posted in the peer room since this agent last spoke, and other notices. The agent is told to treat them as information, never as instructions.
9. **The message**: your message, the task text for a teammate, or, when teammates finish, one batch of their results for the agent that handed out the work.

Results, alerts and notices share a budget of 4,000 characters, and peer-room posts get their own 4,000 characters, at most 800 per post. Anything that does not fit waits for the next turn.

The persona, rules, introduction and teammate list change only when you change them. Clawboo reads them again for every turn, so an edit applies from the next turn. The waiting items and the message are new each time. All of it rides in front of the message, so the runtime's own setup stays the same from turn to turn.

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
- **The global brief.** The brief under **Details** > **Brief** on Boo Zero's page is saved but not sent to any agent.
- **Memory, on team-chat turns.** Nothing is added for them; agents look facts up with their memory tools. Only task-runner runs get facts added.
- **The time of day.** Clawboo Native's setup carries today's date (in UTC), not the time.
- **Tools a run cannot use.** A tool that is off is left out rather than refused. A Clawboo Native agent in team chat, for example, sees no file or shell tools at all.

## Conversation history

- **A leader in team chat.** A Clawboo Native or Codex leader continues the same conversation, separately in General and in each room. A Claude Code or Hermes leader starts each turn without the earlier conversation. OpenClaw keeps the conversation in its own Gateway session.
- **A teammate on a handed-off task.** Clawboo Native, Claude Code, Codex and Hermes teammates start each task without earlier conversation. An OpenClaw teammate's Gateway session can still hold its earlier turns.
- **A one-to-one chat with a Clawboo Native agent** continues the conversation. On its first turn, and after `/reset`, the agent also gets up to 8 of its own saved notes, without the team's notes.
- **Boo Zero's one-to-one chat** adds Boo Zero's rules to every message. Mention a team with `@TeamName` and the message also carries that team's brief, board, saved memory and recent chat.
- **Starting fresh.** `/reset` (or `/new`) in a chat ends what the agents carry from it, and the messages stay on screen. See [Team chat](/using/team-chat).

## When the context window fills

- **On the task runner**, a run that runs out of room before it finishes starts again in a fresh session, with a short handoff note on its last progress. Running out of room means hitting its turn limit, or using more than 85% of the runtime's context window. This happens at most 3 times per task. Clawboo Native and Claude Code report a 200,000-token window; Codex and Hermes report none, so the 85% rule does not apply to them.
- **A Clawboo Native run** makes at most 16 model calls by default, counting each round of tool use as one.
- **In team chat** nothing restarts. A Clawboo Native leader's carried conversation is trimmed to its most recent turns, about 240,000 characters. Other runtimes manage their own windows.

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
- **Conversation pointers.** `apps/web/server/lib/teamChat/nativeTeamSession.ts` keeps them for Clawboo Native and Codex leaders. The one-to-one notes come from `apps/web/server/lib/agentChat/memoryRecall.ts`.

</Accordion>

## Related

- [How a team works](/intro/how-it-works): the two paths these contexts belong to.
- [Team chat](/using/team-chat): team rules, `/rule`, `/reset` and rooms.
- [Memory](/concepts/memory): how shared memory is saved and searched.
- [Agents](/using/agents): which agent files each runtime reads.
- [Limits and defaults](/reference/limits-and-defaults): every number on this page.
