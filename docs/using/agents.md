---
title: Working with agents
description: Open an agent's page, use its cards (graph, tasks and routines, browser, activity, details), edit the agent files, tune its personality, and create or delete a Boo.
---

Use this page when you want to work with one agent (a [Boo](/appendices/glossary)) directly: chat with it, edit its config files, tune its personality, or create and remove it. Every Boo is a real agent record backed by an [AgentSource](/appendices/glossary); its config lives in seven Markdown files that the runtime reads on each turn.

The whole surface is the **agent's page** (`AgentDetailView`): its 1:1 chat on the left and a stack of cards on the right, backed by `/api/agents/:agentId/files/:name` for file I/O and `/api/personality` for the personality. This page documents what each card does, how the four core files map to behavior, and where edits persist.

## Prerequisites

<Note>
Agent file reads and writes go through the connected runtime. The editor and personality sliders are no-ops while the connection is down (`saving` never fires; the file PUT returns `503 gateway_disconnected`).
</Note>

- A connected runtime (OpenClaw Gateway, or a non-OpenClaw runtime, see [Connecting runtimes](/runtimes/connecting-runtimes)).
- At least one Boo. If you have none, create one (see [Create a Boo](#create-a-boo)).

## Open an agent's page

Two entry points open an agent's page (both call `openAgent(agentId)`):

- **The sidebar**: click the agent's tile in the team's mascot grid. With no team selected, the agent column lists every agent as a row instead; click the row.
- **Any graph**: right-click a Boo → **Open agent**. See [Ghost Graph](/using/ghost-graph).

[Boo Zero](/using/boo-zero) has its own way in: the mascot at the top of the team rail.

The chat sits on the left, under a 44 px header with the agent's avatar, name and connection state, the card toggles, and the GitHub Star pill. The cards stack on the right, top to bottom in the order of their toggles. A fresh install opens **Graph** and **Details**:

```
┌───────────────────────────────┬────────────────────────┐
│ agent · status   toggles   ★  │ ╭ Graph ─────────────╮ │
├───────────────────────────────┤ │                    │ │
│                               │ ╰────────────────────╯ │
│             Chat              │ ╭ Details ───────────╮ │
│                               │ │                    │ │
└───────────────────────────────┴─╰────────────────────╯─┘
```

| Card                 | Toggle         | What it holds                                                                                                                                                                                                                                        |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Graph**            | Network icon   | The agent's mini graph: this Boo plus its skills and connectors, with drag-to-install. Hover the Boo for its port and pull a thread onto empty space to add a skill or connector, or place one first with the **+** button and drag it onto the Boo. |
| **Tasks & Routines** | Checklist icon | The agent's tasks, then the routines that send it work. See [Tasks and routines](#tasks-and-routines).                                                                                                                                               |
| **Browser**          | Globe icon     | The newest screenshot this Boo captured, re-fetched on a short interval. With no frame yet, the empty state says whether nothing has been captured or no browser connector is granted to this Boo.                                                   |
| **Activity**         | Terminal icon  | The live observability terminal scoped to this agent: tool calls, results, and errors as they stream.                                                                                                                                                |
| **Details**          | Folder icon    | Workspace, Personality, Permissions, Brief (Boo Zero only) and the Agent Files. See [The Details card](#the-details-card).                                                                                                                           |

Each card has a slim header with its title, **Maximize** and close. **Details** has no title row: its section pills are its top row and carry those two buttons. **Maximize** fills the page with that card until you press **Restore**. A header toggle shows or hides its card (tooltip **Show graph**, **Hide graph**, and so on), and a card's close button does the same. With every card closed, the chat takes the full width. Drag the gap between the chat and the cards, or between two cards, to resize. Which cards are open is remembered in your browser (`clawboo.panes`) for every agent's page, and the sizes are remembered for each combination of open cards.

The chat renders its most recent ~150 messages, with **Load earlier messages** at the top for the rest.

In the **Graph** card's top-right corner, beside the **+** button, the agent's **runtime icon** is fused with a **model selector** for changing this agent's model. A native (`clawboo-native`) agent picks from the native model catalog and the change is saved to its `AgentConfig` via `PATCH /api/agents/:agentId/model` (no Gateway needed); an OpenClaw agent picks from the OpenClaw catalog and the change is written as a per-agent override in `openclaw.json`; a **Hermes** agent picks from the live OpenRouter catalog (stored in `execConfig`, routed through OpenRouter). **Codex** and **Claude Code** run their account/SDK default, so they show a "runtime-managed model" note instead of a picker. The agent's live activity has a card of its own, so the Graph card carries no Activity button.

![The agent detail view: chat on the left, mini-graph and the tabbed inline editor on the right.](/images/agent-detail.png)

## Tasks and routines

The **Tasks & Routines** card lists the tasks assigned to this agent, from its team's board (every team's board for an agent on no team, such as Boo Zero), in sections, most recently updated first: **Needs you**, **In progress**, **To do**, **Done** and **Cancelled**. Done and Cancelled start folded. **Needs you** always shows, even when empty, and also holds any approvals waiting on this agent. With no tasks yet, the card reads **No tasks assigned to this agent yet.**

Click a task to open its detail in the card: its title and description, status, assignee, runtime and cost, its output (or its latest report), **Progress** (the live activity for that task), and **Comments**. **All tasks** at the top, or `Escape`, takes you back to the list, and **Open on Board** (the kanban icon) opens the task in the [Board](/using/board)'s drawer.

At the bottom of an open task, the comment box (**Comment or steer this task…**) saves your comment on the task and passes it to the agent working on it. The line under the box says what will happen. While the task is in progress, a native agent, Claude Code, Codex or OpenClaw takes the comment at the run's next step without stopping, and Hermes pauses its run to read it, then carries on in the same session. A finished or cancelled task keeps the comment and forwards nothing. A task that waits on you after a failure or a stop, and has an agent, also offers **Send and retry**, which sends the comment and runs the task again. See [Steering a running task](/runtimes/index#steering-a-running-task).

Below the tasks, **Routines** lists the agent routines aimed at this agent, with the same rows as the [Routines](/using/routines) view: open a routine, pause or resume it, run it now, or delete it. **New routine** opens the routine dialog already set up as an agent task for this agent. With none yet, it reads **No routines send this agent work yet.**

## The Details card

The **Details** card has no title row. Its top row is a set of section pills, which also carry the card's maximize and close buttons. It opens on **Personality**.

| Pill            | What it shows                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**   | A read-only view of this Boo's task worktree: the file tree with change badges, the now line (the file or command it most recently touched), and the selected file's diff or content.                                                                                                                                   |
| **Personality** | The presets and sliders; see [Tune the personality](#tune-the-personality).                                                                                                                                                                                                                                             |
| **Permissions** | `openclaw` and `clawboo-native` Boos only. An OpenClaw Boo gets **Execution Permissions** (the **Command Execution** posture, applied at the Gateway) plus **Commands this Boo can run without asking**, its standing permissions and their revoke controls. A native Boo gets the **Running commands** switch instead. |
| **Brief**       | Boo Zero only. Holds Boo Zero's display name override and Global Brief (its load-bearing identity surface). The pill is hidden for every other agent.                                                                                                                                                                   |
| **Agent Files** | The agent's Markdown files, each in its own tab; see [Edit the agent files](#edit-the-agent-files).                                                                                                                                                                                                                     |

The card's footer names the section you are in and reads **Saved**, or **Unsaved** while any agent file has changes you have not saved.

<Note>
**Permissions** is runtime-gated, and the two runtimes that get it get different controls, because the thing that enforces them is different. An OpenClaw Boo's **Command Execution** posture is written to the Gateway, which is what actually gates its commands, and the standing-permission list below it is read from OpenClaw's own stored policy rather than from clawboo's records, so it shows what is in force. A native Boo has no Gateway, so it gets the **Running commands** switch: with that on you are asked before every command and nothing is remembered. The pill is not offered on `claude-code`, `codex`, or `hermes`, where neither control would be read by anything. A Boo created through clawboo's screens already carries a posture of its own; see [What a new Boo is allowed to run](/runtimes/openclaw#what-a-new-boo-is-allowed-to-run).
</Note>

## Edit the agent files

**Agent Files** adds a second row of file tabs, one for each file this agent's runtime reads, with **Save** at its right end. Coming back to Agent Files reopens the file you last had open. The file tabs share a single CodeMirror 6 instance (Markdown highlighting, line wrapping).

**The seven agent files are OpenClaw's agent-file set, and which tabs you see depends on the agent's runtime.** An OpenClaw agent shows the four clawboo creates for it: SOUL, IDENTITY, TOOLS and AGENTS. A `clawboo-native` agent shows SOUL and AGENTS; a `claude-code`, `codex` or `hermes` agent shows SOUL and AGENTS. Those drivers read no agent file directly, so clawboo delivers SOUL.md to them itself: it is injected as a persona block at the top of the run's context, ahead of the team rules and the roster.

USER, HEARTBEAT and MEMORY get no tab by default on any runtime. They belong to OpenClaw's file set, but clawboo never creates one and never reads one back, so an always-on editor for them would be a control wired to nothing. Any file that already has content stays visible whatever the runtime, so nothing you previously wrote disappears and a file your Gateway wrote is never hidden.

Two name collisions are worth knowing about. `hermes` keeps its own compounding `MEMORY.md` in its per-identity home, and clawboo never writes that file: the MEMORY tab here is a different file with different behavior. `codex` reads an `AGENTS.md` from the working tree, which is your repo's file, not this one.

| File           | Tab       | What you can write there                                                                                                                                                                           |
| -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOUL.md`      | SOUL      | Persona, tone, and boundaries. Also holds the merged personality block (see below). On `clawboo-native` this **is** the agent's system prompt: editing it re-derives the prompt the runtime reads. |
| `IDENTITY.md`  | IDENTITY  | Name, vibe, and emoji.                                                                                                                                                                             |
| `TOOLS.md`     | TOOLS     | Tool notes for the agent to read. Does not configure tools (the graph's skill nodes come from `/api/capabilities`).                                                                                |
| `AGENTS.md`    | AGENTS    | Operating instructions, priorities, and routing rules. Drives the dependency edges on the graph.                                                                                                   |
| `USER.md`      | USER      | Notes about you. Nothing in Clawboo uses this file; only your Gateway might. Tab appears once the file has content.                                                                                |
| `HEARTBEAT.md` | HEARTBEAT | Checklist an OpenClaw heartbeat can be pointed at. Nothing in Clawboo acts on it. Tab appears once the file has content.                                                                           |
| `MEMORY.md`    | MEMORY    | Notes for OpenClaw agents. Not the Hermes memory file, and not clawboo memory. Tab appears once the file has content.                                                                              |

### Steps

1. **Pick a file tab.** The active tab gets an accent underline; the CodeMirror document swaps to that file's content. All seven files are loaded in parallel when the Details card opens.
2. **Edit.** A modified tab shows an amber dot, and so does the **Agent Files** pill. The card's footer reads **Unsaved** while any file is dirty.
3. **Save.** Click **Save** (it stays disabled until the open file has changes), or press `Cmd/Ctrl+S`. The write goes through a per-agent mutation queue (serialized so concurrent writes never race) to `PUT /api/agents/:agentId/files/:name`, and a toast confirms `Saved <file>`.
4. **Saving AGENTS.md** also triggers a Ghost Graph refresh, so new routing edges appear without a manual reload. No other file affects the graph.

<Tip>
You don't have to save before switching agents, leaving the page, or closing the Details card; the editor saves all dirty files automatically when it closes (best-effort). Saving explicitly is still safer when the connection is flaky.
</Tip>

## Tune the personality

The **Personality** section opens with seven one-click **presets**: **House Style**, **Ghost**, **Tired Senior**, **Glass Skull**, **The Blocker**, **The Rival** and **Feral**. Hover one for its tagline. A preset sets all six sliders at once, through the same save a drag uses, and the preset that matches the current values is highlighted.

Below the presets are six sliders, each from 0 to 100, with a one-line description, the current value, and a name at each end of the track. Moving a slider does not save; the save fires on pointer-up (the commit).

| Dimension  | What it sets                                             | 0 (left)      | 100 (right)                |
| ---------- | -------------------------------------------------------- | ------------- | -------------------------- |
| Bite       | How hard it hits the work, never the person who wrote it | House Style   | Feral                      |
| Spine      | Whether it actually does what it is told                 | Just Do It    | Blocks the Board           |
| Glass Box  | How much of its thinking you get to watch                | Result Only   | Full Stream                |
| Elbows     | How it treats the other agents in the room               | Stays In Lane | Picks Fights               |
| Receipts   | How much it admits about its own run                     | Ships Clean   | Full Confession            |
| Hobbyhorse | The one issue it keeps raising, and how often            | No Crusade    | It's The Whole Personality |

Each slider has five written stops, one for each fifth of its range. Turn on **Show prompts** (next to the **Presets** label, off by default) to see the exact text each slider adds at its current value; your browser remembers the choice. Whatever the values, the generated block ends with a **Limits** section that no slider removes: criticism attaches to the work, never to a person, and the voice never changes the verdict.

A new Boo starts on **House Style**. An agent whose personality was saved before these six dimensions existed opens on its nearest equivalent.

### Where values persist

A commit writes to **two** places:

1. **SQLite** (`POST /api/personality`): the source of truth for the slider values. The handler stores a `{ values, customText }` JSON wrapper in the agent's `personality_config` column (upserting the agent row if it doesn't exist yet).
2. **`SOUL.md`** (best-effort): each slider's stop is rendered as a Markdown section and merged into `SOUL.md` below a `---` separator and a `clawboo:personality` marker comment. The merge reads the current `SOUL.md`, strips any old personality block, preserves the role description above the separator, and writes the result back.

Because SQLite is authoritative, the slider positions survive even if the `SOUL.md` write fails. When the Details card loads `SOUL.md`, it strips the stale personality block and re-merges the SQLite values, so the SOUL file tab always reflects the current sliders.

<Note>
Writes through the Gateway's agent-file API are best-effort and may not persist, so the slider values live in SQLite as the source of truth. Treat the `SOUL.md` block as a generated projection of the SQLite source, not the other way around.
</Note>

### Custom instructions instead of sliders

Click **Use Custom Instructions** to switch to a free-text override. The textarea content saves on blur or `Cmd/Ctrl+S` (`POST /api/personality` with `customText`), and is merged into `SOUL.md` under a `clawboo:personality-custom` marker comment; it **overrides** the slider-generated block, **Limits** section included. **Switch to Sliders** clears the custom text and restores the slider personality.

The **Preview SOUL.md** toggle at the bottom of the section shows the merged result (role description plus the active personality block). On `clawboo-native` that merged text becomes the agent's system prompt; on OpenClaw the Gateway decides how it is used.

## Start a fresh conversation

Type `/reset` (or `/new`) in the chat composer and send. In Clawboo the two words do the same thing. That is a deliberate simplification of OpenClaw underneath, where the reply engine treats them as one trigger (both archive the transcript, keep the session key, and mint a new session id behind it) but the Control UI routes them apart: `/reset` goes through as a message, while `/new` calls `sessions.create` and switches to a brand new `agent:<id>:dashboard:<uuid>` key.

**Your conversation stays on screen.** Starting fresh ends what the boo is carrying, not what you can see. Every message stays exactly where it is, in the same chat, and a divider marks the point past which the boo is no longer holding the thread. Scroll up and it is all still there.

What happens:

1. the resume pointer is dropped (native) or the command is forwarded to the runtime (OpenClaw), so the next turn starts with no memory of what came before the divider;
2. a divider is written into the transcript and kept there, so it is still in place after a reload;
3. no message is moved, re-keyed, or deleted.

In a team chat (General or a room), every teammate's own conversation in that chat is reset, and the chat shows one divider, because you are looking at a single merged timeline. To set a team chat's messages aside as well, use **Clear chat** in the **...** menu on that chat's row in the sidebar; see [Group chat](/using/group-chat).

### What the boo still knows

Its **character comes back in full**. The system prompt is rebuilt from the agent's own files on every single run, so personality, role and custom instructions are untouched by a reset.

**Its notes come back too.** On the first turn after a reset the boo is handed its own saved memory: up to eight of the most recent facts it recorded, capped so the reminder never crowds out the conversation. That is what keeps a reset feeling like "let's start this topic fresh" rather than talking to someone with amnesia. The block rides the first turn only, so it never repeats.

Two limits worth knowing. Only the boo's **own** notes and globally-scoped ones are included; facts belonging to a team room stay in that room. And the notes are delivered as background to consult, explicitly not as instructions to follow, because their content was written by whoever talked to the boo.

If nothing was ever saved, nothing is injected and the boo genuinely starts blank. Memory is filled by the `memory_save` tool, so a boo that never chose to save anything has nothing to recall.

<Note>
Deleting the agent still deletes its conversation. That is the only thing that removes messages.
</Note>

## Create a Boo

Click **Create Boo** in the sidebar's agent column, below the rooms list, to open `CreateBooModal`.

1. Enter a **Name** (required) and an optional **Role** (free text that becomes the base `SOUL.md`).
2. Click **Create Boo** (or press Enter). The modal:
   - merges the default personality (the **House Style** preset) into the role text and creates the agent via `POST /api/agents`, on OpenClaw while an OpenClaw Gateway is connected and on Clawboo Native otherwise; the server writes `SOUL.md`, `IDENTITY.md`, and `TOOLS.md`;
   - persists the default personality to SQLite (`POST /api/personality`);
   - assigns the new Boo to the currently selected team (best-effort) via `POST /api/teams/:id/agents`.

<Note>
**Create Boo** needs no Gateway. The Boo runs on OpenClaw when a Gateway is reachable, from your browser or through the server's own connection, and on Clawboo Native when none is. A native Boo runs on its `SOUL.md` as its system prompt and needs a connected provider to answer. For an OpenClaw Boo, a name collision with an existing agent surfaces as a create error.
</Note>

## Delete a Boo

Two places delete an agent:

- **Any graph**: right-click the Boo, then **Delete**. It deletes at once, with no confirmation, and works without a Gateway.
- **The all-agents list**: right-click the Boo Zero mascot at the top of the team rail and pick **Show all agents**; the agent column then lists every agent as a row. Hover a row, click its trash icon, and confirm. Like the graph's **Delete**, it works without a Gateway.

Either way, `deleteAgentOperation`:

1. archives the agent via `DELETE /api/agents/:agentId`; the server archives it through its runtime (an OpenClaw agent is deleted from the Gateway) and removes the SQLite row plus its FK-referenced cost/approval rows. If an OpenClaw agent's Gateway is down, the server removes its own records at once and deletes the agent from the Gateway the next time it connects, answering `{ ok: true, upstreamDeleted: false, upstreamDeletePending: true }`;
2. removes it from the in-memory fleet store;
3. re-identifies [Boo Zero](/appendices/glossary) from the remaining agents (in case the deleted Boo was the leader);
4. clears its transcript and deletes its chat history.

<Danger>
Deletion is not reversible. The agent's files and config are removed from both the runtime and SQLite. There is no undo.
</Danger>

## Verify it worked

- **File save**: re-open the file tab (or reload the page) and confirm the saved content is loaded back from `GET /api/agents/:agentId/files/:name`. The footer reads **Saved**.
- **Personality**: reload the page; the sliders should restore their saved positions (read from `GET /api/personality?agentId=...`), and **Preview SOUL.md** should show the matching personality block.
- **Create / delete**: the agent appears in (or disappears from) the sidebar. After a create, `GET /api/agents` includes the new record.

## Troubleshooting

<Warning>
**Edits don't save.** The editor and sliders write through the connected runtime. If the connection dot in the header is amber, file writes return `503` and slider commits silently fail. Reconnect the runtime, then retry the save.
</Warning>

<Warning>
**Personality slider moved back after I switched agents.** A slider commit fires on pointer-up; a drag with no release doesn't save. Release the thumb (or use a keyboard arrow + release) to commit, and watch for the **Saved** indicator.
</Warning>

<Note>
**An invalid file name returns 400.** The file routes validate `:name` against the seven known agent files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`). Any other name is rejected with `{ error: "invalid file name" }`.
</Note>

## See also

- [Ghost Graph](/using/ghost-graph), the mini graph in the Graph card, a team's graph, and the Org chart
- [Group chat](/using/group-chat), work with a whole team at once, in General or a room
- [Routines](/using/routines), the routines the Tasks & Routines card lists
- [Boo Zero](/using/boo-zero), the universal team leader's Brief and rules
- [`/api/agents` reference](/reference/rest-api/agents), full request/response shapes for the registry, files, and sessions
- [Glossary](/appendices/glossary), Boo, Boo Zero, AgentSource, registry of record
