---
title: 'Create and edit agents'
sidebarTitle: 'Agents'
description: 'Create an agent, open its page, change its model and personality, edit the files it follows on each runtime, and delete it.'
icon: 'bot'
keywords:
  [
    'Boo',
    'agent page',
    'Create Boo',
    'personality',
    'custom instructions',
    'SOUL.md',
    'IDENTITY.md',
    'AGENTS.md',
    'TOOLS.md',
    'agent files',
    'delete agent',
    'model',
  ]
---

Each agent in Clawboo appears as a Boo, a small mascot with its own name and color. Use this page to add an agent, open its page, change the model it runs on, tune how it sounds, edit the files it follows, and delete it.

## Create an agent

<Steps>

<Step title="Pick the team">

In the team rail, click the team the agent should join. With no team selected, the new agent belongs to no team.

</Step>

<Step title="Open Create Boo">

In the agent column, below the team's chats, click **Create Boo**.

</Step>

<Step title="Describe the agent">

Enter a **Name** and, if you like, a **Role**: a few sentences on what the agent does and how. The role becomes the start of the agent's SOUL.md. Leave it empty for a general helpful assistant.

</Step>

<Step title="Check the runtime and create">

The line under the fields says where the agent will run: **Runs on OpenClaw, through your Gateway.** or **Runs on Clawboo Native: no OpenClaw Gateway is connected.** Click **Create Boo**.

You should see the agent's Boo tile in the team's agent column.

</Step>

</Steps>

**Create Boo** needs no OpenClaw Gateway. It creates the agent on OpenClaw while Clawboo is connected to an OpenClaw Gateway, and on Clawboo Native otherwise. A Clawboo Native agent needs a connected provider (an API key or a local Ollama) to answer. To put an agent on Claude Code, Codex or Hermes, deploy it from the [Marketplace](/using/marketplace) or as part of a [team](/using/teams), and pick its runtime on the customize step.

### What a new agent starts with

