---
'clawboo': minor
---

A team now has chat rooms, a comment on a running task reaches the agent while it works, and the workspace around a team is rebuilt: a sidebar you can resize and hide, and cards beside every chat for its graph, tasks, browser and activity.

**Steer a running task.** Comment on a task from a team chat's Tasks card, or from Tasks & Routines on the agent's page, and the agent working on it reads the comment during the run, instead of only at its next one. Native agents, Claude Code, Codex and OpenClaw take it at the run's next step without stopping anything; Hermes pauses the run and resumes the same session with your comment. The comment always lands in the agent's mailbox as well, so a task that isn't running yet still gets it. Codex runs are now hosted in `codex app-server`, which is what lets them be steered; an older Codex without it falls back to `codex exec`, where a comment waits for the next run.

**Rooms.** Next to the team's own chat, now called General, a team can have rooms, each with a subset of its members. A room is its own conversation: its own transcript, its own task cards and its own graph, while Boo Zero still leads every room and the team's rules, brief, memory and board stay team-wide. Create a room from the sidebar's New room, then pin, rename or delete it from its menu. Deleting a room archives it: its conversation is kept and whatever it was working on stops.

**Clear chat.** Every chat's menu, General's included, can clear it. The messages are set aside rather than deleted, the agents start that conversation fresh (OpenClaw agents are sent `/reset`, as typing it does), and the chat's timeline stops showing the task cards made before the clear; they stay on the board and in the Tasks card.

**Sidebar.** Drag the agent column's edge to resize it (double-click resets it); drag it narrow enough, click its toggle or press Cmd+\ and it hides completely. While it is hidden, a toggle at the start of each page's header brings it back, and hovering that toggle shows the sidebar over the page without docking it. The top of the column shows the team's name, a search, and a grid of the team's agents with a dot on the ones working. Below them are the rooms, and the nav: Home, Org chart (the new name for Atlas), Board, Connectors, Memory, Marketplace and Settings. Fleet now lives in Settings, under Insights. Cmd+1 to Cmd+4 open Org chart, Board, Connectors and Memory.

**Cards beside the chat.** An agent's page puts its chat on the left and cards on the right, each toggled from the chat's header: Graph, Tasks & Routines, Browser, Activity and Details (its workspace, personality, permissions and files). Tasks & Routines shows the agent's tasks and the routines that send it work, with New routine set up for that agent. A team chat stacks a Browser window, the team's (or room's) graph, a Tasks card and Activity: the Tasks card sorts the team's work into Needs you, In progress, To do, Done and Cancelled, and opening a task shows its progress and comments, with the comment box that steers its agent and a button to open it on the Board.

**Home.** Each team has a Home page, the place its dashboards and its agents' artifacts will live.

**Org chart.** With the browser panel open, the radial org chart turns around Boo Zero to bring the team you pick next to the panel, and picking an agent steps it forward while its teammates make room. Closing the panel or switching team settles the team back. The turn is remembered; the focus is not.
