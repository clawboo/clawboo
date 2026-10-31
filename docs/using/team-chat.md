---
title: 'Work with your team in chat'
sidebarTitle: 'Team chat'
description: 'Give a whole team work in General or a room: send a message, aim it at one agent with @, stop it, start fresh, and follow its tasks beside the chat.'
icon: 'messages-square'
keywords:
  [
    'group chat',
    'General',
    'Main Room',
    'rooms',
    'Know Your Team',
    'Meet your team',
    'team space',
    'Clear chat',
    '/reset',
    '/new',
    'Stop',
    'Tasks card',
  ]
---

Team chat is where you give a whole team work. Each team has one main chat, **General**, and can have **rooms**: separate chats with some of its members. You write one message. Boo Zero, your team leader, decides who does what, and each piece of work shows up as a task you can follow beside the chat.

Use this page to open a chat, send work, aim a message at one agent, stop work, start a conversation over, and organize rooms. What happens between your message and the answer is explained in [How a team works](/intro/how-it-works).

![A team's General chat: teammates' messages and two task cards on the left, and the Team graph and Tasks cards stacked on the right](/images/team-space.png)

## Before you begin

- A team with at least one agent. See [Teams](/using/teams) to create one.
- Each agent's runtime set up. Clawboo Native needs a provider (an API key or a local Ollama), OpenClaw agents need the OpenClaw Gateway, and Claude Code, Codex and Hermes need their own setup. See [Providers and runtimes](/using/providers-and-runtimes).

## Open a team's chat

<Steps>

<Step title="Pick the team">

Click the team's icon in the narrow rail at the far left. The team's Home page opens, and the sidebar lists the team's agents and then its chats.

</Step>

<Step title="Open General or a room">

Click **General**, listed as **General (Main Room)**, or a room's name. General is always first, right under **New room**.

</Step>

<Step title="Meet your team (first visit only)">

