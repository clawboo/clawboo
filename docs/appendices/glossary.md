---
title: 'Glossary'
description: 'Plain definitions of the words in Clawboo and its docs, from A to Z, and the names the app uses today next to older names you may still see.'
keywords:
  [
    'glossary',
    'terms',
    'definitions',
    'Atlas',
    'Ghost Graph',
    'Scheduler',
    'Group Chat',
    'team space',
    'Know Your Team',
    'kill-switch',
    'Cost dashboard',
    'Needs approval',
    'native runtime',
  ]
---

Plain definitions of the words you meet in Clawboo and in these docs, from A to Z. Each entry links to the page that explains it. If you saw a name somewhere else, such as Atlas or Ghost Graph, look it up in [Names in the app](#names-in-the-app). Terms for contributors, with their code names, are under [For developers](#for-developers).

## Terms

### A

**Access token**: an optional secret that guards the dashboard and Clawboo's API. Without one, anything that can reach the server can use it. With one, each browser presents the token once before it gets in. Set one before you open Clawboo to other computers. See [Security model](/operating/security).

**Agent**: an AI worker on one of your teams. Each agent runs on one runtime and one model, follows its own instruction files, and appears in the dashboard as a Boo. See [Agents](/using/agents).

**Agent files**: the instruction files an agent keeps, edited under **Details** > **Agent Files** on its page. SOUL.md holds its personality and instructions, and AGENTS.md lists the teammates it hands work to. What each file does depends on the runtime. See [Agents](/using/agents).

**Approval**: a request that waits for your yes before it goes ahead: a shell command from a Clawboo Native or OpenClaw agent, a connector call that needs a yes, or a risky hand-off in team chat. Approvals appear in **Needs you** on the Board and in the chat where the agent works. See [Approvals](/using/approvals).

### B

**Board**: every task in one place, by status and by day. Its first column, **Needs you**, holds what waits on you. See [Board](/using/board).

**Boo**: how the dashboard draws an agent: a small mascot with a badge for the agent's runtime. Buttons such as **Create Boo** use the word too. See [Agents](/using/agents).

**Boo Zero**: your team leader. One agent leads the chats of every team: it answers messages that @mention no one, and hands work to teammates. Clawboo creates it on Clawboo Native once you have a Clawboo Native agent on a team and a connected provider; otherwise it uses your OpenClaw Gateway's default agent. See [Boo Zero](/using/boo-zero).

**Brief**: a team's short description, edited together with its rules. Boo Zero reads it only when you start a message in Boo Zero's own chat with @ and the team's name, and then only its first 900 characters. Boo Zero's page also has a **Global Brief**, which Clawboo saves but does not use yet. See [Teams](/using/teams) and [Boo Zero](/using/boo-zero).

**Budget**: a dollar limit on one agent, team or mission. In **warn only** mode, the default, Clawboo counts spend and warns you as the budget fills. In **hard cap** mode, which you opt into, it also pauses work at 100%: new runs are refused, though a run already going may finish first. No budget exists until you create one. See [Budgets and spend](/using/budgets-and-spend).

### C

**Capabilities**: the skills, tools and connectors your agents can use. **Settings** > **Capabilities** lists them all, with what each one needs. See [Capabilities](/using/capabilities).

**Circuit breaker**: an automatic stop for a task-runner run that is going nowhere, such as one that repeats the same failing call. See [Budgets and guardrails](/concepts/governance).

**Claude Code**: Anthropic's coding agent, one of the runtimes Clawboo can run agents on. It needs an Anthropic API key. See [Claude Code](/runtimes/claude-code).

**Clawboo Native**: Clawboo's built-in runtime, with nothing to install. It runs agents on an API key from one of ten providers (Anthropic, OpenAI, OpenRouter, Google, xAI, Groq, Mistral, Together, Cerebras or Moonshot), or on a local Ollama with no key. See [Clawboo Native](/runtimes/native).

**Clear chat**: empties one chat (General or a room) and starts that conversation fresh for its agents. Clawboo sets the messages aside rather than deleting them, and the chat's tasks stay on the Board. See [Team chat](/using/team-chat).

**Codex**: OpenAI's coding agent, one of the runtimes Clawboo can run agents on. You connect it with **Sign in with ChatGPT**, not an API key. See [Codex](/runtimes/codex).

**Connector**: a link to an outside app or tool, such as GitHub, Gmail, a folder or a web browser, that agents use through Clawboo. Connecting one gives no agent access until you share it with that agent on the graph. The two browser connectors are the exception: every new agent gets them. See [Connectors](/using/connectors).

**Cost estimate**: a cost Clawboo works out itself when a runtime reports none, marked **est.** on task cards. Models Clawboo has no price for are estimated at a default rate. A model your own Ollama serves is not estimated: it costs nothing, so its runs read **free**. See [Budgets and spend](/using/budgets-and-spend).

### D

**Delegation**: an agent handing part of its work to a teammate, also called a hand-off. Each hand-off becomes a task on the Board. See [How a team works](/intro/how-it-works).

**Device pairing**: OpenClaw makes you approve each new device before it can connect to the OpenClaw Gateway. Clawboo shows an **Approve this device** card that does it for you. See [OpenClaw](/runtimes/openclaw).

### F

**Fleet**: **Settings** > **Insights** > **Fleet**: all your agents at a glance, with recent task and check results, spend, and health per runtime. See [Tour the dashboard](/getting-started/dashboard-tour).

### G

**General**: a team's main chat, with every member, listed as **General (Main Room)**. You can clear it, but not rename or delete it. See [Team chat](/using/team-chat).

**Governance**: **Settings** > **Insights** > **Governance**: budgets, limits, the approval queue and the audit log. See [Budgets and guardrails](/concepts/governance).

### H

**Hermes**: an open-source agent, published as the `hermes-agent` Python package, and one of the runtimes Clawboo can run agents on. It keeps its own memory and skills between runs. See [Hermes](/runtimes/hermes).

**Home**: a team's own page, opened from the team's icon on the team rail. It is a placeholder for the team's dashboards and its agents' work; to work with the team, open **General**. See [Tour the dashboard](/getting-started/dashboard-tour).

### L

**Leader**: a badge Clawboo gives the team member whose name or role reads as a lead when you deploy a team template. Boo Zero still leads the team. The Leader leads the team's chats only when your install has no Boo Zero. See [Teams](/using/teams).

### M

**Marketplace**: ready-made agents, teams and skills that you deploy with a click. Clawboo downloads the full catalog from GitHub; offline, it shows a built-in set of 5 teams and 15 agents. See [Marketplace](/using/marketplace).

**MCP**: the Model Context Protocol, an open standard for giving AI agents tools from another program. Agents reach Clawboo's board, memory and tools through Clawboo's own MCP servers, and most connectors are MCP servers too. See [MCP servers](/operating/mcp-servers).

**Meet your team**: the introduction a team's chat shows on your first visit: the team's agents, then a few words from you about who you are. The agent that answers you in any of the team's chats receives your introduction with your message. See [Team chat](/using/team-chat).

**Memory**: the facts your agents save and share, shown in the sidebar's **Memory** view as a graph and a list. An agent on a team reads its team's facts and the global ones. See [Memory](/using/memory).

**Mission**: a task together with every task handed off under it. A budget can cover one mission. See [Budgets and guardrails](/concepts/governance).

**Model**: the AI model an agent runs on, such as a Claude model, a GPT model or a local Ollama model. You pick a default, and you can change the model per agent. See [Connect providers and runtimes](/using/providers-and-runtimes).

### N

**Needs you**: the Board's first column. It holds approvals and every task that waits on a person: one that failed, timed out, was stopped, is blocked, has no agent, needs review, or never started. See [Board](/using/board).

### O

**Ollama**: a free program that runs AI models on your own computer. Clawboo Native can run agents on it with no API key. See [Connect providers and runtimes](/using/providers-and-runtimes).

**OpenClaw**: an open-source agent runtime that runs its own Gateway on your computer. Clawboo can run agents on it next to its other runtimes. See [OpenClaw](/runtimes/openclaw).

**OpenClaw Gateway**: the program OpenClaw runs on your computer. Clawboo connects to it to create, run and chat with OpenClaw agents. See [OpenClaw](/runtimes/openclaw).

**Org chart**: every agent on every team on one live chart, around Boo Zero. Open it from the sidebar or with `Cmd/Ctrl + 1`. See [Org chart and team graphs](/using/org-chart).

### P

**Peer chat**: the shared channel where teammates on different runtimes post updates to each other while they work. You do not see it in the dashboard; your chats with a team are General and its rooms. See [How agents talk to each other](/concepts/peer-chat).

**Permissions**: the **Permissions** section on an agent's page, under **Details**. On Clawboo Native it holds the switch that lets the agent ask to run shell commands. On OpenClaw it sets when the agent asks before running a command, and lists the commands it may run without asking. See [Command permissions](/using/command-permissions).

**Personality**: the presets and sliders on an agent's page that set its tone. Clawboo writes the result into the agent's SOUL.md. See [Agents](/using/agents).

**Provider**: the service that runs an AI model, such as Anthropic, OpenAI, OpenRouter or your own Ollama. You connect one with an API key or a sign-in. Clawboo is free; the provider bills any usage. See [Connect providers and runtimes](/using/providers-and-runtimes).

### R

**Room**: a smaller chat inside a team, with some of its members. It has its own conversation, task cards and graph, while the team's rules, brief, memory and board stay team-wide. Boo Zero leads every room. Deleting a room archives it. See [Team chat](/using/team-chat).

**Route**: a line on the Org chart from one agent to another, meaning "this agent hands work to that one". It is a line in the first agent's AGENTS.md, and only OpenClaw agents follow it. See [Org chart and team graphs](/using/org-chart).

**Routine**: work that runs on a schedule. A team routine posts its instructions in the team's chat for Boo Zero; an agent routine gives one agent a task. See [Routines](/using/routines).

**Runtime**: the engine that runs an agent: Clawboo Native (built in), OpenClaw, Claude Code, Codex or Hermes. A team can mix runtimes. See [Choose a runtime](/runtimes/index).

### S

**Settings**: one window with three groups. **Workspace** holds Providers, Runtimes, Memory, Capabilities and Routines; **Insights** holds Fleet, Tokens Used, Observability and Governance; **System** holds System and System Health. Open it from the sidebar or with `Cmd/Ctrl + ,`. See [Tour the dashboard](/getting-started/dashboard-tour).

**Share**: to give an agent a connector on the graph. Pull a thread off its Boo and pick the connector, or drop a connector tile onto the Boo. Dragging a tile from another agent's ring asks for **Read**, **Write** or **Admin** access. **Stop sharing** takes it back from one agent. See [Connectors](/using/connectors).

**Sign in with ChatGPT**: connects Codex to your ChatGPT plan instead of an API key. Hermes and OpenClaw can use the plan too, each with its own sign-in. Clawboo Native cannot. See [Connect providers and runtimes](/using/providers-and-runtimes).

**Skill**: a label for something an agent is good at, picked from the Marketplace's **Skills** tab or on the graph. It shows on the agent's ring and in the Capabilities panel, but gives the agent no new tool and does not change its instructions. Hermes agents also write skill files of their own, which Hermes reads. See [Capabilities](/using/capabilities).

**Standing permission**: a command an OpenClaw agent may run without asking again, recorded when you answer **Always** to its command approval. You see and remove them in the agent's **Permissions** section. See [Command permissions](/using/command-permissions).

**Steer**: to reply on a task while an agent is working on it, so the agent reads your reply during the run. A reply reaches the task's agent at any other status too: a waiting task starts again, and a finished one offers **Send as a follow-up task**. Reply from the Board's task drawer, a team chat's **Tasks** card or the agent's **Tasks & Routines** card. See [Steer a running task](/using/board#steer-a-running-task).

**System Health**: **Settings** > **System** > **System Health**: Clawboo's startup checks, with a way to run them again. See [System Health](/using/system-health).

### T

**Task**: one piece of work on the Board, usually with an agent, a status and comments. See [Board](/using/board).

**Task runner**: one of the two ways Clawboo runs agents. It runs agent routines on Clawboo Native, Claude Code, Codex and Hermes, and runs started through the API. Only the task runner gives a run that names a git repository its own worktree, checks finished work, and stops runs that go nowhere. Most work runs in team chat instead. See [How a team works](/intro/how-it-works).

**Tasks card**: the card beside a team chat that sorts the chat's tasks into **Needs you**, **In progress**, **To do**, **Done** and **Cancelled**. Open a task there to read its comments, steer it, or open it on the Board. An agent's page has a **Tasks & Routines** card instead. See [Team chat](/using/team-chat).

**Team**: a group of agents that work together, with its own chats, rules, brief and memory. Deploy one from the Marketplace or build your own. See [Teams](/using/teams).

**Team chat**: a team's conversations: **General** and any rooms. When you send a message that @mentions no one, Boo Zero answers it or hands the work to a teammate. See [Team chat](/using/team-chat).

**Team graph**: the card beside a team's chat that draws the team, with each agent's live status. In a room it is the **Room graph**. See [Org chart and team graphs](/using/org-chart).

**Team rules**: short rules that every member of a team follows on every turn in that team's chats. Edit them with the team's brief, or add one with `/rule` in a chat. See [Teams](/using/teams).

**Tokens Used**: **Settings** > **Insights** > **Tokens Used**: recorded token use and cost by team and agent, for every runtime. See [Budgets and spend](/using/budgets-and-spend).

**Trace**: the record of one task-runner run, with its steps, tool calls and errors, shown in the **Observability** panel. See [Observability](/concepts/observability).

### V

**Vault**: Clawboo's encrypted store for the keys you connect, kept in your Clawboo folder. Keys you save under **Providers** are also copied, unencrypted, into OpenClaw's files. See [Where keys are stored](/using/providers-and-runtimes#where-keys-are-stored).

**Verification**: Clawboo's check on finished work. It runs the project's test command, and for bigger changes a second agent reviews the work. It runs only for task-runner runs that worked in their own git worktree and changed files, so most work is never checked. See [How work is checked](/concepts/verification).

### W

**Worktree**: a separate working copy of a git repository, on its own branch, where one task's file changes stay apart from other work. It is not a sandbox: the agent can still reach the rest of your computer. See [Worktrees and handoff](/concepts/worktrees-and-handoff).

## Names in the app

The dashboard's labels are the names these docs use. The right-hand column lists older or other names you may meet in earlier releases, older pages, or elsewhere.

| In the app                                                                        | What it is                                                | Older or other names                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| **Org chart**                                                                     | Every team on one chart, around Boo Zero                  | Atlas (the sidebar name up to 0.5.0), Ghost Graph                     |
| **Team graph**, **Room graph**                                                    | The graph card beside a team's chat, or beside a room     | Ghost Graph                                                           |
| **General**                                                                       | A team's main chat, shown as **General (Main Room)**      | Group Chat (the sidebar name up to 0.5.0), group chat                 |
| A team chat with its cards (**Browser**, **Team graph**, **Tasks**, **Activity**) | A team's working view                                     | team space                                                            |
| **Meet your team**                                                                | The one-time introduction before a team's chat opens      | Know Your Team gate                                                   |
| **Routines**                                                                      | Work that runs on a schedule, for a team or for one agent | Scheduler (before 0.4.0)                                              |
| **Needs you**                                                                     | The Board's first column                                  | Needs approval (before 0.4.0)                                         |
| **Tokens Used**                                                                   | Recorded token use and cost, for every runtime            | Cost dashboard; the welcome screen's **Cost** button opens it         |
| **warn only**, **hard cap**                                                       | The two budget modes                                      | kill-switch (for hard cap)                                            |
| **Clawboo Native**                                                                | The built-in runtime                                      | native runtime, native harness, `clawboo-native` (its id)             |
| **OpenClaw Gateway**, **Gateway**                                                 | OpenClaw's own server on your computer                    | gateway                                                               |
| **Boo**                                                                           | An agent, as the dashboard draws it                       | agent                                                                 |
| **Boo Zero**                                                                      | Your team leader                                          | universal leader, team lead                                           |
| **Leader**                                                                        | The badge on a team's lead member                         | team lead                                                             |
| **Memory**                                                                        | Team memory as a graph and a list                         | Memory browser                                                        |
| **Capabilities**, **Governance**, **Observability**, **System Health**            | Panels in Settings                                        | Capabilities dashboard, Governance dashboard, Observability dashboard |
| **Fleet**                                                                         | **Settings** > **Insights** > **Fleet**                   | Fleet in the sidebar (up to 0.5.0)                                    |
| **System**                                                                        | **Settings** > **System** > **System**                    | System maintenance                                                    |

## For developers

<Accordion title="Code names and architecture terms">

| Term                                              | What it is                                                                                                                                                                | Read more                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `RuntimeAdapter`                                  | The interface every runtime implements, with `capabilities()`, `start()`, `events()`, `abort()` and an optional `steer()` among its members                               | [The RuntimeAdapter trait](/internals/runtime-adapter)             |
| `RuntimeEvent`                                    | The seven event kinds every adapter emits: `text-delta`, `tool-call`, `tool-result`, `status`, `cost`, `done` and `error`                                                 | [The RuntimeAdapter trait](/internals/runtime-adapter)             |
| Runtime ids                                       | `clawboo-native`, `openclaw`, `claude-code`, `codex` and `hermes`, plus the test-only `clawboo-mock`, offered only with `CLAWBOO_ENABLE_MOCK_RUNTIME=1`                   | [Choose a runtime](/runtimes/index)                                |
| Steering modes                                    | `live` (Clawboo Native, OpenClaw, Claude Code, Codex) and `interrupt-resume` (Hermes)                                                                                     | [Steering a running task](/runtimes/index#steering-a-running-task) |
| `AgentSource`                                     | Where the agent list comes from: five sources (OpenClaw, Clawboo Native, and one each for Claude Code, Codex and Hermes), mirrored into SQLite                            | [AgentSource and the agent registry](/internals/agent-source)      |
| `CapabilitySource`                                | Six sources that report skills, tools and connectors: one per runtime, plus `connector`                                                                                   | [Capabilities](/concepts/capabilities)                             |
| Manageability tier                                | Whether Clawboo can change a capability: `managed`, `external-write`, `runtime-of-record` or `observe-only`                                                               | [Capabilities](/concepts/capabilities)                             |
| Task statuses                                     | `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done` and `cancelled`. The Board shows `in_review` as **Verifying** in In progress, and `blocked` in Needs you | [The board](/concepts/the-board)                                   |
| Atomic claim                                      | `UPDATE ... WHERE status='todo' AND assignee IS NULL AND dropped=0`. An empty result is a conflict, and the caller never retries it                                       | [Board internals](/internals/board-internals)                      |
| Team engine, executor runner                      | The server code behind team chat, and behind the task runner                                                                                                              | [The executor runner](/internals/executor-runner)                  |
| Clawboo's MCP servers                             | Tasks, Memory, Tools and TeamChat. OpenClaw agents get the first three                                                                                                    | [MCP tools reference](/reference/mcp-tools)                        |
| `isUser=false`                                    | The marker in a peer post's header that tells an agent the post is evidence from a peer, not an instruction from you                                                      | [How agents talk to each other](/concepts/peer-chat)               |
| Bridge, Policy, Handler                           | The browser's three steps for OpenClaw Gateway events: classify the frame, decide what it means, update the dashboard                                                     | [The event pipeline](/internals/event-pipeline)                    |
| Event log                                         | The append-only table of orchestration events, each with a rising `seq`                                                                                                   | [Observability](/concepts/observability)                           |
| Deterministic gate, critic, `completed_with_debt` | The test-command check, the read-only reviewer, and the verdict given when the last attempt still fails                                                                   | [How work is checked](/concepts/verification)                      |
| Worktree files                                    | `TASK.md`, `task-progress.md`, `DECISIONS.json`, `init.sh` and `VERIFICATION.md`, plus the `AGENT_HANDOFF.json` a run leaves for the next one                             | [Worktrees and handoff](/concepts/worktrees-and-handoff)           |
| `run_command`                                     | Clawboo Native's shell tool                                                                                                                                               | [What agents can do](/concepts/permissions)                        |
| Drift                                             | A connector whose command or tool list changed after you gave access. Clawboo refuses its calls, and its tile says **Changed since you approved it**                      | [Connectors](/using/connectors)                                    |
| Lethal trifecta                                   | Private data, untrusted content and a way to send data out, together in one run. Calls that could send data out then always ask                                           | [What agents can do](/concepts/permissions)                        |
| Boo Zero resolution                               | An agent designated as Boo Zero, then a Clawboo Native Boo Zero, then the OpenClaw Gateway's default agent                                                                | [Boo Zero](/using/boo-zero)                                        |

</Accordion>

## Related

- [Tour the dashboard](/getting-started/dashboard-tour): where each of these things lives on screen.
- [Key concepts](/concepts/index): the ideas behind the terms, in reading order.
- [Known issues](/appendices/known-issues): what does not work yet, and what to do about it.
- [FAQ](/appendices/faq): short answers to common questions.
