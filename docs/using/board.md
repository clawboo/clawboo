---
title: 'Track work on the board'
sidebarTitle: 'Board'
description: 'See every task your agents work on, act on what needs you, give an agent a task, steer a running task, and review what it made.'
icon: 'kanban'
keywords:
  [
    'kanban',
    'tasks',
    'Needs you',
    'calendar',
    'task drawer',
    'New task',
    'Retry',
    'steer',
    'comments',
    'reply',
    'follow-up task',
    'Workspace preview',
    'Filter',
    'Display',
    'All view',
  ]
---

The board shows every task your teams work on. Each task is a card, and its column says where it stands. Agents add and move cards as they work. You use the board to see what is happening, act on work that waits on you, give an agent a task, and steer one that is running.

The board opens on **Kanban**: every task by status, newest first. **Today**, **Week** and **Month** are calendar views that lay the same cards out by the day each was added or finished. Every task handed out in a [team chat](/using/team-chat) is a card here. How tasks, statuses and dependencies work underneath is explained in [The board](/concepts/the-board).

![The board on Kanban for all teams: five tasks that need a person lead the first column, each with its reason and one button, then Backlog, To do, In progress and Done, with Cancelled folded into a rail](/images/board-kanban.png)

## Track work in five steps

<Steps>

<Step title="Open the board">

Click **Board** in the sidebar, or press `Cmd+2` (`Ctrl+2` on Windows and Linux). The board opens on **Kanban** the first time, and on the view you picked after that. The team filter beside the **Board** title shows **All teams** or one team.

</Step>

<Step title="Read a card">

