---
title: '@clawboo/team-orchestration'
sidebarTitle: 'team-orchestration'
description: 'The team chat engine: how delegation signals become board tasks, the dependencies a host provides, session keys, turn origins, and the cascade contract.'
keywords:
  [
    '@clawboo/team-orchestration',
    'team-orchestration',
    'team engine',
    'createBoardOrchestrator',
    'delegation',
    'session keys',
    'TurnOrigin',
    'runCascadeContract',
    'nudge queue',
    'Task Update',
  ]
---

`@clawboo/team-orchestration` is the engine behind team chat. It watches each agent's run events, turns delegation
signals into board tasks, delivers each task to the agent it names, and reports results back to whoever delegated
them. It is pure and browser-safe: the board, delivery, narration and every other side effect arrive as injected
functions, so the same engine runs on the server against SQLite and in tests against an in-memory board.

Use this page when you change how a team delegates, reports back or recovers. The model is on
[How work is delegated](/concepts/delegation-and-orchestration), and how a message reaches the engine is on
[How a team works](/intro/how-it-works).

## How the server runs it

`apps/web/server/lib/teamChat/teamOrchestrator.ts` builds one long-lived engine per team chat room: the team's own
chat is its default room, and each extra room gets its own engine. Each engine is created with
`createBoardOrchestrator(deps)`, wired to the database through `serverBoardClient.ts` and to the runtimes through
`serverDeliver.ts`. The SPA uses only the helpers (session keys, the `[Task Update]` builder, control-token checks)
and talks to the server over REST and server-sent events.

| Dependency                                       | Required | What the host provides                                                         |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------ |
| `board`                                          | yes      | a `BoardClient` over the durable board                                         |
| `deliver`                                        | yes      | starts an agent's turn with a message and a turn origin                        |
| `teamId`, `known`, `leaderAgentId`               | yes      | the team, the room's roster and its lead                                       |
| `sessionKeyForAgent`, `agentIdForSession`        | yes      | the session-key mapping for this room                                          |
| `stopGen`                                        | yes      | the host's stop generation, so work delivered before a Stop starts nothing new |
| `isSessionBusy`, `isSessionOccupied`             | no       | whether an agent is mid-run, so a message waits instead of interrupting        |
| `onBoardChange`, `narrate`                       | no       | push board changes and engine notes (`reflect`, `alert`) to the dashboard      |
| `compact`                                        | no       | shrink tool output before it is quoted back                                    |
| `caps`, `onCapHit`                               | no       | the per-turn fan-out limit and a callback when it trips                        |
| `isRiskyDelegation`, `requestDelegationApproval` | no       | make a risky delegation wait for a person's approval                           |
| `abortSession`                                   | no       | stop a run when a person moves its card                                        |

<Warning>

`deliver` must not claim or complete the task. The engine owns the board lifecycle: it creates the task, claims it,
opens the execution row and then calls `deliver`, and it marks the task done itself. A `deliver` that claimed again
would lose to its own claim, and one that completed the task would complete it twice.

</Warning>

## The rules it enforces

- **Typed signals only.** `extractSignals` reads a `sessions_send` or `delegate` tool call (including TeamChat's
  `team_delegate`), or a `<delegate to="@Name">` or `<plan>` block in a finished turn. It never infers delegation
  from prose. The tag parsers tolerate a missing opening `<`, and stripping removes the whole tag from what the
  chat shows.
- **One task per session.** A session works one task at a time. A message for a busy session waits in the nudge
  queue (`createNudgeQueue`) and goes out at its next turn boundary. A queued message whose run never starts frees
  the session for the next one.
- **A refused delivery says why.** When `deliver` rejects, the engine fails the task at once instead of waiting for
  the watchdog. A host that decided not to start the run, such as the web server when a hard-cap budget is paused,
  rejects with a `DeliveryRefusedError`, and its message becomes the task's failure comment and what the delegator
  is told. Any other rejection is reported as a message the agent did not receive.
- **Bounded trees.** Delegation depth is capped by `MAX_SPAWN_DEPTH`, the same constant the board and the task
  runner use, and fan-out per turn by `caps.maxFanout`. A lost claim is never retried. After
  `MAX_DELEGATION_FAILURES` failures in a row of the same task by the same agent, the engine refuses to delegate it
  to that agent again and tells the delegator to handle it another way.
