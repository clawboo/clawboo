---
title: 'See how a team is doing on Home'
sidebarTitle: 'Home'
description: "One page per team, and one for all teams: what needs you, the team's goals and their progress, KPIs that say where each number came from, work in flight, spend, routines and the team's pages."
icon: 'house'
keywords:
  [
    'Home',
    'goals',
    'KPIs',
    'status line',
    'goal updates',
    'weekly updates',
    'pages',
    'team picker',
    'All teams',
    'progress',
    'health',
    'stale',
  ]
---

Home is the first row in the sidebar's nav. It shows how one team is doing, or how all of them are, on one page: a status line, what needs you, the team's goals with their progress, its KPIs, the work in flight, spend against budget, the routines coming up, its pinned pages and the files its agents made.

Every number on Home says where it came from: **computed** from the board, its runs and its budget, **reported** by an agent (named, with the run it came from), or **typed** by a person.

## Open Home

<Steps>

<Step title="Click Home">

Click **Home** in the sidebar. It opens on the team the sidebar shows, or on **All teams** when no team is picked.

</Step>

<Step title="Pick a team">

The picker beside the **Home** title works like the Board's: **All teams**, then each team. Clicking a team's icon in the team rail also opens Home on that team, and switches Home to it when Home is already open.

</Step>

</Steps>

## A team's Home

From top to bottom. A section with nothing in it is left out.

