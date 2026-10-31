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
- The browser connectors, Playwright and Chrome DevTools. Chrome DevTools asks you before each action; with the access a new agent gets, Playwright offers only its reading tools. See [Connectors](/using/connectors) for how to let an agent act through Playwright.
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
| **Browser**          | The latest screenshot from the agent's web browser.                                                                                                                               |
| **Activity**         | The agent's tool calls, results and errors as they happen.                                                                                                                        |
| **Details**          | **Workspace**, **Personality**, **Permissions**, **Brief** (Boo Zero only) and **Agent Files**.                                                                                   |

In **Tasks & Routines**, click a task to read its output and progress. The comment box at the bottom (**Comment or steer this task…**) sends your comment to the agent the task belongs to, and the line beside **Send** says what sending does. On a running task, the agent gets it during the run. A task that waits on you, or waits in **To do**, starts again for it. A finished task cannot run again, so the note under your comment offers **Send as a follow-up task** instead. Each comment you send shows where it went. See [Steer a running task](/using/board#steer-a-running-task) for every case. **Open on Board** opens the task on the board.

**Workspace** under **Details** is a read-only view of the files in the agent's task worktree, when the agent has taken a board task that changes files. OpenClaw agents keep their files in the OpenClaw Gateway's workspace instead.

## Chat with an agent

The chat on an agent's page is a one-to-one conversation with that agent. It works with Clawboo Native agents, and with OpenClaw agents while the OpenClaw Gateway is connected. On a Claude Code, Codex or Hermes agent's page, the message box also goes through the OpenClaw Gateway connection, which does not run these agents. Without that connection it reads **Gateway not connected…**. Give these agents work in [team chat](/using/team-chat) and on the [board](/using/board) instead.

- The chat shows the latest 150 messages. **Load earlier messages** at the top brings in older ones.
- While the agent works, the send button turns into **Stop**.
- Type `/reset` (or `/new`) and send it to start fresh. Every message stays on screen, a divider marks the point, and the agent stops carrying the conversation from before it. With your next message, a Clawboo Native agent gets back up to eight recent notes from its own memory and the global memory (not a team's), as background. See [Team chat](/using/team-chat) for how a reset works in a team.

Only deleting the agent removes its chat history.

## Change the model

The model control sits in the top-right corner of the **Graph** card, beside the agent's runtime icon.

| Runtime        | What you can change                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clawboo Native | Pick a model. It saves at once and needs no Gateway.                                                                                                                                                                                             |
| OpenClaw       | Pick a model. Clawboo saves the choice in OpenClaw's own config for this agent.                                                                                                                                                                  |
| Hermes         | Pick an OpenRouter model. The agent then runs it through OpenRouter, even if it ran on a ChatGPT subscription model before. A **ChatGPT subscription** model can be picked only when you deploy the team, once Hermes is signed in with ChatGPT. |
| Claude Code    | Nothing: the control reads **Claude Code default**, the model Claude Code picks.                                                                                                                                                                 |
| Codex          | Nothing: the control reads **Codex default**, the model of your Codex account. Change it with the Codex CLI.                                                                                                                                     |

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

<Warning>

While custom instructions are on, the SOUL tab under **Agent Files** still shows the slider personality, not your text. If you edit and save SOUL.md there, the slider text replaces your custom instructions in the file the agent follows. While custom instructions are on, change the personality only here. If it happens, click in your custom instructions and press `Cmd/Ctrl+S` to write them back.

</Warning>

## Edit the agent files

Open **Details > Agent Files**. Each file has a tab. Which tabs you see, and what each file does, depends on the agent's runtime.

| Runtime                    | Tabs                          | What the agent follows                                                                                                                              |
| -------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw                   | SOUL, IDENTITY, TOOLS, AGENTS | The OpenClaw Gateway loads SOUL.md, IDENTITY.md and AGENTS.md. OpenClaw 2026.9 and later does not load TOOLS.md, so put tool guidance in AGENTS.md. |
| Clawboo Native             | SOUL, AGENTS                  | SOUL.md is the agent's whole set of instructions. Saving it changes what the agent runs on.                                                         |
| Claude Code, Codex, Hermes | SOUL, AGENTS                  | Clawboo adds the first 4,000 characters of SOUL.md to each turn as the agent's persona.                                                             |

- On every runtime, the @mentions in AGENTS.md draw the agent's links on the Org chart and team graphs. Only OpenClaw also reads AGENTS.md as instructions.
- A file that already has text keeps its tab on any runtime. That is why agents made with **Create Boo** or from the Marketplace also show IDENTITY and TOOLS: those files are saved, but only OpenClaw reads them.
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

Claude Code, Codex and Hermes agents have no **Permissions** section. Clawboo runs them with their own approval prompts and sandboxes turned off, so they can read and change any file your user account can. See [What agents can do](/concepts/permissions).

## Delete an agent

- **On the Org chart or a team graph:** right-click the agent's Boo, then **Delete**. It deletes at once, with no confirmation.
- **In the all-agents list:** right-click Boo Zero's mascot and choose **Show all agents**. Hover the agent's row, click the trash icon, then confirm. The prompt warns **This cannot be undone.**

Deleting removes the agent, its files, its personality and its own chat history. It works without the OpenClaw Gateway. An OpenClaw agent leaves Clawboo at once, and leaves the Gateway at once too, or the next time Clawboo connects if the Gateway is offline. If the Gateway refuses the delete (it will not delete its only agent), the agent comes back.

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

This agent's chat goes through the OpenClaw Gateway. For an OpenClaw agent, connect the Gateway in **Settings > Runtimes**. For a Claude Code, Codex or Hermes agent, give it work in [team chat](/using/team-chat) or on the [board](/using/board) instead.

</Accordion>

<Accordion title="A Clawboo Native agent does not answer">

The page header reads **Disconnected** or **No provider key**: Clawboo Native has no provider it can use for this agent. Click **Set up in Runtimes** in the header and connect an API key or a local Ollama.

</Accordion>

<Accordion title="The SOUL tab does not show my custom instructions">

This is expected while **Use Custom Instructions** is on. See the warning under [Use your own instructions instead](#use-your-own-instructions-instead).

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- Clawboo stores the slider values and any custom instructions in its database, and writes the generated text into SOUL.md below a `---` line and a `clawboo:personality` marker comment. When **Agent Files** loads, it rebuilds that block from the saved slider values.
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