- **Silence fails a delegation.** `sweepStaleSessions` fails a delegated run that sends no event for
  `DELEGATION_IDLE_TIMEOUT_MS`, with longer allowances while a tool call is open or a run waits to start, and tells
  the delegator. The values are on [Limits and defaults](/reference/limits-and-defaults).
- **Results are batched.** Finished tasks are gathered for `REFLECT_WINDOW_MS` and delivered to the delegator as
  one `[Task Update]` (`buildTaskUpdateMessage`), which also names work still outstanding.
- **A person's move is final.** `personMovedTask` stops the run working on the card, closes its execution as
  cancelled, and tells the delegator when the person marked it done or cancelled it. A run that ends after that
  changes nothing. `markStopped` makes a Stop durable at once, so the ready-pump never re-fires stopped work.
- **A person can ask again.** `dispatchTask` runs one `todo` task now because a person asked, skipping the
  automatic fire policy. A person-assigned task reports on its card, not to the team's lead.

## Session keys

A team session key is `agent:<agentId>:team:<teamId>`, with `:room:<roomId>` appended for a room other than the
team's own chat. `buildTeamSessionKey(agentId, teamId, roomId?)` writes one, and `parseTeamSessionKey`,
`agentIdFromSessionKey`, `teamIdFromSessionKey` and `roomIdFromSessionKey` read one back; `isTeamSessionKey` is true
with or without a room. A person's 1:1 chat with a Clawboo Native agent uses `nativeChatSessionKey(agentId)`, which
is `agent:<agentId>:native`; the web server keys a Claude Code, Codex or Hermes agent's 1:1 chat
`agent:<agentId>:<runtime>`. Build and parse keys only through these helpers, so the room suffix stays readable.

## Turn origins

Whoever asks for a turn stamps it with a `TurnOrigin`, passed as `deliver`'s fourth argument, because the engine's
own view of a session goes stale as soon as a task completes.

| Origin       | Meaning                                                            | Reply shown in team chat                       |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------- |
| `human`      | a person typed into team chat                                      | yes                                            |
| `schedule`   | a routine posted into team chat for the person                     | yes                                            |
| `system`     | Clawboo itself, such as a batched `[Task Update]`                  | yes, unless it is a follow-up on a closed task |
| `delegation` | a teammate delegated this task (`fromAgentId` is who to report to) | no                                             |
| `assignment` | a person assigned this board task to the agent                     | no, the result goes on the card                |

`classifyTurn` turns an origin into the framing the prompt needs (worker, leader, user-facing), and `isChatVisible`
answers the last column. Never derive visibility from the framing: a person's @mention to a busy worker is framed as
a worker turn but still gets an answer in the chat.

## Other helpers

- `buildTurnEnvelope({ ambient, addressed })` frames waiting context in two parts: items addressed to this agent,
  first, and ambient evidence that carries no authority to change the task. Membership comes from where an item
  came from, never from its text.
- `shouldDropAssistantTurn` keeps control tokens (`RESUME_ACK_TOKEN`, `SKIP_ACK_TOKEN`) and short refusals out of
  the transcript.

## Test it

`@clawboo/team-orchestration/contract` exports `runCascadeContract(harness)`, the shared suite of cascade scenarios:
stop and release, the idle watchdog and its allowances, one task per session, reflect batching, the fan-out cap,
plan steps cancelled after a failed dependency, the loop breakers, claims never retried, the ready-pump's fire
policy, follow-ups on closed tasks, and work delivered before a Stop. It runs twice: against the package's
in-memory board (`pnpm --filter @clawboo/team-orchestration test`), and against the real server board client over
SQLite in `apps/web/server/lib/teamChat/__tests__/boardOrchestration.contract.test.ts`, so the fake and the real
board cannot drift apart. Add a scenario to `src/contract.ts` when you add a rule.

## Related

- [How work is delegated](/concepts/delegation-and-orchestration): how a team delegates and reports back.
- [@clawboo/board-core](/reference/packages/board-core): the task rules the engine dispatches by.
- [Board internals](/internals/board-internals): claims, heartbeats and reconciliation underneath the engine.
- [Work with your team in chat](/using/team-chat): rooms, General and the chat a person sees.