| Section               | What it shows                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status line**       | One sentence on where the team stands, with when it was written and who wrote it. By default Clawboo writes it from the board's numbers and run costs; see [The status line](#the-status-line).  |
| **Needs you**         | Tasks waiting on you (with the Board's reason, such as **Unassigned**), approvals and questions on the Board, goal updates an agent drafted, and KPIs an agent suggested.                        |
| **Goals**             | Each goal with its health, progress over its linked tasks, how many of the done ones passed their check, how the scope moved this week, its target date, drafts waiting, and **Update missing**. |
| **KPIs**              | One tile per KPI: its value in its unit, the target, which way is better, the window it reads, a bar toward the target, a badge naming its source, and a **Stale** mark when a value is late.    |
| **In flight**         | People's requests still open, each with how much of the work filed under it is done.                                                                                                             |
| **Spend**             | What the team's runs cost in the last 7 and 30 days, and its budget's spend against the limit when it has one. Estimates are counted and said.                                                   |
| **Upcoming routines** | The team's routines and its agents' routines, with when each runs next. **Routines** opens them in Settings.                                                                                     |
| **Pinned pages**      | The team pages pinned to Home, with who wrote the newest revision.                                                                                                                               |
| **Recent files**      | Files the agents' work left in task folders. Click one to open its task.                                                                                                                         |

Click a task anywhere on Home to open it in the same drawer the Board uses, over Home.

A team with no goals, KPIs or pages yet gets three prompts in their place: **Add a goal**, **Add a KPI** and **Write a page**. **New** in the header adds any of the three at any time, **Pages** lists every page of the team, pinned or not, and the gear opens [Home settings](#home-settings).

## All teams

With **All teams** picked, Home shows totals across teams (requests in flight, what needs you, tasks done this week, spend this week, active goals and how many are at risk or off track), one **Needs you** list for every team with each entry's team named, and a card per team with its status line, goals, first KPIs and spend. Click a team's card to switch the picker to it.

## Goals

A goal is something the team is working toward, such as "Launch the public beta". Goals are flat: a goal can sit under one other goal, and a goal with goals under it cannot sit under another.

<Steps>

<Step title="Add a goal">

Click **New**, then **Goal**, or **Add goal** on the Goals section. Give it a title and, if you like, a description (markdown), a goal to sit under, an owner (you or one of the team's agents), a target date, and how often an update is expected (every 7 days unless you change it).

</Step>

<Step title="Link work to it">

Pick the goal on a task: in the [task drawer](/using/board#the-task-drawer), in **New task** under **More options**, or in a team chat with **New requests count toward** above the message box. A request's work, and a task's subtasks, count toward the goal of the request or task they came from.

</Step>

<Step title="Keep it up to date">

Agents can draft an update on a goal; only a person publishes it. Drafts wait in **Needs you**. A goal with no update published in its cadence shows **Update missing**, and its health fades until one is.

</Step>

</Steps>

### A goal's page

Click a goal to open its page. It has:

- the description, owner, target date and how often an update is expected;
- its health, with who set it and when. Pick a health to set it yourself; **Health history** lists every change;
- **Progress**: done tasks over linked tasks, leaving out cancelled ones, with how many passed their check and how many were added and finished this week. A request's own card is not counted, only the work under it;
- **Cost of its tasks**: the sum of the linked tasks' run costs, saying so when it includes estimates;
- **Updates**: drafts to **Publish**, **Edit** (then publish) or **Discard**, then the published history. A draft can suggest a health; publishing it sets the goal's health. **Write an update** publishes your own at once;
- **Linked tasks**, each with its status, how it reaches the goal (linked itself, through its request, or through its parent task), whether its check passed, and its cost. Click one to open it;
- the goal's **KPIs**, the **Goals under it** and its **Pages**.

**Mark done**, **Drop** and **Archive** are in the goal's header. A done or dropped goal leaves the Goals list for **Done and dropped**, a folded list under it: open it to reach those goals, and **Reopen** one from its page. An archived goal leaves Home; its tasks keep their link.

## KPIs

A KPI is a number the team tracks, such as signups or how much it spent. A person defines each one once: its name, unit, which way is better, an optional target, the window it reads, and where its values come from.

| Source       | Where values come from                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Computed** | Worked out by Clawboo each time Home is read, from one of the metrics below. Nobody types it.                                                                                               |
| **An agent** | An agent reports it with its `report_kpi` tool. You can name the one agent who may, or let any agent on the team. Each value records the agent, the run and the task, and may carry a link. |
| **A person** | You type it: click the tile, then fill in **New value**, with an optional note and link.                                                                                                    |

The metrics a computed KPI can read:

| Metric                     | What it counts                                                         |
| -------------------------- | ---------------------------------------------------------------------- |
| **Tasks done**             | Tasks moved to Done in the window. Requests themselves are not counted |
| **Tasks done and checked** | Of those, the ones whose check passed                                  |
| **Requests finished**      | People's requests finished in the window                               |
| **Spend**                  | What the team's runs cost in the window, estimates included            |
| **Budget used**            | The team budget's spend over its limit, now                            |
| **Runs that succeeded**    | Finished runs that succeeded in the window, as a percent               |
| **Tasks waiting on you**   | Tasks waiting on a person, now                                         |
| **Median hours to done**   | Median hours from created to Done, for tasks done in the window        |
| **Open requests**          | People's requests still open, now                                      |

The window is the last 7, 30 or 90 days, or all time. The three "now" metrics read the state as it is and have no window.

An agent or person KPI can say how old a value may get. Past that, its tile shows **Stale**, with when the last value came in.

Click a tile to see the value now and where it came from, the values before it (who reported or typed each, with **Open its run** for an agent's), and **Edit** and **Archive**.

### Suggested KPIs

An agent can suggest a KPI, with why. It cannot define one or change a target. A suggestion waits in **Needs you**: **Review** opens it in the KPI editor, where you change what you like and **Accept** it, and **Dismiss** drops it.

## Pages

A page is a markdown note the team keeps, such as a launch checklist or a brand voice. Agents can write pages too, with their `write_page` tool.

Every change to a page's title or text makes a new revision, so nothing is overwritten; moving a page to another goal makes none. Open a page and click **History** to see each revision, newest first, with who wrote it (you, a person, or an agent in a run), when, and how long it is. A long history shows **Show older revisions** at the end. Pick one to read it, and **Restore this revision** to make a new revision that copies it. The pin in a page's header pins it to Home or unpins it, and **Archive** takes it off Home.

A page can belong to a goal; it then shows on that goal's page.

## The status line

By default Clawboo writes the status line from the board's numbers and the team's run costs each time Home is read, for example "2 requests in flight, 1 needs you, 3 done this week, $12 of $60 spent." It says **Computed from the board and runs** under it.

You can have the team lead write it instead, in [Home settings](#home-settings). The lead writes a new one only when the board changed since the last, at most every 6 hours and 4 times a day. Each is a model call; Home names the lead and the model under the line.

## Home settings

Open a team's Home and click the gear in the header.

- **Weekly goal updates**: **Turn on** makes a normal team routine that asks the lead, once a week, to draft an update for each active goal. The drafts wait in **Needs you** for you to publish. Change its time or turn it off in [Routines](/using/routines).
- **The lead writes the status line**: off by default, because it costs model calls. See [The status line](#the-status-line). It cannot be turned on for a team whose lead is an OpenClaw agent, which has no way to write it, or for a team with no lead; the switch says so.

## On the Board

- A task shows the goal it counts toward on its card: its own goal, or its request's or parent task's, which a dashed edge marks (hover for "through its request"). Team chat's task cards show it too.
- The task drawer has a **Goal** row: pick a goal of the task's team, or **No goal**. A task that counts toward its request's goal shows that goal first, with how it is linked; **No goal** takes it off that goal too. **Open** goes to the goal's page on Home.
- **Filter** lists the goals on the tasks in view, plus **No goal**, which leaves only work that counts toward no goal at all.

## On a phone

Home's sections stack in one column. A Needs you entry puts its reason above what it is about, and **New**, **Pages** and the gear move under the title.
