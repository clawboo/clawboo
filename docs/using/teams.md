---
title: 'Create and manage teams'
sidebarTitle: 'Teams'
description: 'Create a team from a template or from scratch, choose a runtime and model for each member, set team rules and a work check, and archive or delete a team.'
icon: 'users'
keywords:
  [
    'team',
    'deploy a team',
    'team rules',
    '/rule',
    'team brief',
    'work check',
    'verify command',
    'Leader',
    'archive',
    'delete team',
    'color collection',
    'Refresh Protocol',
    'team space',
  ]
---

A team is a group of agents that work on your requests together. Each team has its own chats (**General** plus any rooms you add), its own tasks on the board, a brief, and rules that every member follows. [Boo Zero](/using/boo-zero), your team leader, coordinates every team.

Use this page to create a team, choose each member's runtime and model, set team rules and a work check, and archive or delete a team. For a guided first run, follow [Deploy your first team](/getting-started/first-team).

## Before you begin

A team template creates real agents, so you need at least one runtime that can run them:

- Clawboo Native, the built-in runtime, with a provider: an API key or a local Ollama.
- Or the OpenClaw Gateway, Claude Code, Codex or Hermes.

See [Providers and runtimes](/using/providers-and-runtimes). An empty team needs nothing connected.

## Create a team

<Steps>

<Step title="Open the team templates">

In the team rail, click the dashed **+** at the bottom (**Create a team**). The [Marketplace](/using/marketplace) opens on its **Teams** tab.

</Step>

<Step title="Pick a starting point">

Click **Deploy** on a team card to start from that template. To see who is on a team first, click **Details**. For an empty team, click the **Start from scratch** card.

</Step>

<Step title="Customize the team">