The first time you open a chat of a new team, Clawboo introduces the team before the chat opens. See [Meet your team](#meet-your-team).

</Step>

</Steps>

You should see the chat on the left and its cards on the right. The team graph and **Tasks** cards start open.

## Meet your team

The first visit to a team's chat shows a short introduction instead of the chat. It runs once per team.

<Steps>

<Step title="Meet the team">

A **Meet your team** card shows the team's agents and says the team is led by Boo Zero. Click **Get Started**. The button stays disabled while the team has no agents.

</Step>

<Step title="Introduce yourself">

Write a few words about who you are and what you are working on (at least 5 characters). Click **Continue to Team Space**.

</Step>

</Steps>

You should see a **Welcome aboard! Your team is ready.** notice, a short welcome from Boo Zero, and the chat with its cards. The welcome is a fixed greeting shown once on this screen, not a reply from a model, so it is gone after a reload.

Your introduction is saved with the team. The agent that answers you in any of the team's chats receives it with your message, so it knows who you are from the first message. Clawboo also adds it to each team member's SOUL.md file under an **About the User** heading, where you can edit it (see [Agents](/using/agents)).

You do not see this introduction again for the same team, and its rooms open straight to their chat. A team whose General chat already has messages, for example from a team routine, also opens straight to the chat.

## Send a message

Type in the box at the bottom of the chat and press **Enter**. **Shift+Enter** starts a new line. The box reads "Message General… (@name to target)" in General, and names the room in a room.

Who answers depends on how the message starts:

| Your message                            | Who gets it                                                                |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Starts with `@` and an agent's name     | That agent                                                                 |
| Anything else                           | Boo Zero, your team leader                                                 |
| Anything else, and there is no Boo Zero | The team's Leader if it is in this chat, otherwise the chat's first member |

The team's Leader is the optional member that carries the **Leader** badge (see [Teams](/using/teams)). A few rules decide whether an `@` mention counts:

- Only a mention at the very start of the message picks the agent. A mention later in the message is plain text.
- Names match whatever their capitals, and the longest matching name wins. The name must be followed by a space or end the message.
- In a room, only the room's members and Boo Zero can be mentioned. A message to anyone else goes to the leader instead.
- The agent receives your message exactly as you typed it, mention included.

Typing `@` opens a list of names to pick from. The **Tag** row under the conversation inserts a mention when you click a name.

Two commands are handled by Clawboo instead of being sent to an agent:

- `/reset` (or `/new`) starts the conversation fresh. See [Start a conversation fresh](#start-a-conversation-fresh).
- `/rule` followed by a space and some text saves a lasting rule for the whole team. Rules are covered in [Teams](/using/teams).

## What happens next

Boo Zero reads your message and either answers it or hands parts of the work to teammates. Each handoff becomes a task on the team's [board](/using/board). A card for it appears in the conversation and in the **Tasks** card, and both update as the work moves. Teammates work at the same time. When their results are in, the leader writes one answer that pulls them together.

![Boo Zero's answer in a team's General chat, combining three teammates' work, with the Team graph and Tasks cards beside it](/images/leader-synthesis.png)

- The work runs on the Clawboo server, not in your browser. Closing the tab does not stop it, and the chat catches up when you come back.
- A leader hands out at most 8 tasks in one turn. Numbers like this are listed in [Limits and defaults](/reference/limits-and-defaults).
- A teammate can hand off part of its own task. If it has finished its task by the time those results come back, its follow-up goes on its task's card as a comment, not into the chat.
- What each agent is told on every turn is described in [What an agent sees](/concepts/agent-context).
- An image in an agent's reply shows as a link named after its alt text, such as **Image: sales chart**. It never loads on its own and opens in a new tab only when you click it.

### Handoffs that need your approval

A handoff whose text mentions a risky action waits for you before it starts. The check matches whole words, in any letter case: delete, destroy, deploy, publish, release, secret, credential, prod or production, the phrases drop table and rm -rf, and api_key, api-key, apikey, force-push, force_push or forcepush. Other forms such as "deleted", "secrets", "API key" or "force push" written with a space do not trigger it. The request appears under **Needs you** in the **Tasks** card and on the board. If you deny it, or nobody answers within 5 minutes, the handoff is skipped and the leader is told. See [Approvals](/using/approvals).

### Task cards in the conversation

Each task card shows the task, the agent on it, and a status: **Queued**, **Working**, **Verifying**, **Done** or **Cancelled**. A task that waits on you shows why instead, for example **Failed**, **Stopped** or **Unassigned**, with **Resolve on board**. A finished card shows the agent's report, and a failed one shows the reason.

- **Comments & activity** at the foot of a card opens its comments and its live activity inside the card.
- The expand icon opens the task on the [board](/using/board) with its details open.
- After you [clear a chat](#start-a-conversation-fresh), cards from before the clear leave the conversation. The tasks stay on the board.

## Stop the work

While agents in this chat are working, the send button turns into **Stop**. Pressing it:

- ends every run in this chat, and drops replies and handoffs that were still waiting to start;
- sends the chat's tasks back to **To do**, where they wait under **Needs you** as **Stopped**;
- leaves the team's other chats running.

A stopped task never restarts by itself. To run it again, press **Retry** on the board, or open it in the **Tasks** card and send a comment: a comment on a stopped task starts its agent on it again.

## Start a conversation fresh

There are two ways to start over, and they keep different things:

|                                       | `/reset` (or `/new`)                                            | **Clear chat**                                                         |
| ------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| How                                   | Type it in the message box and send it                          | **...** menu on the chat's row in the sidebar, then confirm            |
| Messages                              | Stay on screen. A divider marks where the fresh start is        | Leave the chat, which starts over from its welcome. Nothing is deleted |
| Task cards in the conversation        | Stay                                                            | Cards from before the clear leave the conversation                     |
| Tasks                                 | Stay on the board and in the **Tasks** card                     | Stay on the board and in the **Tasks** card                            |
| What the agents carry                 | Each agent's next reply starts without the earlier conversation | The same                                                               |
| Team rules, your introduction, memory | Kept                                                            | Kept                                                                   |
| The team's other chats                | Not touched                                                     | Not touched                                                            |

Use `/reset` when you want the agents to let go of a long thread but keep it readable. Use **Clear chat** when you want an empty chat. Neither one stops work that is running: use **Stop** for that.

OpenClaw agents keep their conversation inside the OpenClaw Gateway, so both actions send them `/reset` through the dashboard's connection to the Gateway. If the dashboard is not connected to the Gateway at that moment, an OpenClaw agent keeps its conversation. Reconnect and send `/reset` in the chat again. `/reset` also works in an agent's own chat; see [Agents](/using/agents).

<Accordion title="Under the hood: what each action changes">

- **Clear chat** renames the chat's stored messages with a `#cleared:<time>` suffix, so nothing reads them any more. It deletes nothing.
- Both actions drop the conversation that Clawboo keeps for Clawboo Native and Codex agents in this chat, so their next turn starts a new session. Both send `/reset` to OpenClaw agents.
- `/reset` writes one divider into the conversation, which stays after a reload.

</Accordion>

## Rooms

A room is a separate chat inside a team, with some of its members. Use one to keep a side project's conversation and tasks apart from General.

A room has its own conversation, its own task cards and its own graph card (**Room graph**), which draws only its members. Boo Zero leads every room the way it leads General, though it is never listed as a member. The team's rules, brief, memory and board are shared by all of its chats.

### Create a room

<Steps>

<Step title="Start a room">

Click **New room** at the top of the team's chats in the sidebar.

</Step>

<Step title="Name it and pick members">

Enter a **Name** (up to 80 characters) and choose at least one member. Boo Zero is not offered, because it is in every room already.

</Step>

<Step title="Create it">

Click **Create room**. The room's chat opens with a "Welcome to" greeting and the room's name.

</Step>

</Steps>

### Talk in a room

A room works like General, with three differences:

- An `@` mention reaches only the room's members and Boo Zero.
- With no mention, a message goes to Boo Zero, else to the team's Leader if it is in the room, else to the room's first member.
- Agents in a room see only the room's members as teammates, so they hand work only to them.

### Manage rooms

Point at a chat's row in the sidebar and open its **...** menu:

| Action              | What it does                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Pin** / **Unpin** | Pinned rooms sit right under General, most recently pinned first. The rest follow, newest first |
| **Rename**          | Edit the name in place. **Enter** or clicking away saves it, **Escape** cancels                 |
| **Clear chat**      | See [Start a conversation fresh](#start-a-conversation-fresh)                                   |
| **Delete**          | Asks first, then archives the room                                                              |

General's menu has only **Clear chat**: General cannot be renamed, unpinned or deleted.

To change a room's members, click the members' faces in the room's header (**Edit room members**). The dialog renames the room, changes its members, or deletes it. A member you remove finishes the turn it is taking, and the room's later turns go only to the members who remain.

Deleting a room keeps its conversation, but the room leaves the sidebar and its running work stops. Its tasks stay on the board, where **Retry** or **Assign** runs them from General. If you were in the room, you land in General.

## The cards beside the chat

The header above the chat shows the team's icon, the chat's name and its members. The gear opens the team's brief and rules, which are covered in [Teams](/using/teams). Next come the toggles for the four cards, which stack beside the chat in this order:

| Card                                      | What it shows                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| **Browser**                               | The page each agent in this chat has open in its browser                             |
| **Team graph** (**Room graph** in a room) | The chat's agents and how work flows between them. See [Org chart](/using/org-chart) |
| **Tasks**                                 | This chat's tasks, grouped by what they need                                         |
| **Activity**                              | Live tool calls, results and errors from the whole team's runs, in a room too        |

The **Team graph** and **Tasks** cards start open. Show or hide a card with its toggle in the header, or close it with its own close button. **Maximize** in a card's header fills the view with that card until you press **Restore**. Drag the gap between the chat and the cards, or between two cards, to resize them. Your browser remembers which cards are open and how big they are. With every card closed, the chat takes the full width.

### The Tasks card

**Tasks** lists this chat's tasks in five sections, newest first: **Needs you**, **In progress**, **To do**, **Done** and **Cancelled**. The last two start folded. General lists the tasks handed out in General, and a room lists only its own. The [board](/using/board) shows them all.

**Needs you** always shows. It holds approvals waiting on you, which you answer right there. It also holds tasks that will not move until you act: failed, timed out, stopped, needing review, blocked, unassigned or not started. The board's [Needs you](/using/board#things-that-need-you) column uses the same rule.

Click a task to open it inside the card. It shows the task's description, status, agent, runtime and cost. Below come its **Output** once it is done (or its **Latest report**, when it has one), its **Progress** as live activity, and its **Comments**. Click **Tasks** in the card's title, or press **Escape**, to go back to the list. **Open on Board**, the kanban icon in the card's header, opens the task on the board.

The box at the bottom of an open task, **Comment or steer this task…**, passes your comment to the agent the task belongs to. The line beside **Send** says what sending does for that task, for example that the agent gets it before its next step, or that sending starts the agent on it again. Once you send, a note under your comment says where it went. A task that waits on you, or waits in **To do**, starts again for your comment. A finished task cannot, so the note offers **Send as a follow-up task**, a new task for the same agent with your comment as its brief. How this works for each kind of task is in [Steer a running task](/using/board#steer-a-running-task).

### The Browser card

The faces along the top of the **Browser** window are the agents in this chat. A small dot marks an agent with a page to show; click a face to see that agent's screen. Screens show for Clawboo Native agents, which browse through Clawboo. Agents on other runtimes browse with their own tools, so the card says their screen is not visible here. With nothing to show, the card says why: the agent has not opened a page yet, or has no browser granted.

## Arrange the sidebar

The sidebar on the left holds the team rail, the team's agents and chats, and the main navigation.

- Drag the sidebar's right edge to make it wider or narrower. Double-click the edge to reset its width.
- Drag the edge far to the left, click **Collapse sidebar**, or press `Cmd+\` (`Ctrl+\` on Windows and Linux) to hide it.
- While it is hidden, **Expand sidebar** sits at the start of the page's header. Point at it to show the sidebar over the page, or click it to bring the sidebar back.

Other shortcuts are listed in [Keyboard shortcuts](/reference/keyboard-shortcuts).

## Troubleshooting

<AccordionGroup>

<Accordion title="An agent does not reply">

When a reply fails before any text arrives, the chat shows a notice with the reason. For example, it says when the runtime has no provider key connected and where to connect one. Check that the agent's runtime is set up in **Settings > Runtimes** (see [Providers and runtimes](/using/providers-and-runtimes)). An OpenClaw agent also needs Clawboo connected to its OpenClaw Gateway. More fixes are in [Troubleshooting](/help/troubleshooting).

</Accordion>

<Accordion title="The message box is greyed out">

The box works when the chat has at least one agent and nothing is running. In a room, check that the room still has members on the team. While agents work, **Stop** replaces the send button: press it, or wait for the work to finish. Sending does not depend on the dashboard's connection to the OpenClaw Gateway, because the Clawboo server runs the work.

</Accordion>

<Accordion title="My @ mention went to the leader instead">

A mention picks the agent only at the very start of the message, and the name must be followed by a space. In a room, agents outside the room cannot be mentioned: add them with **Edit room members**, or talk to them in General.

</Accordion>

<Accordion title="The top of the conversation is missing">

The chat shows its most recent 150 items. **Load earlier messages** at the top adds 100 at a time without moving your place. If the chat was cleared, the messages from before the clear are set aside and do not come back into view.

</Accordion>

<Accordion title="An OpenClaw agent still remembers the old conversation">

`/reset` and **Clear chat** reach OpenClaw agents through the dashboard's connection to the OpenClaw Gateway. Reconnect to the Gateway, then send `/reset` in the chat.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- `POST /api/teams/:id/chat` accepts a message and answers `202` at once, and the server runs the work. `GET /api/teams/:id/chat/stream` streams the chat as server-sent events. `POST /api/teams/:id/chat/stop` and `POST /api/teams/:id/chat/clear` stop and clear one chat. Each takes a `roomId` for a room. Full shapes are in the [Teams API](/reference/rest-api/teams).
- Each chat, General and every room, has its own engine on the server, which is why Stop and Clear chat touch only one chat.
- Agents also have a peer room that they post to with Clawboo's TeamChat tools. The dashboard does not show it. See [Peer chat](/concepts/peer-chat).

</Accordion>

## Next steps

- [Track work on the board](/using/board): act on Needs you, steer a running task, and review results.
- [Org chart](/using/org-chart): see how a team is wired and give agents skills and connectors.
- [Teams](/using/teams): set the team's brief and rules.
- [How a team works](/intro/how-it-works): what happens between your message and the answer.
- [Approvals](/using/approvals): answer the requests agents send you.