Each card shows the task's title and one row of details: the agent's face, a status mark such as **Verifying** or the cost, and when the task was added or finished. See [Read a card](#read-a-card).

</Step>

<Step title="Act on Needs you">

The first column, **Needs you**, holds approvals and tasks that will not move until you act. Each card says why it waits and carries the one button that gets it moving. See [Things that need you](#things-that-need-you).

</Step>

<Step title="Open a task">

Click a card to open its drawer: the agent's report, the brief, the task's properties, every run, comments with a box to reply to the agent, and live activity. See [The task drawer](#the-task-drawer).

</Step>

<Step title="Find a task">

Click the search button in the toolbar, press `/` while the board has focus, or press `Cmd+K` (`Ctrl+K`). Type part of a title, an agent's name or words from the details. **Enter** shows the card on the board, and **Shift+Enter** opens its drawer.

</Step>

</Steps>

## The header and toolbar

The header holds the **Board** title, the team filter, and **New task** (press `C`). When something changed while you were away, a chip beside the team filter says what; see **Since you last looked** under [Views and the calendar](#views-and-the-calendar).

The toolbar under it holds these controls, left to right:

| Control                    | What it does                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Needs you**              | Shows when the Needs you column is out of view, with its count. Click it to bring Needs you into view                                                                                      |
| Agents working             | Reads, for example, **2 agents working** while runs are going, with the faces of the agents at work. Click it to show only running work, and again to show everything                      |
| Search button              | Opens **Find** (`/` or `Cmd/Ctrl+K`)                                                                                                                                                       |
| **Filter**                 | Shows only some agents' tasks, tasks with **No agent**, or what is **Running now**. The button counts the filters that are on, and **Clear filters** turns them off                        |
| **Display**                | **Routine runs** (calendar views only) shows or hides upcoming routine runs. **Cancelled column** opens or folds Cancelled. **On cards** turns each card's **Cost** and **Time** on or off |
| View menu (names the view) | Switches between **Kanban**, **Today**, **Week** and **Month**, and lists each view's key                                                                                                  |

The filter applies to every column, Needs you included, and starts over when you change the team filter. **Find** still searches every task. When the filter hides every task, the board says "No tasks match these filters" with **Clear filters**.

On a calendar view, the left of the toolbar holds **Today**, the previous and next arrows, and the range title. On Kanban it reads "Every task by status, newest first". There is no refresh button: the board reloads itself every five seconds while it is on screen, and a small spinner shows only when a reload is slow.

## Columns and statuses

| Column          | What it holds                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Needs you**   | Approvals, and tasks that will not move until a person acts. In a calendar view its items sit in today's row                         |
| **Backlog**     | Tasks set aside for later. No agent picks them up until they move to **To do**                                                       |
| **To do**       | Tasks waiting for their agent and, in a calendar view, the upcoming runs of your routines. The **+** in its title opens **New task** |
| **In progress** | Tasks an agent is working on. A task whose work is being checked shows **Verifying**                                                 |
| **Done**        | Finished tasks                                                                                                                       |
| **Cancelled**   | Tasks that will not run again. The column starts folded into a narrow rail; click the rail to open it                                |

There is no Blocked column and no In review column. A blocked task always needs a person, so it sits in **Needs you**. A task under review stays in **In progress** with a **Verifying** mark. A task with a status the board does not recognize appears in an extra **Other** column.

Each column title has a small status mark in the column's color, and counts the tasks the column holds in the range on screen (every task on Kanban). An empty column shows no count, and an empty Kanban lane says so, for example "Nothing running".

### Read a card

Cards are neutral: color appears only in the status marks, and amber marks what needs you. A card shows the task's title, on up to two lines, and one row of details:

- **Agent**: the face of the agent that has the task. In **To do**, a dashed circle means no agent is bound to it.
- **Status mark**: **Verifying** while the work is checked. After a check, an amber cross means it failed, an amber dashed circle means it passed with debt (open issues noted), and a green check means it passed (until the card reaches Done). A card with no mark shows its cost here.
- **Cost**: what all of the task's runs cost, once a run has recorded a cost. A figure that starts with `~` is an estimate: the runtime reported no charge, so Clawboo priced the run itself. A cost under a cent reads `<$0.01`. When a status mark takes the cost's place, point at the card to see the cost. Which runtimes report real cost is in [Budgets and spend](/using/budgets-and-spend).
- **Subtask**: a small arrow when another task handed this one out and the card has no mark or cost to show. Otherwise the mark's or the cost's tooltip says it is a subtask.
- **Time**: on Kanban, how long ago the task was added or finished, such as "4m ago", "Yesterday" or "3d ago". A calendar view shows the clock time, and the Earlier row the date. A running task shows how long its current run has gone, after a small live dot. Point at the time for the full date.

**Display** > **On cards** turns the **Cost** and **Time** off and on for every card.

## Things that need you

**Needs you** collects everything that waits on a person, for the teams in the filter. It holds two kinds of item:

- **Approvals**: an agent wants to run a command, use a risky tool, or make a risky handoff. Answer them on their card. See [Approvals](/using/approvals).
- **Tasks that will not move by themselves**. Each card says why in amber, with the reason the run recorded when there is one, and shows the agent.

| Badge            | What happened                                                |
| ---------------- | ------------------------------------------------------------ |
| **Failed**       | The last run ended in an error                               |
| **Timed out**    | The agent stopped responding and its run was ended           |
| **Stopped**      | You pressed **Stop** on its run. It never restarts by itself |
| **Needs review** | Verification could not pass it                               |
| **Blocked**      | An agent marked it blocked                                   |
| **Unassigned**   | No agent is bound to it, so nobody will pick it up           |
| **Not started**  | It is in In progress with no agent, so no run is going       |

When several runs in a row failed, the badge counts them, for example **Failed 2×**. Each card has one button for the next step, and a **More** menu (the three dots) with the rest.

| Button     | Shows for                                                                                  | What it does                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retry**  | **Failed**, **Timed out**, **Stopped** or **Not started**, with an agent bound to the task | Puts the task back in **To do** and sends it straight to its agent. It works even after Clawboo has stopped retrying the task by itself                        |
| **Assign** | **Unassigned**, or one of those four with no agent bound to it                             | Lists the members of the task's team. The one you pick starts the task at once, and the task becomes yours (see [Give an agent a task](#give-an-agent-a-task)) |
| **Review** | **Needs review**                                                                           | Opens the task's drawer, where the check's result is                                                                                                           |
| **Open**   | **Blocked**, or a task neither **Retry** nor **Assign** can move                           | Opens the task's drawer                                                                                                                                        |

The **More** menu holds what the card's button does not: **Retry**, the team's agents under **Assign to** (or **Give to someone else** when the task is bound to an agent), and always **Dismiss**. **Dismiss** asks first, then moves the task to **Cancelled**, along with any later plan steps that were waiting on it.

**Retry** and **Assign** also leave a note in the task's comments. Tasks that failed the same way share one card that lists them, with **Retry all** and, in its **More** menu, **Dismiss all**, which asks first. When nothing waits, the column says "Nothing needs you right now". In Week and Month, Needs you shows three items, then **+N more**. While you look at another week or month, Needs you folds into a narrow rail with its count: click it to go back to today.

### When a task runs again by itself

If a run crashes or stops responding and its task goes back to **To do**, Clawboo starts it again by itself. After three unsuccessful runs in a row it stops trying, and the task waits in **Needs you** as **Failed 3×** or **Timed out 3×**. A task you stopped never restarts by itself. **Retry** always runs a task again, whatever its count.

When a task fails, the later plan steps that were waiting on it are cancelled. When an agent handed the task out, that agent is told, so nothing waits forever.

## Give an agent a task

<Steps>

<Step title="Open New task">

Click **New task** in the board's header, or press `C`. The **+** in the **To do** column's title opens it too.

</Step>

<Step title="Say what should get done">

Write one sentence under **What should get done?**, for example "Draft the launch announcement". It becomes the task's title.

</Step>

<Step title="Check the agent">

Beside **For**, Clawboo suggests an agent, with a note that says why: **Fits the task**, **Last used** or **Team lead**. To give the task to someone else, pick another agent from the list. Picking an agent also picks its team.

</Step>

<Step title="Add details if you need to">

**More options** opens **Team**, **Agent** and **Details**. Use **Details** for context, constraints, or a description of what done looks like.

</Step>

<Step title="Send it">

Press **Enter**, or click **Send to** followed by the agent's name.

</Step>

</Steps>

You should see the card appear in **To do** and move to **In progress** when the agent starts. If the agent is busy, the task waits in **To do** and starts when the agent is free.

How Clawboo picks the agent it suggests:

- It matches the words of your sentence against each agent's name and the role in its SOUL.md (see [Agents](/using/agents)). A word in the name counts more than one in the role, and forms of a word count as one, so "drafting" matches "drafts". OpenClaw agents, and agents whose SOUL.md states no role, match by name only.
- When nothing matches, it suggests the agent you last gave a task to in this browser, then the team lead, then the team's first agent.
- The list holds the agents of the team in the board's team filter. With **All teams**, it holds every team's agents, each with its team's name.

A task you give an agent this way is yours:

- Only that agent works on it. The agent is asked to do the work itself rather than hand it to a teammate. It is asked to make reasonable assumptions and note them instead of asking you questions, though you can still steer it with a reply.
- Its result goes on the task's card, on the board and in the team's General chat. It is not passed to the team leader.
- If the run fails, the card moves to **Needs you** with the reason.

**Assign** on a Needs you card works the same way for a task that has no agent.

## Steer a running task

Reply on a task to talk to the agent it belongs to. While the task runs, the agent reads your reply during the run where its runtime allows it. When the task waits on you, your reply starts the agent on it again, so answering a blocked task needs no click on **Retry**.

<Steps>

<Step title="Open the task">

Click its card to open the drawer. The reply box sits under **Comments** and reads **Reply to** followed by the agent's name. You can also open the task in a team chat's **Tasks** card (see [Team chat](/using/team-chat)), or in **Tasks & Routines** on the agent's page (see [Agents](/using/agents)), where the box reads **Comment or steer this task…**.

</Step>

<Step title="Check what sending does">

The line beside **Send** says what sending does for this task as it stands, for example that the agent gets it in the current run, or that sending starts the agent on it again.

</Step>

<Step title="Write and send">

Type your reply and press **Send** or **Enter** (`Shift+Enter` adds a new line).

</Step>

</Steps>

You should see your reply under **Comments** as **You**, with a note under it that says where it went.

| The task is                                                                                                     | What your reply does                                                                                                                                               | The note under it, for an agent named Ada                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| In progress, with a run working on it                                                                           | Goes into the run. Clawboo Native, Claude Code, Codex and OpenClaw take it before their next step without stopping. Hermes pauses its run, reads it and carries on | "Sent to Ada’s run", or "Ada will see this on the next run" when it could not get in |
| In **Needs you** (for example **Failed**, **Stopped**, **Blocked** or **Not started**), or waiting in **To do** | Starts the agent on the task again, as **Retry** does                                                                                                              | "Ada is starting on this"                                                            |
| A plan step still waiting for an earlier task                                                                   | Waits with the task                                                                                                                                                | "Ada will see this when the task it waits on is done"                                |
| Being checked (**Verifying**)                                                                                   | Waits for the agent to read after the check                                                                                                                        | "Ada will see this after the check"                                                  |
| In **Backlog**                                                                                                  | Waits for the agent to read when the task starts                                                                                                                   | "Ada will see this on the next run"                                                  |
| **Done** or **Cancelled**                                                                                       | Is not sent, because the task cannot run again. The note offers **Send as a follow-up task**                                                                       | "Not sent: the task is finished"                                                     |
| With no agent                                                                                                   | Is saved on the task only                                                                                                                                          | "Not sent: no agent has this task"                                                   |

When a reply starts a task again, Clawboo adds the note "Started again for a person’s reply." to its comments. Replies you send within 15 seconds of each other start one run, not one each. The note under a reply is not saved with it: it shows until you close the task.

**Send as a follow-up task** gives the same agent a new task, named after the finished one (for example "Follow up: Draft the launch post"). Your reply becomes its brief, the finished task is its **Parent**, and it goes to the agent like a task you add with **New task**. The note then reads "Sent as a follow-up task for Ada".

Every reply to a task that has an agent and is not finished also goes into the agent's mailbox. If a run cannot take it in time, the agent reads it from there when its next run starts. The agent receives the first 1,000 characters of a reply, and the task keeps all of it. How each runtime takes a reply mid-run, including older Codex versions, is in [Choose a runtime](/runtimes/index).

## The task drawer

Click any card to open its drawer on the right. It reads like a document: the task's title, with its status, agent and team under it. Press **Escape** or click outside it to close it.

To step through the card's column without closing the drawer, press `J` for the next task and `K` for the previous one, or use the up and down arrow buttons at the top of the drawer. The drawer shows where you are, for example "2 of 5". The keys do nothing while you type in a field or have a list open.

Each section folds from its heading, and a section with nothing in it is not shown. Top to bottom:

| Section            | What it shows                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs you          | Only for a task that waits on you: why, with **Retry**, **Assign to…** (**Give to someone else…** when an agent is bound to the task) and **Dismiss**              |
| The agent's report | What the agent reported, with its formatting, titled with its name, for example **Rin's report**                                                                   |
| **Brief**          | The task's details, when they say more than its title                                                                                                              |
| **Properties**     | **Status** (which you can change), **Runtime**, **Cost**, when it was **Added** and **Finished**, its **Parent** for a subtask, and the work it is **Part of**     |
| **Verification**   | After a check: **Passed**, **Failed** or **Passed with debt**, the check command and who chose it, who reviewed the work, and the latest attempt's findings        |
| **Workspace**      | The task's own git checkout, when it has one. See [Review what an agent built](#review-what-an-agent-built)                                                        |
| **Run history**    | Every run: its runtime, outcome, time, cost and tokens, and the error when it failed                                                                               |
| **Comments**       | Your replies and actions (**You**) and the notes Clawboo writes (**Clawboo**), then a box to reply to the agent. See [Steer a running task](#steer-a-running-task) |
| **Activity**       | The task's live tool calls, results and errors                                                                                                                     |

Click the **Parent** to open that task in the drawer. A run that is still going can show OpenClaw as its runtime in **Run history** until it ends. The drawer's cost is the same total as the card's, to four decimal places.

An image in the agent's report or its comments shows as a link named after its alt text, such as **Image: sales chart**. It opens in a new tab only when you click it. Clawboo never loads it by itself, so an agent cannot send data out in an image's address without your click. An address that is not a web or same-site one is only named, not linked.

![The task drawer open over the Kanban board: Rin's report, the brief, the task's properties, and a passed verification](/images/task-detail-drawer.png)

### Change a task's status

Use **Status** in the drawer's **Properties**, or drag the card to another column. Both follow the same rules:

- Only moves the board allows are offered. While you drag, columns that will not take the card are dimmed, and so is **Needs you**. Done and Cancelled cards cannot be moved.
- **In progress** is set only by an agent's run, so you cannot move a card there by hand.
- Moving a card to **Done** or **Cancelled** from a day other than today asks which day it finished: **Today**, the day it sits on, or **Another day**.
- Cancelling always asks first, because it cannot be undone. Later plan steps that were waiting on the task are cancelled with it.
- If an agent is still working on the task, the prompt says so. Moving the card to Done, Cancelled or To do stops that run. When an agent handed the task out, that agent is told a person decided it.
- Your move stands. After you move a card, its agent cannot change the task's status, block it or unblock it until a new run starts on the task. The agent is told the status is yours to set and not to try again. A run that starts after your move works the task as usual.
- A card moved back to **To do** goes back to its agent's queue, and a run that was going starts over from the beginning. A card with no agent waits in **Needs you** as **Unassigned**.
- If the task's stored check result cannot pass, moving it to **Done** asks you to confirm with **Complete anyway**. The override is recorded in the audit log.

Cards in **Needs you** move with their own buttons instead of by dragging. With a mouse, drag a card from anywhere on it. To drag with the keyboard, focus a card's handle and press **Space**, choose a column with the arrow keys, then press **Space** to drop it or **Escape** to cancel. On a touch screen, drag a card by its handle.

### Review what an agent built

The **Workspace** section shows only for a task that ran in its own git worktree: a separate checkout of a repository, made for that task. That happens for runs started through the API with a repository path, such as an agent routine created through the API. Work handed out in team chat, tasks you give from the board, and routines you create in the dashboard have no worktree, so their drawer has no **Workspace** section. Those runs start in the team's folder instead, which the agent's own **Workspace** tab shows under **Details** on its page. See [Worktrees and handoff](/concepts/worktrees-and-handoff).

For a task with a worktree, the section shows:

- the **Branch** (`clawboo/task-<id>`), the **Worktree** folder, and **Changes**: how many files changed, and the lines added and removed;
- under **System-of-record files**, the files Clawboo keeps in the worktree to track the task, such as `TASK.md` and `VERIFICATION.md`, each folded;
- the full **Diff** against where the branch started;
- a live view of the worktree's files, with change badges and what the agent touched last, when the task has an agent;
- a **Preview** of the page the agent built.

The **Preview** shows the worktree's `index.html` once the agent writes one, served as static files. Scripts do not run in the preview, so an app that needs JavaScript shows only its static shell. **Open** shows the page in a new tab. The preview checks for changes every 10 seconds while it is on screen.

Clawboo does not merge the branch. Review it and merge it yourself.

### When work is checked

Clawboo checks an agent's work in one case only: a run in its own git worktree that changed files. The check runs the task's verify command and, for a larger change or a handed-off task, a separate review by a model. Clawboo does not know your project's test command: the check fails until the `VERIFY_CMD` line in the worktree's `init.sh` names one. Work handed out in team chat, tasks you give from the board, and routines you create in the dashboard are not checked. A task with no check result reaches **Done** normally.

While a check runs, the card shows **Verifying**. A pass lands in **Done**, and a failed check sends the work back to the agent for another attempt. When the attempts run out, or the work passes with debt, the task goes to **Needs you**. It shows **Needs review** if its result cannot pass, or **Blocked** if it passed with debt. **Retry** runs the task again and clears the old result. See [Verification](/concepts/verification).

## Routine runs

In **Today**, **Week** and **Month**, the upcoming runs of your [routines](/using/routines) appear in **To do** on the days they will run. **Kanban** has no days, so it shows no runs. A run is not a task yet, so it is drawn as a dashed strip with the routine's name and time, not as a card. The next run on screen is drawn solid. A routine that runs several times a day shows once that day, with the number of runs.

Click a run to see the routine's schedule in plain words, where it goes, its next runs, and what happens when it runs. **Run now** starts it at once, and **Open routine** opens it to edit, pause or delete it.

When an agent routine runs, it becomes a task card on that day. A team routine posts to the team's General chat, and the tasks the team creates appear as they are made.

Only routines that will run show runs. A paused routine, one halted after a failed run, and a one-time routine that already ran have none, and neither do the OpenClaw Gateway's own scheduled jobs. **Routine runs** under **Display** shows or hides the runs, and its note says how many are coming up on screen. Times are in your local time, and when the server runs in another time zone, the schedule names that zone.

## Views and the calendar

Pick a view from the view menu at the right of the toolbar, which names the view you are on, or press its key:

| View       | Key | Rows                                                                                           |
| ---------- | --- | ---------------------------------------------------------------------------------------------- |
| **Kanban** | `K` | One row with every task, newest first. It has no days and no routine runs. This is the default |
| **Today**  | `D` | Today only, with the Earlier row above it. Every card shows                                    |
| **Week**   | `W` | The seven days of a week, starting on your locale's first weekday                              |
| **Month**  | `M` | Every day of a month                                                                           |

In a calendar view, a card sits on one day:

- Open work sits on the day it was added, and stays on that row as it moves from Backlog to To do to In progress.
- Finished work sits on the day it finished.
- Open work from before the range on screen is gathered in an **Earlier** row at the top, so nothing in play is hidden. It opens by itself when it holds running or waiting work.

The board remembers your view and your **Display** choices in this browser. The filter is not remembered.

<AccordionGroup>

<Accordion title="Reading the calendar">

- Lanes and cards are neutral. Each column's title carries its status mark in the column's color, and Needs you is amber.
- Today's date sits in a red circle. Weekends and the Earlier row are shaded.
- Pick a date in the day column to light its whole row. Pick it again, or press **Escape**, to put it out.
- A day with nothing on it folds into a thin line, and empty days in a row share one line. Click the line to open those days. Today never folds.
- A cell shows three cards (two in Month view), then **+N more**, which opens the rest in place. **Today** and **Kanban** show every card.
- A card an agent just added or moved fades in, so you can see what changed.
- A move you make shows one message saying what happened. When the card went to a day the board is not showing, the message has a **Show** button that takes you there.

</Accordion>

<Accordion title="Moving through time">

- In **Week** and **Month**, the **Today** button goes to the current week or month and brings today's row into view. While today is out of sight, a small arrow on the button points the way.
- The arrows beside it step one week or month back or forward.
- Click the range title, for example "Oct 25 to 31, 2026", to pick a date. A dot marks each day that holds a task. In **Today** view, picking a date opens that date's week.

</Accordion>

<Accordion title="Keyboard shortcuts">

With the board focused, these keys work. They do nothing while you type or while a dialog or the task drawer is open.

| Key                             | What it does                                                     |
| ------------------------------- | ---------------------------------------------------------------- |
| **C**                           | Open **New task**                                                |
| **K**, **D**, **W**, **M**      | Switch to Kanban, Today, Week or Month (**A** also opens Kanban) |
| **T**                           | Go to today (calendar views)                                     |
| **Left arrow**, **Right arrow** | Step one week or month back or forward (Week and Month)          |
| **/**                           | Open Find                                                        |
| **Escape**                      | Put out a lit day                                                |

**Cmd+K** (**Ctrl+K** on Windows and Linux) opens Find from anywhere on the board, even while you type in a field, but not while a dialog is open. In the task drawer, **J** and **K** step to the next and previous task. Every shortcut is listed in [Keyboard shortcuts](/reference/keyboard-shortcuts).

</Accordion>

<Accordion title="Find">

The search button in the toolbar, **/** or **Cmd+K** opens **Find**. Type part of a task's title, the name of its agent, words from its details, or the start of its id. Routines match by name, except on **Kanban**. In a calendar view, results are grouped by where they sit against the range on screen, for example **In this week**, **Before this week** and **After this week**, then **Routines**.

- **Enter** shows the task: the board moves to its day and highlights the card.
- **Shift+Enter** opens the task's drawer.
- **Enter** on a routine opens the routine.
- **Escape** closes Find.

</Accordion>

<Accordion title="Since you last looked">

Come back to the board after being away, and a chip beside the team filter says what changed meanwhile, for example "Since 2:10 PM: 3 done, 2 started, 1 new". It shows only when something changed. Cards that changed carry a small dot until you look at them. **Show** brings the oldest change you have not seen into view, and **Mark seen** clears the chip and every dot. Changes that sent work to **Needs you** are counted but not dotted, because Needs you lists them already.

</Accordion>

</AccordionGroup>

## Tasks in team chat

The same tasks appear in the team chat they came from: as cards in the conversation, and in the chat's **Tasks** card. General shows the tasks handed out in General, and each room shows only its own. The expand icon on a chat card, and **Open on Board** in the **Tasks** card, open the task here with its drawer open. See [Team chat](/using/team-chat).

## Troubleshooting

<AccordionGroup>

<Accordion title="A task has been In progress for a long time">

If an agent's run stops reporting, Clawboo ends it after a while and releases the task. The task then runs again by itself, or waits in **Needs you** as **Timed out**. The exact waits are in [Limits and defaults](/reference/limits-and-defaults). If the agent is working but slowly, reply on the task to steer it (see [Steer a running task](#steer-a-running-task)), or press **Stop** in its team chat.

</Accordion>

<Accordion title="A task reached Done with no check mark">

That is expected for most tasks. Clawboo checks work only for a run in its own git worktree that changed files, and a task with no check result reaches Done normally. See [When work is checked](#when-work-is-checked).

</Accordion>

<Accordion title="I cannot move a card to In progress">

Only an agent's run puts a task in progress, so the board does not offer that move. To start a task, move it to **To do** with an agent bound to it, or use **Retry** or **Assign** in **Needs you**.

</Accordion>

<Accordion title="Cards are missing from the board">

Check the **Filter** button: a number on it means a filter is on, and **Clear filters** turns it off. The agents-working chip turns on **Running now** too. Also check the team filter beside the **Board** title, and turn on **Cancelled column** under **Display** to see cancelled work.

</Accordion>

<Accordion title="A routine's runs are missing from the calendar">

Routine runs show only in **Today**, **Week** and **Month**, never on **Kanban**. Check that **Routine runs** under **Display** is on and that the routine is active in **Settings > Routines**. A paused routine, one halted after a failed run, and a one-time routine that already ran show no runs.

</Accordion>

<Accordion title="The board says it couldn’t load">

The board shows "Couldn’t load the board." when its first read fails. Click **Retry**. If it keeps failing, check that the Clawboo server is running; see [Troubleshooting](/help/troubleshooting).

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- The board reads `GET /api/board`, every five seconds while the tab is visible. The drawer reads `GET /api/board/:taskId`, `GET /api/board/:taskId/executions` and `GET /api/board/:taskId/workspace/detail`. The preview is served from `GET /api/board/:taskId/preview/`.
- **New task** is `POST /api/board` with an `assigneeAgentId`. It reads each agent's role from `GET /api/teams/member-roles`. **Retry**, **Assign** and replies are `POST /api/board/:taskId/retry`, `/assign` and `/comments`; the reply's answer carries a `delivery` field that says where it went. A status change is `PATCH /api/board/:taskId`, and a confirmed **Complete anyway** sends `humanOverride`, which is written to the audit log.
- A status change you make records its time on the task (`personMovedAt`). Until a run starts after that time, the agent's `update_task_status`, `block_task` and `unblock_task` tools are refused. See the [tasks tools](/reference/mcp-tools#tasks-server).
- The view and the **Display** choices are stored in this browser's local storage under `clawboo.board.calendar`, and the agent you last gave a task to, per team, under `clawboo.board.new-task-agents`.
- Full request and response shapes are in the [Board API](/reference/rest-api/board). How the board stores tasks and recovers stuck work is in [Board internals](/internals/board-internals).

</Accordion>

## Next steps

- [Team chat](/using/team-chat): give a team work and follow it beside the conversation.
- [Verification](/concepts/verification): when work is checked, and what to do with a result that cannot pass.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): where an agent's file changes go.
- [Routines](/using/routines): set up the recurring work that shows on the calendar.
- [Approvals](/using/approvals): answer the requests that appear in Needs you.
- [The board](/concepts/the-board): statuses, dependencies and recovery behind the cards.