Set the team's name, badge and colors, and each member's runtime and model. See [Customize the team](#customize-the-team).

</Step>

<Step title="Deploy">

Click **Deploy team**, or **Create team** for an empty team. Clawboo creates each agent and shows its progress.

You land in the new team's **General** chat. Before you can message the team, a **Meet your team** card asks you to introduce yourself. See [Team chat](/using/team-chat).

</Step>

</Steps>

An empty team opens on its chat too, but **Get Started** stays disabled until the team has an agent. Add one with **Create Boo** in the agent column (see [Agents](/using/agents)).

## Customize the team

The customize step has three sections.

| Section             | What you set                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**            | The team's name.                                                                                                                                                                                                          |
| **Team badge**      | The team's icon (click the badge to change it) and its accent color. The color tints the team's icon in the team rail and its halo on the [Org chart](/using/org-chart).                                                  |
| **Teammate colors** | A color collection for the members' Boos, with a live preview of the roster: Vivid Pop, Dusty Pastel Pro, Coastal Mist, Executive Jewel, Sharp SaaS, Soft Neutral Editorial, Monochrome Accent, or Classic (the default). |

### Choose a runtime and model for each member

The roster under **Teammate colors** lists each member. Each row has:

- A **runtime** picker: Clawboo Native, OpenClaw, Claude Code, Codex or Hermes. One team can mix runtimes.
- A **model** picker, for members on Clawboo Native, OpenClaw or Hermes. Pick a provider first (only the providers you connected are listed), then a model. Until you pick one, it reads **Default**, followed by the model the member will run on Clawboo Native and OpenClaw.

Members on Claude Code or Codex run on that tool's own default model, so they have no model picker. Changing a member's runtime clears its model pick.

Which runtime a row starts on:

- A Marketplace template suggests OpenClaw for every member. A team from scratch suggests Clawboo Native. During first-time setup, every member starts on the runtime you connected in setup.
- When the suggested runtime is not connected, the row starts on the first runtime that is, in this order: Clawboo Native (with an API key or a local Ollama), OpenClaw, Claude Code, Codex, Hermes. The row says so, for example **OpenClaw unavailable · using Codex** when you only signed in with ChatGPT. With nothing connected, the row stays on Clawboo Native.
- You can pick OpenClaw only while the OpenClaw Gateway is connected, and Claude Code, Codex or Hermes only once you have connected them. Clicking a greyed-out runtime closes this dialog and opens **Settings > Runtimes** so you can connect it.

Clawboo Native needs a provider to answer. Without one, the team still deploys, but its Clawboo Native agents cannot reply until you connect a provider. The chat tells you why.

### What happens when you deploy

- **Clashing names get a number.** If agents or a team with the same names already exist, Clawboo gives the new ones the next free number, for example **Code Reviewer Boo 2**. It also updates who hands work to whom to match.
- **One failed agent does not stop the rest.** Clawboo keeps going, then lists any failures in a message such as **2 of 3 agents created (Writer Boo failed)**. If no agent can be created, you return to the customize step with **No agents could be created. Check that the runtime is connected, then retry.** Clawboo removes the empty team it made, so you can click **Deploy team** again. If it cannot, the message says so: delete that team from the team rail, or the next try adds a second team.
- **OpenClaw members need the Gateway.** If you put a member on OpenClaw while the Gateway is offline, the deploy stops with **Connect an OpenClaw Gateway to deploy the OpenClaw members, or switch them to another runtime.**
- **The team gets a brief.** Clawboo writes a starting [team brief](#team-brief) that you can edit.

## The team's Leader

When you deploy a template, a member whose name or role reads as a lead (CTO, Team Lead, Project Manager, Coordinator and similar) gets a **Leader** badge in the roster. That member becomes the team's Leader.

- Boo Zero still leads the team. On the team graph, the Leader sits between Boo Zero and the other members.
- On Clawboo Native, the Leader gets the team-lead instructions and the leader model. The other members get the specialist ones.
- When your install has no Boo Zero, the Leader leads the team's chats. A team with no Leader is led by its first member.

In a team chat, a message goes to the member you @mention. Otherwise it goes to Boo Zero, then to the Leader if it is in that chat, then to the chat's first member. See [Team chat](/using/team-chat).

The dashboard has no control for changing the Leader after you deploy. The API can change it: see **Under the hood** at the end of this page.

## Brief and rules

Open a team's settings from any of its chats: in **General** or a room, click the gear in the chat header. Its tooltip is the team's name followed by **brief & rules**.

The settings window has six sections: **Icon**, **Accent color**, **Color collection**, **Brief**, **Rules** and **Work check**. Icon and color changes save as you make them.

![The Growth team's settings window: the Brief, with Save and Regenerate, above the Rules box with one rule per line and Save rules](/images/team-brief-rules.png)

### Team rules

Team rules are instructions that every member of the team follows. Clawboo adds them to every turn in the team's chats (General and every room), for Boo Zero and for each teammate, including the work Boo Zero hands out. A correction you save as a rule keeps applying, so you do not have to repeat it. Rules apply from the next turn.

A team Routine posts into **General**, so its runs follow the rules too. A Routine aimed at one agent runs without them.

You can add rules in two ways.

<Tabs>

<Tab title="The Rules box">

In the team's settings, type in **Rules**, one rule per line, then click **Save rules**. You should see **Team rules saved.** Rules can be up to 4,000 characters; a longer save fails with **Could not save rules.**

</Tab>

<Tab title="/rule in a chat">

In any of the team's chats, type `/rule` and the rule, then send it:

```text
/rule Every price on the page comes from the live plan catalog.
```

Clawboo saves it as a rule instead of sending it to an agent. The chat shows **Rule saved for team:** with your rule, and a **Team rule saved.** message appears.

</Tab>

</Tabs>

`/rule` keeps your rules as a bulleted list: it turns every line into a bullet, drops blank lines, and skips a rule that is already there (ignoring capital letters). It works only with a space and some text after it, so `/rules` or `/rule:` is sent as a normal message. If the new rule would take the rules past 4,000 characters, you see **Could not save team rule. Try again?**

### Team brief

The brief describes the team: what it is for, who is on it, and how they work together. Clawboo writes one when you deploy a template, and you can edit it in the team's settings. **Regenerate** rebuilds it from the current members; nothing changes until you click **Save**.

Boo Zero reads a team's brief only when you start a message in Boo Zero's own chat with @ and the team's name, and then only its first 900 characters. Team chats do not include the brief, so use rules for anything the team must follow. See [What Boo Zero reads](/using/boo-zero#what-boo-zero-reads).

### Work check

The work check is the command Clawboo runs to check an agent's work on the team's tasks, such as `npm test`. It checks two kinds of task, and a checked task reaches **Done** only if the command succeeds:

- **Team chat work**: a task handed out in team chat, or one you give an agent on the Board, that changed the team's folder. Clawboo runs the command in the team's folder after the agent's run ends. Without a work check, this work is not checked. OpenClaw agents work outside the team's folder and are not checked. If Clawboo cannot record the folder when a task starts, that task is not checked, and a comment on it says so.
- **Task-runner tasks** that changed files. Clawboo runs the command in the task's own folder.

Agent routines you create in the app are not checked. See [When work is checked](/using/board#when-work-is-checked).

In the team's settings, type the command in **Work check**, then click **Save check** or press Enter. You should see **Work check saved.** To remove it, empty the box and save; you should see **Work check cleared.** The command is one line of up to 2,000 characters. Pasting text that spans lines is refused with **The work check is one line.**, so two commands are never joined into one; put `&&` between them instead. If a save fails, you see **Could not save the work check.** and your edit stays in the box.

Above the box, **Active check** says which check runs now. It reads the team's command again when you come back to the window, so it also shows a change made elsewhere, for example through the API:

- **The command, set for the team**: every check of the team's tasks runs it from the next check on, and each new task folder starts with it. The task's **Verification** section shows it as **set for the team**. An agent cannot change it by editing its own files.
- **Each agent's own, written by the agent in its task folder**: no work check is set, so each agent writes its own check in its task folder's `init.sh`, and the task shows it as **written by the agent**. An agent that writes no check fails the check. This applies only to task-runner tasks; team chat work goes unchecked.

<Warning>

The command runs on your computer, in the task's folder or the team's folder, each time a task is checked. Set only a command you would run yourself.

</Warning>

See [How work is checked](/concepts/verification#the-verify-command-in-practice) for how the check runs.

## Rename a team

The dashboard has no rename control for a team: you name it on the customize step. To rename a team later, use the API call under **Under the hood** at the end of this page.

## Refresh a team's protocol

Each member's AGENTS.md lists the team and how to hand work to teammates. After you add or remove members, right-click the team's icon in the team rail and choose **Refresh Protocol**. Clawboo rebuilds that file for every member and keeps each member's routing rules.

Refresh Protocol needs the OpenClaw Gateway connected, even for a team with no OpenClaw members. Without it you see **Not connected to Gateway**. Only OpenClaw agents read AGENTS.md as instructions; on every runtime it also draws the team graph's links (see [Agents](/using/agents#edit-the-agent-files)).

## Archive a team

Right-click the team's icon in the team rail and choose **Archive**. The team leaves the list of teams for the rail's **Archived** group, which also puts its chats and its Home out of reach. Nothing is deleted: its agents, chats, tasks and the files in its team folder stay in Clawboo.

To bring a team back:

1. At the end of the team icons, click **Archived** (an archive icon with the number of archived teams). It appears only while a team is archived.
2. The archived teams show dimmed, each named with **(archived)** after it. Click the team, or right-click it.
3. Choose **Unarchive**. The team returns to the team rail.

## Delete a team

Right-click the team's icon in the team rail and choose how much to delete.

| Choice                 | What it deletes                                                         | Confirm button        |
| ---------------------- | ----------------------------------------------------------------------- | --------------------- |
| **Delete team only**   | The team. Its agents stay in Clawboo, with no team.                     | **Delete team**       |
| **Delete with agents** | Every agent on the team, with their files and own chats, then the team. | **Delete everything** |

Both choices also delete the team's rules, its brief, its rooms and your introduction to the team, and the team's folder (`~/clawboo-work/teams/<team id>`) with every file its agents saved there, and the link to it that an older version's `~/.clawboo/workspaces/<team id>` may hold. The confirmation says so: "The team's folder and the files its agents saved there are deleted too." If the folder cannot be removed, the team is still deleted, and a message says its team folder could not be removed.

Both choices stop whatever the team is doing first. Its runs end, a person's request still open on its board is cancelled with the work under it, and its other tasks stay on the board, where nothing can start them again. A result still on its way to one of its agents is dropped. The result stays on its task.

Its routines go different ways. An agent routine goes with its agent: with **Delete team only** it keeps its schedule and files its tasks with no team, in the shared `_no-team` folder, unless it runs one of the tasks the team left behind, and then its next run fails and stops it. With **Delete with agents** it is deleted with its agent. A team routine stays, and its next run fails with `The team this routine posts to no longer exists.`, which stops it until you delete it or point it at another team.

**Delete with agents** works without the OpenClaw Gateway. An OpenClaw member leaves the Gateway at once if it is connected, otherwise the next time Clawboo connects to it. If some agents cannot be deleted, the team is still deleted, and a message says how many agents were removed.

<Warning>

Deleting a team cannot be undone, and the files in its folder go with it. **Delete with agents** removes the agents for good, along with their files and their own chats.

</Warning>

## Troubleshooting

<AccordionGroup>

<Accordion title="Connect an OpenClaw Gateway to deploy the OpenClaw members">

**What it means:** you put a member on OpenClaw while the OpenClaw Gateway is offline.

**Fix:** connect the Gateway in **Settings > Runtimes**, or switch those members to another runtime on the customize step.

</Accordion>

<Accordion title="No agents could be created">

**What it means:** no agent in the template could be created. Clawboo removes the empty team it made for this deploy.

**Fix:** open **Settings > Runtimes**, check that the runtimes you picked are connected, then deploy again. If Clawboo could not remove the empty team, the message says so and the team stays in the team rail. Delete it there, or the next deploy adds a second team.

</Accordion>

<Accordion title="The new agents have a number after their names">

This is expected. A team or agents with the same names already exist, so Clawboo numbered the new ones to keep every name unique.

</Accordion>

<Accordion title="Refresh Protocol says Not connected to Gateway">

Refresh Protocol needs the OpenClaw Gateway connected, even for a team with no OpenClaw members. Connect it in **Settings > Runtimes**, then try again.

</Accordion>

<Accordion title="A team disappeared from the team rail">

The team was archived. Its agents, chats and tasks are still in Clawboo. Click **Archived** at the end of the team icons, click the team, and choose **Unarchive**. See [Archive a team](#archive-a-team).

</Accordion>

<Accordion title="The team does not follow a rule">

Rules apply from the next turn in the team's chats, not to replies already sent. Open the team's settings and check that the rule is in **Rules**. A Routine aimed at one agent runs without the team's rules; a team Routine follows them.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- **Files a deploy writes.** Each member gets a SOUL.md (its persona plus the default House Style personality), an IDENTITY.md, and an AGENTS.md that lists the teammates and how to hand them work. On an OpenClaw member, AGENTS.md also carries the catalog's tool notes. Which runtime reads which file is on [Agents](/using/agents#edit-the-agent-files).
- **OpenClaw config.** If any member's routing names a teammate, Clawboo turns on agent-to-agent messaging in the OpenClaw Gateway's config.
- **API calls.** `PATCH /api/teams/:id` renames a team or changes its Leader. It takes any of `name`, `icon`, `color`, `colorCollectionId`, `leaderAgentId` (an agent id, or `null` for no Leader) and `isArchived`. **Archive** and **Unarchive** in the team rail send `isArchived` through this same call.

```http
PATCH /api/teams/<team-id>
Content-Type: application/json

{ "name": "Growth" }
```

See the [Teams API reference](/reference/rest-api/teams) for every field, and the [REST API overview](/reference/rest-api/index) for how to call the API.

</Accordion>

## Next steps

- [Team chat](/using/team-chat): talk to your team, add rooms, and introduce yourself.
- [Agents](/using/agents): change one member's model, personality or files, or move it to another team.
- [Boo Zero](/using/boo-zero): how your team leader is chosen and what it reads.
- [Marketplace](/using/marketplace): find more teams and agents to deploy.
- [Teams API reference](/reference/rest-api/teams): every team route and field.