- The **House Style** personality (see [Tune the personality](#tune-the-personality)).
- The browser connectors, Playwright and Chrome DevTools, with write access. An agent on any runtime but OpenClaw can open pages, click and fill in forms, and each such action asks you first. A few Playwright tools, such as running code in the page, need Admin access. See [Connectors](/using/connectors#every-agent-gets-a-browser).
- On OpenClaw: **Ask for Unknown** for commands, so it asks your approval before running a command that is not on its list. Clawboo sets this at the Gateway, and if the Gateway refuses the setting, the agent is not created.
- On Clawboo Native: no commands at all until you turn on **Let this Boo ask to run commands** (see [Permissions](#permissions)).

## Open an agent's page

- **From the sidebar:** click the agent's Boo tile in the agent column. To list every agent, right-click Boo Zero's mascot at the top of the team rail and choose **Show all agents**.
- **From the Org chart or a team graph:** right-click the agent's Boo, then **Open agent**.

[Boo Zero](/using/boo-zero) has its own way in: click its mascot at the top of the team rail.

![Ada's agent page: her chat on the left; on the right, the Graph card with her skills, connectors and the Claude Sonnet 5 model control, above the Details card open on Personality](/images/agent-detail.png)

The chat sits on the left and cards stack on the right. The buttons in the page header show or hide each card. Each card has **Maximize** and close buttons, and you can drag the gaps between the chat and the cards to resize them. A fresh install opens **Graph** and **Details**, and this browser remembers your layout.

| Card                 | What it shows                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Graph**            | The agent with its skills and connectors. Drag from the agent's port onto empty space, or use **+**, to add a skill or connector. The model control sits in the top-right corner. |
| **Tasks & Routines** | The agent's tasks in **Needs you**, **In progress**, **To do**, **Done** and **Cancelled**, then the routines that send it work, with **New routine**.                            |
| **Browser**          | What its browser shows, live, or on Linux its own screen, which you can take over. See [Watch a screen and take over](#watch-a-screen-and-take-over).                             |
| **Activity**         | The agent's tool calls, results and errors as they happen.                                                                                                                        |
| **Details**          | **Computer**, **Personality**, **Permissions**, **Brief** (Boo Zero only) and **Agent Files**.                                                                                    |

In **Tasks & Routines**, click a task to read its output and progress. The comment box at the bottom (**Comment or steer this task…**) sends your comment to the agent the task belongs to, and the line beside **Send** says what sending does. On a running task, the agent gets it during the run. A task that waits on you, or waits in **To do**, starts again for it. A finished task cannot run again, so the note under your comment offers **Send as a follow-up task** instead. Each comment you send shows where it went. See [Steer a running task](/using/board#steer-a-running-task) for every case. **Open on Board** opens the task on the board.

**Computer** under **Details** is a read-only view of the agent's files. It lists the agent's tasks by title, newest first: the git worktree of each board task the agent took that changes files in a repository, and, for a Claude Code, Codex, Hermes or Clawboo Native agent, the folder of each task it ran without a worktree. A task's folder is listed once it is on disk and either holds a file or its task is **In progress** or **In review**. The list looks at the agent's 200 most recent tasks without a worktree and shows at most 50 folders; an older task's files still show in its **Files** section on the Board. After the tasks comes the folder its other runs start in, as in team chat and in its own chat: **Team folder**, or **Shared folder (no team)** for an agent with no team. When there is more than one, pick it from the list at the top. Task folders and the team folder are not git checkouts, so their files carry no change badges or diffs. Until the agent's first run in team chat or its own chat, the team folder reads "No files yet." OpenClaw agents keep their files in the OpenClaw Gateway's workspace instead.

## Watch a screen and take over

The **Browser** card shows what the agent sees, live, while it has a browser open. With no browser open, it shows the last screenshot the agent took and says so.

- **On Linux**, each agent gets a screen of its own: a virtual display that its browser, and any Linux app it starts, opens on. Clawboo starts it when the agent's browser starts and stops it 30 seconds after the browser closes. It needs TigerVNC's `Xvnc` on the server; without it, agents' browsers run as before and the card shows the browser as on a Mac. The screen is Linux only.
  - **Install the desktop tools**, on an agent's **Screen** view, installs `Xvnc` and Cua Driver (the desktop driver) into Clawboo's own runtimes folder: TigerVNC's own Linux build 1.16.2 and Cua Driver 0.38.0, each checked against the SHA-256 Clawboo pins before it is unpacked. TigerVNC is free software under the GNU GPL version 2; Clawboo downloads it from TigerVNC's own release and runs it as a separate program, never as part of Clawboo. Cua Driver is MIT-licensed.
  - TigerVNC publishes its build for x86_64 only. On arm64, install TigerVNC's `Xvnc` with your package manager; once agents have a screen, **Install Cua Driver** on the same view adds the driver alone. It is offered only when agents run as their own OS user ([agent isolation](/operating/agent-isolation#set-it-up-on-linux)), which Cua Driver needs; without it, agents still get their screen, the live view and their browser tools. An `Xvnc` your distribution installed is always used first, and Clawboo then downloads no TigerVNC.
  - Clawboo's copy of TigerVNC needs some of the system's own libraries and its keyboard compiler (`xkbcomp`) with its keyboard data. On Debian and Ubuntu they are in the packages `libxcvt0`, `libxshmfence1`, `libgbm1`, `x11-xkb-utils` and `xkb-data`; other distributions name them differently. A machine with Chromium has most of them. Clawboo installs none of them. Installing `tigervnc-standalone-server` instead gives you your distribution's own `Xvnc`, which brings everything it needs and is then used in place of Clawboo's copy.
  - When a display cannot start, the **Screen** view names the missing file and, on Debian or Ubuntu, the package that holds it.
  - With Openbox installed, windows on the screen get frames and can be moved, maximized and closed; without it they have none. Clawboo runs Openbox with a configuration of its own that has no menu and no key that starts a program, and uses no other window manager.
  - With `at-spi2-core` (and D-Bus) installed, the desktop driver finds buttons and fields through each app's accessibility tree; without them it works from the pixels on the screen. Clawboo installs neither Openbox nor `at-spi2-core`.
- **On macOS and Windows**, the card shows the agent's browser about once a second. It is for watching only.

### Take over

On an agent's own screen (Linux), click **Take over** to use it yourself, for example to sign in to a site for the agent, answer a two-factor prompt, or get past a check meant for people. While you have control:

- your mouse and keys go to the agent's screen, and the screen shows a highlighted edge. The agent's own programs share that screen, so type a password there only for an agent you trust;
- the agent's own browser tools wait: each call tells it a person is using its computer and to wait or ask you in chat;
- the agent's browser is not closed for being idle.

Click **Hand back** when you are done. Control also goes back to the agent when you close the view (after 30 seconds, so a dropped connection can come back), or after 10 minutes without a key or a click from you. One person has control at a time; someone who takes over after you gets it, and your view says **A person has control**.

Whoever may use an agent can use what it holds. Taking over its screen means using its browser's saved sign-ins, and anything its OS user can reach, through a file dialog for example. So the access to decide is who may use each agent: everyone who can open your Clawboo can use every agent, and a link (below) gives someone one agent's screen. If someone should not use an agent's sign-ins, do not give them that agent.

### Share an agent's screen with a link

Below the screen, **View link** and **Control link** make a link to this one agent's screen for someone who has no way into your Clawboo, such as the person who must type their own password into a site the agent uses.

- A **view link** lets them watch. It can never take over.
- A **control link** also lets them take over and hand back, as above. It is offered only when agents run as their own OS user ([`CLAWBOO_AGENT_USER`](/operating/agent-isolation)): whoever takes over can reach what the agent's browser can on this computer, through a file dialog for example, which otherwise includes Clawboo's own files. Without it, **Control link** is turned off and says why; you can still take over yourself. With it, a control link holder can still reach what every agent can, because all agents share one user.
- A link reaches this agent's screen and nothing else, from wherever the rest of your Clawboo is reachable. If your Clawboo answers only on this machine, so does the link.
- It expires: a view link after 8 hours and a control link after 1 hour. **Revoke** ends one link, and **Revoke all** every link to this agent; either closes every view open through it at once and gives control back to the agent. Deleting or archiving the agent, or restarting Clawboo, ends them too, and a link never reaches a new agent made later under the same id.
- One link opens at most two views at once, and links leave two places on each agent's screen (and eight in all) for the dashboard, so links you hand out never lock you out. An agent has at most 20 links; revoke one to make another.
- The link is shown once, when you make it. Clawboo keeps only a fingerprint of it and never writes it to a log: the part after `#` is never sent to any server, and the link's page takes it out of the address bar as soon as it opens. The browser that opened it may still keep it in its history, so revoke a link when it is no longer needed.

## Chat with an agent

The chat on an agent's page is a one-to-one conversation with that agent. For a Clawboo Native, Claude Code, Codex or Hermes agent, the Clawboo server runs the chat, so it needs no OpenClaw Gateway. The reply appears as the agent writes it. An OpenClaw agent's chat goes through the OpenClaw Gateway, so it works while the Gateway is connected. Only [Boo Zero's own chat](/using/boo-zero#give-a-team-work-from-this-chat) can hand work to a team, and not on OpenClaw; a hand-off in any other agent's reply shows as a **Not handed off** note.

- The chat shows the latest 150 messages. **Load earlier messages** at the top brings in older ones.
- While the agent works, the send button turns into **Stop**, and it stays that way until the turn ends.
- The agent remembers the conversation from one message to the next. Claude Code, Codex and Hermes agents also get their SOUL.md with every message, as in team chat.
- On Clawboo Native, Claude Code, Codex and Hermes, the chat starts in the agent's team folder, `~/clawboo-work/teams/<team id>`, or `~/clawboo-work/teams/_no-team` for an agent on no team, such as Boo Zero. Claude Code, Codex and Hermes only start there: they can still read and change any file your user account can. A Clawboo Native agent can read and write files only inside that folder. With **Let this Boo ask to run commands** switched on, it can also ask to run a command there, and the request waits for your answer above the message box. See [What agents can do](/concepts/permissions).
- A turn that fails before the agent writes anything leaves a notice in the chat with the reason, such as a runtime with no key, or "the run went quiet for too long and was ended" when nothing happened for 30 minutes. A turn that fails partway keeps what the agent had written.
- A rate limit or an overload does not cost the agent the conversation: the next message carries on from it. A conversation can outgrow the model's context window. The turn fails, and on Claude Code, Codex and Hermes your next message starts fresh: every message stays on screen, a notice says the agent is no longer carrying the conversation, and it gets back up to eight recent notes, as after `/reset`. If that was the conversation's first turn, the notice instead says the turn was too large for the model: try a smaller request or a model with a larger window, and if every message does this, the agent's instructions and tools may be too large for the model. Clawboo Native trims the oldest turns from what it carries, so it keeps the conversation while trimming can make real room: a notice says it carries only the most recent part from your next message, and if that is still too large, that message fails too and it trims further. When trimming could not make real room, your next message starts fresh there too, with the same notices.
- Type `/reset` (or `/new`) and send it to start fresh. Every message stays on screen, a divider marks the point, and the agent stops carrying the conversation from before it. With your next message, a Clawboo Native, Claude Code, Codex or Hermes agent gets back up to eight recent notes from its own memory and the global memory (not a team's), as background. See [Team chat](/using/team-chat) for how a reset works in a team.

Only deleting the agent removes its chat history.

## Change the model

The model control sits in the top-right corner of the **Graph** card, beside the agent's runtime icon.

| Runtime        | What you can change                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clawboo Native | Pick a model. It saves at once and needs no Gateway.                                                                                                                                                                                                                                                   |
| OpenClaw       | Pick a model. Clawboo saves the choice in OpenClaw's own config for this agent.                                                                                                                                                                                                                        |
| Hermes         | Pick a model from the **OpenRouter** group, and the agent runs on OpenRouter. A custom model id keeps the agent on the provider it already has. An agent on your ChatGPT plan shows its model with **ChatGPT plan** and cannot be changed here, because the plan's models are not listed on this page. |
| Claude Code    | Nothing: the control reads **Claude Code default**, the model Claude Code picks.                                                                                                                                                                                                                       |
| Codex          | Nothing: the control reads **Codex default**, the model of your Codex account. Change it with the Codex CLI.                                                                                                                                                                                           |

For a team's members, you can also pick models when you deploy the team. See [Choose a runtime and model for each member](/using/teams#choose-a-runtime-and-model-for-each-member).

## Tune the personality

Open **Details > Personality**.

- **Presets** are seven one-click styles: **House Style**, **Ghost**, **Tired Senior**, **Glass Skull**, **The Blocker**, **The Rival** and **Feral**. Hover one to read what it is like. A new agent starts on **House Style**.
- **Sliders** are six dials from 0 to 100. A change saves when you let go of the slider: you see **Saving…**, then **Saved**.

| Slider         | What it sets                                              | At 0          | At 100                     |
| -------------- | --------------------------------------------------------- | ------------- | -------------------------- |
| **Bite**       | How hard you hit the work. Never the person who wrote it. | House Style   | Feral                      |
| **Spine**      | Whether you actually do what you're told.                 | Just Do It    | Blocks the Board           |
| **Glass Box**  | How much of the thinking the room gets to watch.          | Result Only   | Full Stream                |
| **Elbows**     | How you treat the other agents in the room.               | Stays In Lane | Picks Fights               |
| **Receipts**   | How much you admit about your own run.                    | Ships Clean   | Full Confession            |
| **Hobbyhorse** | The one hill you die on, and how often you climb it.      | No Crusade    | It's The Whole Personality |

Each slider adds one of five passages, depending on its value. Turn on **Show prompts** to read the exact text at the current values. Whatever you choose, the text ends with a **Limits** section that no slider removes. It keeps criticism on the work, never on a person, and the style never changes what the agent reports.

Clawboo writes the personality into the agent's SOUL.md, below the role text. Every runtime follows SOUL.md (see [Edit the agent files](#edit-the-agent-files)), so the personality reaches the agent on any runtime. **Preview SOUL.md** shows the result.

### Use your own instructions instead

Click **Use Custom Instructions** to write the personality yourself. Your text replaces the slider text, **Limits** included. It saves when you click away from the box or press `Cmd/Ctrl+S`. **Switch to Sliders** clears your text and goes back to the sliders.

While custom instructions are on, the SOUL tab under **Agent Files** shows your text below the role, and saving SOUL.md there keeps it.

## Edit the agent files

Open **Details > Agent Files**. Each file has a tab. Which tabs you see, and what each file does, depends on the agent's runtime.

| Runtime                    | Tabs                   | What the agent follows                                                                                                                                          |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw                   | SOUL, IDENTITY, AGENTS | The OpenClaw Gateway loads SOUL.md, IDENTITY.md and AGENTS.md. OpenClaw 2026.9 and later neither loads nor accepts TOOLS.md, so put tool guidance in AGENTS.md. |
| Clawboo Native             | SOUL, AGENTS           | SOUL.md is the agent's whole set of instructions. Saving it changes what the agent runs on.                                                                     |
| Claude Code, Codex, Hermes | SOUL, AGENTS           | Clawboo adds the first 4,000 characters of SOUL.md to each turn as the agent's persona.                                                                         |

- On every runtime, the @mentions in AGENTS.md draw the agent's links on the Org chart and team graphs. Only OpenClaw also reads AGENTS.md as instructions.
- A file that already has text keeps its tab on any runtime. That is why agents made with **Create Boo** or from the Marketplace also show IDENTITY: the file is saved, but only OpenClaw reads it. Agents made by an earlier version of Clawboo may also show TOOLS; only an OpenClaw Gateway older than 2026.9 reads that file.
- A Marketplace member on OpenClaw gets its skill list in AGENTS.md, under a **Tools** heading, instead of in TOOLS.md.
- Clawboo never creates or reads USER.md, HEARTBEAT.md or MEMORY.md. Their tabs appear only when the file already has text, for example one your OpenClaw Gateway wrote.

On Clawboo Native, an agent from a team template has Clawboo's team-lead or specialist instructions at the end of its SOUL.md. They tell the agent how to hand off or report work, so keep them unless you mean to change how it works with its team. An empty SOUL.md falls back to Clawboo's default instructions.

<Steps>

<Step title="Pick a file">

Open **Details > Agent Files** and click a file's tab.

</Step>

<Step title="Edit it">

A changed file shows an amber dot, and the card's footer reads **Unsaved**.

</Step>

<Step title="Save it">

Click **Save** or press `Cmd/Ctrl+S`. You should see **Saved** with the file's name, for example **Saved SOUL.md**.

</Step>

</Steps>

Changed files also save when you leave the page or switch to another agent. Saving AGENTS.md redraws the agent's links on the graphs.

Clawboo keeps the files of Clawboo Native, Claude Code, Codex and Hermes agents itself, so editing them never needs the OpenClaw Gateway. An OpenClaw agent's files live in the OpenClaw Gateway. While Clawboo's server is not connected to the Gateway, that agent's tabs open empty and **Save** fails. Do not type into those empty tabs: if the connection comes back before you save, your text replaces the real file.

## Permissions

**Details > Permissions** sets what an agent may run, for two runtimes:

- **OpenClaw:** **Execution Permissions** sets the agent's **Command Execution** to **Run Freely**, **Ask for Unknown** or **Always Ask**, and the Gateway enforces it. Below it, **Commands this Boo can run without asking** lists the commands it may run without asking, so you can revoke them.
- **Clawboo Native:** the **Running commands** switch, **Let this Boo ask to run commands**. With it on, the agent asks you before every command, and nothing is remembered.

See [Command permissions](/using/command-permissions) for the details.

Claude Code, Codex and Hermes agents have no **Permissions** section. Clawboo runs Claude Code and Codex with their own approval prompts and sandboxes turned off, and Hermes asks only before the commands its own policy flags, so all three can read and change any file your user account can. See [What agents can do](/concepts/permissions).

## Move an agent to another team

1. On the Org chart or a team graph, right-click the agent's Boo and choose **Move to team**. Boo Zero has no such row: it leads every team and joins none.
2. Pick one of your other active teams, then click **Move**.

A message says where the agent went. If it had tasks it had not started, the message adds how many, for example **2 unstarted tasks stay on Growth's board, unassigned.** Moving works without the OpenClaw Gateway.

- **Moves with it:** its own routines, except one set to run a particular task: that task is on the old team, so the routine is paused there for you to change or delete, and the message says so. Team routines stay with their team.
- **Stays on the old team:** tasks it had not started, unassigned, for someone there to pick up. Tasks it finished stay there too, with the agent still named on them. Files it saved in the old team's folder, and memory and budgets set for the old team, stay as well. A budget set on the agent itself follows it.
- **Changes:** it leaves the old team's rooms, and from its next run it works in the new team's folder. An OpenClaw agent's AGENTS.md still names its old teammates until you edit it.

The dialog refuses the move, and says why, while the agent leads its team (**It leads its team. Choose another lead for that team first.**) or has a task in progress or in review (**It has a task in progress or in review. Try again when that task is done.**). A task in review counts because a failed check can send it back to the same agent.

## Delete an agent

- **On the Org chart or a team graph:** right-click the agent's Boo, then **Delete**. It deletes at once, with no confirmation.
- **In the all-agents list:** right-click Boo Zero's mascot and choose **Show all agents**. Hover the agent's row, click the trash icon, then confirm. The prompt warns **This cannot be undone.**

Deleting removes the agent, its files, its personality, its own chat history and the routines that send work to it. Team routines stay. It works without the OpenClaw Gateway. An OpenClaw agent leaves Clawboo at once, and leaves the Gateway at once too, or the next time Clawboo connects if the Gateway is offline. If the Gateway refuses the delete (it will not delete its only agent), the agent comes back. That is why an OpenClaw agent deleted while the Gateway is offline keeps its routines until the Gateway confirms the delete.

## Troubleshooting

<AccordionGroup>

<Accordion title="Save fails with gateway_disconnected">

The message reads `Failed to save SOUL.md: Write SOUL.md failed (503): gateway_disconnected` (with the file you saved).

**What it means:** this is an OpenClaw agent, and Clawboo's server is not connected to the OpenClaw Gateway, where the agent's files live.

**Fix:** reconnect OpenClaw in **Settings > Runtimes** (or check **System Health**), then reopen the agent's page so its files load before you edit.

</Accordion>

<Accordion title="Save fails with a prompt-injection finding">

The message ends with `(422): agent content blocked: prompt-injection finding`.

**What it means:** the text matches a known prompt-injection pattern, so Clawboo refused it and recorded the refusal in the Governance audit log.

**Fix:** remove or reword the flagged text, then save again.

</Accordion>

<Accordion title="The message box says Gateway not connected">

This is an OpenClaw agent, and its chat goes through the OpenClaw Gateway. Connect the Gateway in **Settings > Runtimes**. Clawboo Native, Claude Code, Codex and Hermes agents chat through the Clawboo server, so their chat never shows this.

</Accordion>

<Accordion title="A Clawboo Native agent does not answer">

The page header reads **Disconnected** or **No provider key**: Clawboo Native has no provider it can use for this agent. Click **Set up in Runtimes** in the header and connect an API key or a local Ollama.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- Clawboo stores the slider values and any custom instructions in its database, and writes the generated text into SOUL.md below a `---` line and a `clawboo:personality` marker comment (`clawboo:personality-custom` for custom instructions). When **Agent Files** loads, it rebuilds that block from the saved custom instructions, or from the slider values when there are none.
- File routes: `GET` and `PUT /api/agents/:agentId/files/:name`, where the name is one of the seven agent files (any other name returns 400 `invalid file name`). Personality: `POST /api/personality`. Model: `PATCH /api/agents/:agentId/model`.
- `DELETE /api/agents/:agentId` answers `upstreamDeletePending: true` when an OpenClaw agent's Gateway is offline. Until the Gateway confirms, `GET /api/agents` lists that agent in `pendingDeleteIds`.
- See the [Agents API reference](/reference/rest-api/agents) for every field.

</Accordion>

## Next steps

- [Teams](/using/teams): put agents together and set rules they all follow.
- [Team chat](/using/team-chat): give your agents work as a team.
- [Command permissions](/using/command-permissions): decide what each agent may run.
- [What an agent sees](/concepts/agent-context): everything that goes into an agent's turn.
- [Agents API reference](/reference/rest-api/agents): the routes behind this page.
