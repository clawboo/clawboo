# clawboo

## 0.7.0

### Minor Changes

- 3cf2d73: New connector: **Cua Driver** (category **Desktop**, Linux only) uses the apps on an agent's own screen through Clawboo's tool server: it lists windows, clicks, types and reads each app's accessibility tree. It runs only when agents run as their own OS user (`CLAWBOO_AGENT_USER`), like control links: it types into the agent's browser, which otherwise runs as you. Without it, agents still get their screen, the live view and their browser tools. Install it from an agent's **Screen** view, connect it, and give it to the agents that need it; it is not given to every agent. Each agent gets its own Cua Driver process on that agent's own screen, as the agent user when agents run as their own OS user, with a home folder of its own and the screen's own session bus, never your desktop session's. It runs only from Clawboo's own install, with its telemetry and update check turned off. A call that names no agent, or for an agent with no screen of its own, is refused rather than run against another screen, and while a person has taken over the screen its calls wait like the browser's. The tools that run code, start or stop programs or a browser of its own, install things, change its settings or move files between the computer and a website need Admin access, and the arguments with which it writes a file wherever they point are refused. **Connect** says when a program Clawboo installs itself is not installed, or not for this platform.
- 3cf2d73: On Linux, **Install the desktop tools** on an agent's **Screen** view installs the programs that give each agent a screen of its own into Clawboo's runtimes folder: TigerVNC's own Linux build of `Xvnc` 1.16.2 (x86_64) and Cua Driver 0.38.0 (x86_64 and arm64), each checked against a SHA-256 Clawboo pins as it downloads and before it is unpacked, and switched to only when everything worked. TigerVNC is GPL-2.0 and runs as a separate program; Cua Driver is MIT. An `Xvnc` from your distribution is still used first, and then no TigerVNC is downloaded. The offer appears only where it helps: on arm64, where TigerVNC publishes no build, the view says to install `Xvnc` with the package manager, and **Install Cua Driver** adds the driver alone once agents have a screen. Clawboo's copy of TigerVNC needs some system libraries and the system's keyboard compiler, which Clawboo does not install (on Debian and Ubuntu: `libxcvt0`, `libxshmfence1`, `libgbm1`, `x11-xkb-utils`, `xkb-data`), so when a display cannot start, the **Screen** view and `GET /api/agents/:agentId/computer` (`displays.problem`) name the missing file and, on Debian or Ubuntu, its package. New route: `POST /api/computer/tools/install` (a person's act, sensitive rate tier; a second request joins the install already running).
- 3cf2d73: Every agent now has a computer you can watch. The **Browser** card on an agent's page shows its browser live instead of the last screenshot it took, and falls back to that screenshot when no browser is open.

  On Linux each agent gets a display of its own: a virtual screen (TigerVNC's `Xvnc`) that its browser opens on, with Openbox as its window manager when Openbox is installed, run with a configuration Clawboo writes that has no menu and no key that starts a program. Find `Xvnc` on the server's `PATH` and Clawboo starts a display for an agent when its browser starts, and stops it 30 seconds after the browser closes. On a display you can **Take over** from **Screen** on the tab that shows the agent's files, or from its **Browser** card: the agent's own browser tools wait, with a message telling it a person is using its computer, while your mouse and keys go to its screen, until you **Hand back**, close the view, or leave it untouched for 10 minutes. One person has control at a time; the newest take over wins. The agent's other programs share its screen, so type a password there only for an agent you trust. On macOS and Windows, and on Linux without `Xvnc`, the live view shows the agent's browser about once a second, for watching only. Turn displays off with `CLAWBOO_AGENT_DISPLAYS=0`, and set their size with `CLAWBOO_AGENT_DISPLAY_SIZE` (1280x800 by default). There are never more displays than browsers (`CLAWBOO_MAX_AGENT_BROWSERS`).

  Nothing but the Clawboo server sees or drives a display. It listens on no TCP port: its VNC socket and its X cookie sit in a folder only the user who runs the agent's programs can enter (the agent user when `CLAWBOO_AGENT_USER` is set), and the server reaches the socket through a relay of that user's. Watchers get pictures of the screen from the server and never a connection to the display. All agents share one agent user, so one agent's programs can reach another agent's display: this keeps displays from other users on the machine and from Clawboo's own secrets, not agents from each other.

  You can make a **view link** to one agent's screen, for someone who has no way into your Clawboo, and, when agents run as their own OS user (`CLAWBOO_AGENT_USER`), a **control link**, for example for the person who must type their own password into a site the agent uses. Without that setting the agent's browser runs as you, and whoever took over could reach your files through a file dialog, so Clawboo does not make control links. A link reaches that one agent's screen and nothing else, from wherever the rest of Clawboo is reachable, and stops working when the agent is archived or deleted, even if another agent gets its id later. It expires (a view link after 8 hours and a control link after 1 hour by default, a day at most), you can revoke it, and revoking it closes every view open through it at once. A view link can never take over. One link opens at most two views, and links always leave places for the dashboard. Clawboo shows a link once, keeps only a fingerprint of it, and never writes it to a log: the link carries its token after `#`, which a browser does not send. A restart revokes every link.

  The tab on an agent's page that shows its files now has **Screen** and **Files**. It opens on **Screen** while the agent has a browser or display running. Each agent's browser profile now has Chrome's password manager turned off, so no password typed or filled into it is saved there.

  New routes: `GET /api/agents/:agentId/computer`, `GET /api/agents/:agentId/computer/live` (a stream), `POST /api/agents/:agentId/computer/control`, `POST /api/agents/:agentId/computer/input`, `POST`, `DELETE /api/agents/:agentId/computer/links`, `DELETE /api/agents/:agentId/computer/links/:linkId`, and for links, `GET /api/computer-link/info`, `GET /api/computer-link/live`, `POST /api/computer-link/control` and `POST /api/computer-link/input`. The capabilities answer has a new `agent.computer` flag.

- 5f3a5ab: Agents can now run as their own operating system user. Set `CLAWBOO_AGENT_USER` to a user created for them and every agent process (Claude Code, Codex and Hermes runs, Clawboo Native's approved commands and file tools, the verify command a task's check runs, git in task checkouts, connectors with local reach and each agent's browser) runs as that user, which cannot read Clawboo's database, the vault, its key, settings or the access token. Agents keep every tool: they reach Clawboo's MCP servers over HTTP as before. It is off unless you set it, and an install without it runs exactly as before. Not available on Windows.

  Clawboo starts one long-lived agent host as that user, through one sudoers rule on a computer or virtual machine (`doas` with `CLAWBOO_AGENT_SWITCH=doas`), or through the new `clawboo-launch` in a container, which works under `--security-opt no-new-privileges`. On Linux the agent host starts with `no_new_privs` where `setpriv` is installed. Before it accepts any run, Clawboo checks from inside the agent user's account that the database and its sidecars, the vault, the key, settings, the token, a listing of the data folder and your own login files cannot be opened, that the server's environment cannot be read and its command line shows no secret, that no file in the work folder is a hard link to a private file or a setuid file another user owns, and that the agent user cannot become another user through sudo or doas (it tries, rather than reading `sudo -l`). It refuses to start, saying what to change, when any of that fails, when the data folder is not the server user's alone, or when no access token is set. `clawboo agent-user plan` prints the setup commands for Linux or macOS, and `clawboo agent-user check` runs the check without starting the dashboard.

  With the setting on, the work folder and each agent's runtime home and browser profile live in the agent user's home, and the first start copies what agents already had there (never a link, a hard-linked file, a sign-in or key file, or Clawboo Native's history; the originals stay, so turning the setting off is the way back). Your own Codex and Hermes sign-ins are not shared with the agents: sign in for them from the Runtimes page, which runs as the agent user, or give the runtime an API key. Task checkouts come from a copy of each repository that the agent user owns, kept in step with git bundles, so an agent can no longer plant a hook in your repository; the task branch is brought back into your repository when the task pauses or completes, never over commits you made to it yourself, and a task whose branch could not be brought back is blocked rather than marked done. Connectors that hold a saved credential keep running as you, so agents cannot read their tokens. Clawboo stops every process the agent user runs when it starts, when the agent host stops answering, and when it stops, so the agent user must belong to one install.

  With the setting off, three safety fixes apply to everyone: pausing a task no longer removes a checkout git cannot account for, the safety checks of a checkout no longer trust a git setting that hides untracked files, and a commit id read from git is checked before it is used again.

- 6677cb9: An app that starts Clawboo itself, such as the desktop app, can now name the person behind each request it sends. It hands Clawboo its public key in `CLAWBOO_APP_LINK_PUBLIC_KEY` and signs a short token per request in the `clawboo-app-identity` header, for people whose ids start with `account:`. Such a request counts as that person's, so a message sent through the app can start work and records who asked, instead of reading as a local API call. The token works only for what the app signs: sending work, answering an approval and checking the link. These people can allow an approval once or deny it, but never allow it always. While the app's key is set, a sign-in proxy's token may not name an `account:` person, and a request that carries both kinds of token is refused; a sign-in proxy on its own works as before. A sign-in proxy's public key written on one line now also works when it ends in an escaped line break.
- 1f2026c: Boo Zero now asks before handing work to a team you did not name. In Boo Zero's chat, work starts straight away only on a team your message names, with @ or in your words. If Boo Zero picks another team itself, for example because of something it remembered or read, the hand-off waits on a card in the chat, and nothing starts until you press Accept.
- 3fcf39f: Agents can start each other with a comment, once you allow it. The first time a teammate's comment would start a task on a job, Needs you asks once: allow on this job, always allow in this team, or no. After that it goes, within limits: 12 wakes an hour on a job, and two agents answering each other stop after 4, across the team's jobs. A comment from you always wakes the agent at once.
- 149783b: Boo Zero can now hand work to a team from its own chat. Start a message with **@Team**, or say which team in plain words, and each hand-off becomes a task on that team's board, with its card in the chat and in the team's chat. When the task ends, the result comes back to Boo Zero's chat, even if Clawboo restarted in between, and Boo Zero tells you what came of it. With no team named, nothing starts and the chat asks which team, and a name that could mean two teams or teammates asks too. Your message is a request, with its own main task on each team's board, and it closes after Boo Zero's reply in this chat. On a team that asks first, several hand-offs in one reply wait for your answer. A hand-off also refuses plainly when the team or teammate is not there or is paused, or while Clawboo is stopping or updating, and a result under a pause waits and goes out on the resume. A hand-off shown in code or a quote starts nothing, so Boo Zero can show you a draft, and while reading a result it can go on only in that result's team. After you press Stop in this chat, a result that arrives starts no reply until your next message. This works on Clawboo Native, Claude Code, Codex and Hermes. An OpenClaw Boo Zero still cannot hand off from its chat, because the server only forwards that chat's replies to your browser and does not read them, and it says so.
- c1fa92b: **Pause an agent, a team or a task tree, and work now runs in a fair order.**

  A pause holds until you resume it, and it lasts through a restart. Use **Pause** in an agent's or a team chat's header, in a task's drawer, or from a right-click on the team rail or the Org chart. Its runs stop within seconds. A task whose run stopped goes back to To do and keeps its agent, every other task stays in its status, and nothing it covers starts: no task, no Routine and no wake. A message to a paused agent or team gets a line in the chat saying it did not start, so send it again after you resume. A reply on a paused task is kept, and the agent starts on it after the resume. A routine that falls due during a pause reads **on hold** and runs once on resume, and one a pause stops partway counts as neither a run nor a failure. **Resume** is on the banner in the chat and the task drawer, and waiting work starts again at once. A paused item carries a pause mark wherever it shows, and says who paused it. `GET` and `POST /api/pauses` and `DELETE /api/pauses/:kind/:id` are the routes, and the `board.pause` flag in `GET /api/system/capabilities` says a server has them. A 1:1 chat with an OpenClaw agent runs in the OpenClaw Gateway, so a pause does not cover it, and a team's work check already running finishes its command, though it starts no reviewer and no fix round.

  The order changed in both waiting lines. Ready tasks now go by: tasks that already ran and came back, then priority, then oldest first, so editing a task no longer moves it to the front. A task that keeps waiting reads one priority higher every 4 hours, up to **High**, so **Low** work gets through newer work, while a task someone marked **Urgent** still goes first. When every run slot is taken, a person's chat turn goes first, then tasks by priority, so an **Urgent** task is no longer stuck behind everything queued before it. A waiting run reads one level higher every 15 minutes, and while both kinds wait, one slot in every four goes to background work.

  An archived team's agents now stop working and nothing wakes them. Before, work left on its board kept starting. Bring the team back and its work starts again.

- 99ea7f7: **Retry** and **Assign** now record who asked on the note they leave, behind a sign-in proxy. A run your comment, answer or **Reopen** starts no longer shows its task as unread for you when the card moves, even some time later, such as when a hold lifts, while anything you had not read stays unread and what the agent does next is news as usual. A work check that fails after a comment's turn counts only its failures, so it says "failed once" rather than "failed 2 times". A run labelled `openclaw` by anything other than the team engine is no longer treated as the engine's: archiving a room leaves it alone, a restart does not time it out, and its delegator hears how it ended. An engine run recorded before this update still reads as the engine's. A Gateway rate limit whose message says "too many tokens" no longer gets the context-window advice, and is filed as a rate limit, as is that phrase with nothing to say which limit it means. The startup warning about Hermes's security scanner no longer appears in a Hermes agent's reply.
- 0c3bf36: A run's ending is now told apart, and retried only when a retry can help. An empty reply gets one more turn and then waits in Needs you as No result, so it no longer lands in Done unless a work check passed what it changed. A run that handed work out or used report_result is not an empty reply. A provider rate limit, overload or network error goes back to To do and tries again twice, after 30 and 60 seconds of awake time, holding no run slot or budget while it waits. Running out of room in team chat gets one continuation. Crashes and errors have separate limits. A budget cap or the circuit breaker stopping a run has its own status, so neither reads as your Stop any more, and a task waiting for room in a budget starts by itself when that room comes back.
- 22d489d: There is now an **Inbox** in the sidebar: what needs you and what changed since you last looked, with a badge that counts both. **Unread** lists tasks someone else changed or commented on since you last opened them; **Needs you**, **Mine** and **All** sit beside it. What you do yourself does not make a task unread for you, and an agent's progress does. Read state is kept on the server, per task, so it is the same in every browser and survives a restart. Behind a sign-in proxy each person has their own. The badge updates from the app's event stream, with no polling. An app installed on a phone gets nothing while it is closed, and catches up when you open it. The Board's "Since you last looked" chip stays in the browser as before, and a task you read in another browser stops counting in it.
- 82ccf6c: A job can no longer run away by itself. Clawboo now counts the runs each job starts on its own: follow-ups, wakes, fix rounds, extra turns, retries, plan steps, hand-offs and task updates. At 100 nothing more starts by itself. The work waits where it is, and the top of the job shows in Needs you with **Carry on**, which allows another 100, and **Stop**, which ends that job's runs and starts nothing more by itself, leaving other jobs alone. Your own messages, Retry, replies and Accept never count and are never refused, and a run a budget refuses before it starts does not count either.

  Other loops are closed too. A hand-off an agent wrote that could not be read no longer starts a turn: it says so on the card or in the chat, and the agent hears on its next run. Two agents answering each other now stay stopped until you answer while the wake that stopped is waiting, instead of starting again after an hour, and three agents in a ring are stopped the same way. A run that only commented and blocked no longer counts as progress, and neither does work it handed out that all failed. A failed check stays on a task that comes back by itself, so its fix rounds stay bounded and it cannot reach Done unchecked.

  Costs are charged where they belong. The reviewer asks the budget before it spends, takes a run slot on team work, and a drain waits for it. A one-to-one chat reading a team's results is asked about and charged to that team and job as well, and a refused hand-off there starts no paid turn.

  A follow-up now really is one. It takes every result that came back, each cut to fit with a pointer to the rest, and it sees what the agent reported before, since its reply replaces that. Your message goes ahead of updates waiting for the same agent, and those updates go as one once its turn ends.

- 9b87305: Your request is now one card on the board. When a team's lead hands out work for something you asked in chat, your message becomes a main task, with every hand-off and plan step nested under it as a sub-task, on the board and in the chat. The card shows how far the work has got. It waits for its sub-tasks and moves to Done after the lead's summary, which also goes to chat. A plain answer still makes nothing. A sub-task that needs you stays in Needs you, labelled with its request. To add to a request, comment on its main task; a new message in the chat is a new request. Cancelling a main task, or marking it Done, cancels the sub-tasks still open and stops their runs. Helpers keep every level of hand-offs they had, and a main task never runs by itself. Tasks from before this stay as they are.
- 07e85a8: Plans on the board. An agent can write a plan as a document on its task, with every revision kept and readable on the drawer's new Plan tab and in its later runs. A team can also turn on "Ask me before splitting work": a plan then waits in Needs you, and accepting it creates its steps and their order, once. Off by default, so plans start as they did.
- 8c7b8c2: Tasks now have readable ids and are made once.

  - **Readable ids.** A team's tasks read like `MAR-12`: letters from the team's name, unique across your Clawboo (a clash takes the next free set, like `MA2`), and a number. They show on cards, in the drawer and on task cards in chat, and the Tasks tools and Find take them. A person can change the letters in Team settings until the team's first task; a team rename never changes an id. Existing tasks get theirs the first time the server starts. A task with no team has none.
  - **One task per create.** The New task dialog, the Tasks tools and team-chat hand-offs send an idempotency key, kept in the database, so a retry returns the same task with `deduplicated: true`. An agent creating or handing off an open task with the same words under the same parent within 48 hours gets that task back, and is told. Blocked work, stopped work and a person's own creates are left out, and one turn asking two teammates the same thing makes a task for each.
  - **No circles.** An agent cannot hand work back to an agent waiting on it, on any path. The team's lead is exempt, because every agent is told to take a blocker there.
  - **Caps that hold.** The 8 hand-off cap counts a whole turn, not each tool call. Team-chat hand-offs now answer to the 24-child and 30-per-5-minutes caps, and a plan can have at most 25 steps. The failure breaker survives a restart. Only a person's cancel frees a child's place.
  - **Urgent is a person's call.** An agent stops at High through `create_task`, and so does a REST caller that is not the dashboard, on the board's routes and on a routine's task template.
  - **Labels.** Teams have labels, set in the task drawer, managed in Team settings, and filterable on the board.

  New routes: `GET`/`PUT /api/teams/:id/task-prefix`, `GET`/`POST /api/teams/:id/labels`, `PATCH`/`DELETE /api/teams/:id/labels/:labelId`, `PUT /api/board/:taskId/labels`. New capability flags: `board.readableIds`, `board.labels`. The `board` chat stream frame gains `identifier`.

- 9fe6307: The board now says what every waiting task waits for, and a person can be part of the work. An agent that blocks a task must give a reason, and Needs you shows it. A task waiting on another task or on its own sub-tasks stays out of Needs you and goes back to the queue when that work finishes. Tasks can be assigned to a person: they never start on their own, no agent can take them, and a Mine filter finds them. An agent can ask a person a question (a choice, a yes or no, or a list of tasks to accept or edit), which parks the task until the answer starts it again, or hand its task back to the person who asked for it. A person can reopen a finished task. On a local install, "a person" is one built-in person, and the check that a write came from the dashboard is a speed bump, not a boundary. See the security page.
- 9fc4881: Agents start when something happens on their task. Your comment, or a task it waits on finishing, is saved so a restart cannot lose it, and starts the right run once. A comment during a run reaches the agent at its next turn. A task that keeps running with nothing to show waits before it starts again by itself. After a Stop, a waiting report or comment is kept, starts nothing, and rides the next run.
- 06ae1fa: **Board writes now say who made them, and a person's writes go through one check.** Creating, claiming, moving, linking and commenting on a task record who did it, and so do Reopen, assigning a task to a person, answering a question, answering the card about agents waking each other, pausing, resuming, `ask_person` and `hand_back_task`. An agent's writes through the Tasks tools record the agent and its run, on the event and on its comments; a write from anyone else records that nothing says who it was. An OpenClaw agent's writes name no agent: its Gateway gives all of its agents one unsigned MCP address. Editing a task's title, description or priority and pausing a worktree record nothing.

  **Behaviour change for REST callers.** Moving a card, Retry, Assign, creating a task for a named agent, completing a worktree, answering an approval and setting a team's work check act for a person, so they now take that authority only from the dashboard's own page or from a person a sign-in proxy vouched for. Retry, Assign, `POST /api/board` with `assigneeAgentId` or a `sourceDelegationId` naming an agent, `PATCH /api/board/:taskId/workspace` with `complete`, approval answers (`POST /api/tools/approvals/:id/resolve`, `POST /api/capabilities/approve`, `POST /api/approvals`) and `PUT /api/team-verify-command/:teamId` refuse any other caller with `403 person_only`. `PATCH /api/board/:taskId` from another caller still moves the card, without a person's authority: it stops no run, cannot undo a person's move and cannot use `humanOverride`, and `POST /api/board/:taskId/executions` answers `409 person_moved` while a person's move stands. A script acting for you can send `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: cors`. The new `board.personCheck` capability says an engine does this. On your own computer this is a speed bump, not a security boundary: agents run as your user account and can send the same headers or read the access token. Behind a sign-in proxy in `required` mode, an agent holding the access token cannot use these routes, though one running as the same user can still change the database directly. If the check does not recognise you in the dashboard, usually because a proxy rewrites `Host` over plain http, the dashboard now says so and says what to do.

  Approvals now name their task when the run has one: a connector call's on Clawboo Native, Claude Code, Codex and Hermes, a Clawboo Native command's, an OpenClaw command's and a risky hand-off's card each record it, and the card shows it. An OpenClaw agent's connector card names none, because its Tools address is unsigned and shared.

  The audit log now records budget edits, with what changed and who asked, and writes the 80% and 100% warnings for team chat, one-to-one chat and peer-exchange spend, which used to write none.

- 43c35aa: Hermes now runs as the real, current Hermes, through its own gateway. Installing Hermes from **Settings** > **Runtimes** installs release 0.23.1 from GitHub into Clawboo's runtimes folder, with the uv and Python 3.14 builds that release pins for itself, each download checked against a pinned hash: no Python of your own, no pip or pipx, and nothing piped into a shell. A Hermes installed earlier with pip or pipx reads **Update needed** until you install Clawboo's own.

  Clawboo then runs one Hermes gateway with only its API server on, on `127.0.0.1` (port 8642, or the next free one; `CLAWBOO_HERMES_GATEWAY_PORT` sets it), keyed from the vault, and drives every Hermes agent through it, the way OpenClaw's agents run through OpenClaw's Gateway. It starts when Clawboo has Hermes agents or when one first works, restarts after a crash, stops with Clawboo, and shows in a Gateway section on the Hermes row. Each agent is a Hermes profile there, and its earlier Hermes home moves in on its first run, so its memory, skills and sessions carry over.

  A Hermes run now streams its text and tool calls, takes a comment into the running turn, reports its tokens, and asks before the commands Hermes's own policy flags: each question is an approval card in **Needs you** and the chat (each profile's `approvals.mode` is set before every run to the one your own `~/.hermes/config.yaml` chooses, else `manual`; the rest of a profile, its `command_allowlist` included, stays the agent's to change). Jobs a Hermes agent schedules in Hermes show in **Routines** under **Hermes's own jobs**, where you can disable, enable, run or delete them; team work stays a Routine and is refused through Hermes's scheduler. Hermes's chat channels stay off. Clawboo no longer starts `hermes acp` or `hermes chat`, and `CLAWBOO_HERMES_TRANSPORT` is gone.

  Clawboo's MCP servers accept a "live" attach URL that names only an agent and is bound, call by call, to that agent's run in progress, for a runtime that keeps one connection across runs.

- 4baaefd: A task that hands out work now waits for it. On a team chat run, a task whose run ends with sub-tasks still going no longer closes: the card reads "Waiting on 3 sub-tasks", and how many of those need you. When they have closed its agent gets one more turn with all their results, and the task is done after that turn, even if the server restarted in between. A sub-task that failed reaches that turn marked as failed, and the parent then comes to Needs you naming it, instead of closing as done. Retry that sub-task, and the parent starts again by itself once none is left unfinished. A team with a work check checks the parent at the end of that turn. After a Stop no such turn starts: the parent reads Stopped and offers Retry.

  Agents on a team chat run can say how a task went with the new `report_result` tool. It is a report, not a move: saying it is not done stops a Done and sends the task to Needs you, and saying it is done never gets past a failing check. An agent that never calls it behaves as before.

- abcedd6: You can now send a model provider's traffic through your own gateway or a company proxy, such as LiteLLM or an egress proxy. Set the provider's base URL with its environment variable (`OPENROUTER_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `XAI_BASE_URL`, `GROQ_BASE_URL`, `MISTRAL_BASE_URL`, `TOGETHER_BASE_URL`, `CEREBRAS_BASE_URL` or `MOONSHOT_BASE_URL`) or in the operator settings file, where the variable wins. Clawboo Native's runs, the key check when you save a key, and the model list all use it, so a key that works only through your gateway no longer reads as invalid and its models show up. Before, only Anthropic's and OpenAI's runs could be pointed elsewhere, and the key check and the model list always called the public address. Memory embeddings follow `OPENAI_BASE_URL` too. Startup warns about a base URL that would send a key over plain http to another machine. Settings > System > Deployment lists the providers an administrator pointed elsewhere.
- a01a574: OpenClaw, Claude Code and Codex now install into a folder Clawboo owns instead of npm's global folder, so an install no longer needs `sudo`, no longer fails with a permission error on a system-wide Node, and is not lost when nvm switches Node. The folder is `~/clawboo-runtimes`, or `<CLAWBOO_HOME>-runtimes` when `CLAWBOO_HOME` is set; `CLAWBOO_RUNTIMES_DIR` sets another. Each runtime runs on the Node it was installed with, the OpenClaw Gateway included. An update installs beside the current copy and switches only when it succeeds, so a failed one leaves the runtime as it was. A runtime you installed globally yourself keeps working when Clawboo has none of its own.

  OpenClaw's install checks Node first: on a Node outside OpenClaw's range (`>=24.22.1 <25 || >=26.12.1`) it says so and installs nothing, where npm used to install an older OpenClaw without a word. Claude Code now installs from a one-off `npx` run or a source checkout too. OpenClaw's setup also writes its tool sandbox as off, so OpenClaw's tools run on the same computer as your other agents rather than in a Docker container of its own; a sandbox you set up yourself is kept.

- 8e219b6: A computer or service that stops Clawboo when nobody is using it can now ask it, in one read, whether to: `GET /api/system/idle` says whether a person is here, whether an agent run is going, and when the next routine, OpenClaw cron job or Hermes job is due, so it can start Clawboo again just before. A person counts while a dashboard tab is visible and focused and someone touched it in the last 15 minutes, or opened or switched to it in the last 2 (the dashboard says so with `POST /api/system/presence`), and for a minute after they do something, such as answering an approval, sending a message or a comment, or starting or stopping work. Reads never count, and neither does an open tab's polling or a request a sign-in proxy merely vouched for.
- 8e219b6: Every task now gets a folder of its own for the files its agent makes. A task run with no git worktree (a task handed out in team chat, one you give from the board, a routine, or a research or review task on the task runner) starts in `<team folder>/tasks/<task id>`, so `~/clawboo-work/teams/<team id>/tasks/<task id>` by default (`_no-team` for a task with no team), created `0700`. Before, every such run started in the team's shared folder, so nothing tied a document to the task that made it. The run is told the folder is the task's own. Turns that hold no task, such as the lead's turns and an agent's own chat, still start in the team folder, and the task folders sit inside it, so the team's work check and deleting a team cover them as before. Clawboo Native's file tools are confined to the task's folder on a task run.

  The agent's **Computer** tab lists its tasks' folders beside their worktrees, newest first, then the team folder, and the task drawer shows a task's folder under **Files** (the section that was called **Workspace**), with the same read-only file view and the preview of a built page. `GET /api/board/:taskId/folder/tree` and `GET /api/board/:taskId/folder/file` read a task's folder, refusing links the way the worktree routes do; `GET /api/board/:taskId/workspace/detail` names the folder when the task has no worktree, and `GET /api/agents/:agentId/workspaces` lists `taskFolders`. A `research` or `review` kind now reads as isolation `folder` instead of `none`.

  At start, Clawboo removes the empty folders of finished tasks (Done, Cancelled or dropped) and keeps every folder that holds a file, since unlike a worktree there is no branch keeping that work; a live task's folder is never touched. Claude Code files a session under the folder it ran in, so Claude Code task sessions saved before this change are dropped once, and those tasks start a fresh session on their next run.

- 3cf2d73: Agents can now sign in to websites with a login they are never handed. Save a login under **Settings** > **Website logins** (the site, a username, a password and, if the site uses one, the setup key for its one-time codes), or connect your 1Password with a service account token (the first Connect downloads 1Password's SDK into Clawboo's runtimes folder, once; it is not part of Clawboo's own install). When an agent reaches a site's sign-in page, it calls the new `fill_login` tool and Clawboo fills the login straight into the agent's own browser. The agent is told only `filled`, `no saved login`, `needs you` or `refused`, and no username, password, code or token appears in that answer, the event log, the tool audit, the server's log or any REST answer. Logins are kept in Clawboo's encrypted vault and are never read back to the dashboard.

  A login fills only on a page whose live address, read from the browser, is exactly the login's: the same `https` scheme, host and port. Only the fields the page shows are filled, never one whose form sends it to another site, and the address is checked again in the same step that fills. A CAPTCHA, a passkey or a card check is left to a person: on a board task Clawboo hands the task back to the person who asked, so it shows under Needs you. A password filled into a page is masked out of that agent's later browser results.

  A run uses only its own person's logins: the person who started it (who sent the message, or pressed Retry or Assign on a runner task), else whoever asked for its task. Without a sign-in proxy the dashboard acts as its one person. A routine's run, the work a routine hands out, a task an agent made on its own and a request that failed the person check use no one's logins. `fill_login` is offered to Claude Code, Codex, Hermes and Clawboo Native agents, while the Playwright or Chrome DevTools connector is connected, and fills through it in the agent's own browser. The person checks above guard what Clawboo hands out; an agent can still read a field in its own page once it is filled. Whoever may use an agent can use what it holds: a sign-in a fill made stays in that agent's one browser for its later runs, and work an agent hands out under a task is that task's requester's. With `CLAWBOO_AGENT_USER` on, agents also cannot read the vault itself.

- 9f1b82a: Agent work now lives outside Clawboo's data folder, so `../..` from a team folder or a task checkout no longer leads to the database or the saved keys. Team folders, task worktrees and review checkouts go in the work folder: `~/clawboo-work` by default, `<CLAWBOO_HOME>-work` when `CLAWBOO_HOME` is set, or `CLAWBOO_WORK_DIR`, laid out as `teams/<team id>`, `worktrees/<repo hash>/<task id>` and `reviews/`. Agents still run as you and can open `~/.clawboo` by its full path: this removes the short route, not the access.

  On the first start, Clawboo moves what older versions made in `~/.clawboo/workspaces` and `~/.clawboo/worktrees` into the work folder. It only renames, never copies, and leaves a link at each old path. A checkout's uncommitted work is saved on the task's branch first (the commit a pause makes), the checkout moves with `git worktree move` (or a rename and `git worktree repair` when git refuses, such as for a locked one), and the board's records follow it. A paused task moves on paper and is rebuilt in the work folder when it resumes. Each step is journaled, so a crash or a stop at any point is finished or undone on the next start, and rolling back to 0.6 keeps working: it reads checkouts in the work folder and finds team folders through the links (its team-chat work check refuses a team folder there, until you upgrade again). Do not go back below 0.6.0 after the move. Something that cannot move (another volume, a checkout git does not list, one with a run still going, or something already at the new path) stays where it is, keeps working, and is tried again on the next start. While the move runs, `/api/health` answers `"status": "migrating"` with a count, and other requests get 503 with `Retry-After`. Claude Code files sessions by folder, so Claude Code agents start fresh sessions after their team folder moves; other runtimes keep theirs.

  Setting `CLAWBOO_WORK_DIR` to a new folder is treated as a move too: the next start moves this install's work there. Clawboo refuses to start with a work folder that is the data folder, sits inside it or contains it, and with a `CLAWBOO_WORK_DIR` it cannot create. When the default work folder cannot be created (a container with its data folder on a volume under a root-owned `/`, say), it keeps the old layout and says so; set `CLAWBOO_WORK_DIR` to move. Worktree cleanup in the work folder removes only checkouts this install made, marked by a small `.<task id>.owner` file beside each, so two installs can share one work folder.

  Clawboo also no longer follows a link, or a hard link, an agent puts at a task file's name (`AGENT_HANDOFF.json`, `init.sh`, `task-progress.md`, `VERIFICATION.md`): one reads as missing, and a write replaces the name instead of writing through it.

### Patch Changes

- 8e219b6: The tab on an agent's page that shows its files is now called **Computer** instead of **Workspace**, since a workspace means a whole Clawboo. Settings keeps its **Workspace** group. The folder picker on that tab is now labeled "Folder", and the task drawer's preview frame is titled "Task preview".
- a62013e: Fixes to the Inbox and the Board. **Mark seen** on the Board now marks read only the cards it is showing, so a card a filter or the date range hides stays unread in your Inbox. **Mark all read** waits until the team you picked has loaded, so it can no longer clear that team's tasks from the last team's list. In a task opened from **Needs you**, J and K step through **Needs you** rather than every task, and on **Unread** you can step back to a task you just read. Cancelling a task no longer brings the later steps it cancels back to you as unread, and neither does a run that archiving a chat room stops. Archiving a room now updates an open Inbox straight away. The Inbox badge also recovers by itself when a read hangs, and when the server comes back after being away. On a **Waiting for your OK** card, a task that also failed its check now says so and keeps **Review**, and **Always allow in this team** now means the team of the task the card is on. In a task's drawer, a teammate's comment now sits in **Comments** under their name rather than in the worker's report. If a team's setting for agents waking each other cannot be read, the switch says so and offers a retry. A comment a teammate left for a task that then finished no longer reaches that agent's next run. A comment written just before an agent asked its question no longer closes that question and starts the task when the two land in the same millisecond or the clock steps back, and one written just after now always does. After a crash, if Clawboo cannot yet tell whether a leftover agent process is its own, it now keeps the record and stops that process at a later start, rather than forgetting it.

  How a failure is named now agrees with what the run history files it under. A limit over a time window, such as "too many request tokens for this hour", counts as a rate limit, so a routine keeps its schedule through it instead of stopping. A failure that says only "too many tokens", or that names a quota or a usage limit, no longer tells you to change context-window settings: you see the reason it gave. A Hermes reply that opens with its own warning about the scanner keeps that line. **Mine** on the Board and in the Inbox fills in by itself when reading who you are failed the first time.

  Fixes to hand-offs from Boo Zero's chat. A hand-off now starts when the reply first mentions the syntax in code, and one on the line straight after a quote, or partway through a quoted sentence, is treated as shown rather than started. If one hand-off in a reply can be read and another cannot, the first starts and the chat says the other did not. Its card reads **Handing off to** while the reply is still being written, since nothing has started yet. A result Boo Zero reads no longer closes its request before the reply's hand-offs are decided, Stop ends the hand-offs a reply had not got to, and a result kept since a Stop stays out of your next message while a pause covers its team. A long-running chat still counts its old open work, several long results in one update are each cut to fit, and an @Team works whenever the server says this chat can hand off.

- 6052866: Fix several small issues found in review. A Stop in Boo Zero's chat now holds even when you send another message while its reply is still handing work out. An inch mark such as `5"` no longer stops a real hand-off from starting, and a hand-off shown in quotes or code is left as written. More wordings of a context-window overflow get the right advice. Pause cards name the button they show, and a reopened wake card alerts again. A failed check of an old agent at startup is no longer counted as reaped on every start.
- 7ac9de1: The task runner now handles a task its own agent blocked: the run ends as succeeded with the agent's reply kept, no "late result", the steps waiting on it left queued, the delegator told, and a worktree kept for a Retry. `block_task` with no id blocks the run's own task on these runs too. A crash while a task runner's work is being checked no longer leaves the card stuck on Verifying: the run stays open until the verdict, so a restart puts the task in Needs you. When Clawboo moves a deleted room's unfinished task, it also aborts that task's OpenClaw run in the Gateway, waiting for the Gateway to connect if needed.
- c309fe6: Fixes for what happens to a task across a pause, a Stop, a restart and a deleted team.

  - Deleting a team now stops its runs, and cancels its open requests with the work under them. Nothing starts its other tasks afterwards, and its folder stays gone. An agent routine stays with its agent and files its tasks with no team, unless it runs a task the team left behind, which now fails instead of running.
  - An agent's reply goes on the task when its work check starts, so a restart during the check no longer loses it, and whoever handed out the task is told what it said. If that write fails, the reply goes on when the check ends. `clawboo stop` and a drain now wait for a check under way.
  - A run left open on a Blocked task after its process died now ends within minutes, so what waited on it can go on.
  - A task update refused because other runs have set aside a budget's room now waits and goes out once there is room, in team chat and in a one-to-one chat, instead of being given up after a few tries, and the chat says it goes out by itself.
  - A task failing or being moved no longer cancels a person's message waiting on the same agent. A message of yours that never starts now says so in the chat.
  - A Stop now holds every task update still waiting, including ones a later sweep would have sent.
  - A pause keeps what a task's check found and how many fix rounds it has had, so the count no longer starts over on resume. A Stop also forgets what an ended round was told.
  - A hand-off refused because its request has closed now says so in the chat, and the agent that asked reads it on its next turn.
  - A comment you write on a paused task whose agent asked a question now starts the task on resume, as it does with no pause.

- c309fe6: Words that are not yours now reach Boo Zero marked as someone else's, and a request that fails the person check no longer gets to do what only you should.

  **Boo Zero's chat.** What an `@Team` message pulls in, Boo Zero's saved notes and a result kept since a Stop now reach it quoted, under who wrote them, and a saved note the injection scan catches is left out. A turn carrying a team's activity or a kept result can hand work only to that team, or to a team you picked above the box or named in the words you typed. Only those turns are held. Nothing holds a turn because of what Boo Zero recalled or read with its own tools, or it could never choose a team when you name none, and its session still holds what it read on earlier turns. You decide by reading the hand-off's card in the chat.

  **One-to-one chats have no write tools on the board.** On Claude Code, Codex, Hermes and Clawboo Native, a one-to-one chat now gets `get_task`, `list_tasks` and `add_comment`, limited to the agent's own team when it has one. A teamless Boo Zero reads every team and hands work out with its tags. Notices meant for an agent's team runs no longer arrive on your chat turn, and a comment from a chat wakes no one. Team runs no longer get `link_task`.

  **A request that fails the person check.** These now answer `403 person_only`, for anything but the dashboard or a person a sign-in proxy vouched for: a team's rules and what you tell it about yourself, which agent is Boo Zero (these three are now audited), Stop on a team's chat or a one-to-one chat, archiving or restoring a team, setting and resuming a budget, creating, changing, running or deleting a Routine or an OpenClaw cron job, and changing a task's title or description. Scripts that do these need the two `Sec-Fetch-` headers. Setting the Routines time zone stays open.

  The same goes for what decides whether anyone is asked, and for who is on a team. An agent's exec settings and shell switch. Creating, revoking or resuming a grant, revoking a standing exec grant, and approving a device. `PATCH /api/system/openclaw-config`, and configuring OpenClaw. Enabling or disabling a capability. Deleting a team (which also closes its open requests) or archiving a room, both now in the audit log. Adding an agent to a team, removing it (now a `404` for an agent not on that team), moving it, deleting it, and the two calls that drop agents from a list. Creating an agent with a team or with a say in how it is asked; a plain agent needs no check. Scripts that do these need the two `Sec-Fetch-` headers too.

  An MCP attach signature now names the server it is for, so a Memory URL's signature no longer opens the Tasks tools. Clawboo rewrites the URLs of its own runs each run. A signed URL you copied from `/api/mcp/config` for an external agent has to be copied again: until then it is served as an unverified caller.

  The chat message routes stay open without a person's authority. Such a message reads `Local API call` rather than `You`, records no one as asking, and does not reset a team's failure breaker. In a one-to-one chat it starts no work, does not end the hold a Stop left, and does not read results waiting for you.

  `POST /api/runtimes/:id/run` without the check no longer undoes a person's move or a Stop: it answers `409` with the reason, as the board's automatic start would. A comment posted without the check loses its `authorAgentId`, and a comment whose author is on no roster now reads as "an agent" rather than whatever id it carried. Notices in an agent's mailbox now say who wrote them instead of all reading as Clawboo, a task title in a notice stays on one line, and a teammate's comment on a job you said No on no longer lands in the agent's mailbox. A person's cancel now marks what waited on the task as cancelled by that person.

- fa0613b: A team-chat work check now waits while a teammate is still working in the team folder, so it no longer runs in the middle of a change a teammate is making, which could fail the check and send the fix note to the wrong agent. It waits for other runs of the team in any room, in a 1:1 chat and on the task runner when the run has no worktree, and for another task's check, so two tasks that finish together are checked one after the other. The card reads **Waiting to check**, and a comment says who it is waiting for. After 15 minutes the check runs anyway and says so in a comment and in its result. A waiting check takes no run slot and no budget and never delays a teammate's start. A person's move or **Stop** ends the wait. **Stop** puts the task back in **To do** with the agent's report kept, and a restart hands the task to a person and tells whoever handed it out. Saving the folder now tries again when a file disappears as it is read, so a busy folder no longer lets finished work reach **Done** unchecked. This does not keep teammates' work apart: what a teammate changes while a task runs is still part of that task's measured change, and a run that starts after a check began can still change the folder under it.
- 8e219b6: The server answers sooner after it starts. Its startup check of the database ran SQLite's full integrity check on the main thread right after it began listening, so on a large database every request, the dashboard's first page included, waited several seconds for it. The startup check is now SQLite's quick check, in a background thread; the full one runs the same way once a day and on **Re-run probe** in **System Health**. A check that cannot run there, or runs out of time, reads as degraded rather than as damage. `clawboo` also keeps Node's compiled copy of the server between starts, in `~/.clawboo/cache/compile`.
- 156fca1: A one-to-one chat no longer resumes a session that outgrew the model's context window. On Claude Code, Codex and Hermes the next message starts fresh, and one notice in the chat says the agent is no longer carrying the conversation, or that the turn was too large if it was the conversation's first. Clawboo Native keeps the session while trimming its oldest turns can make real room, and says so, and drops it, with the same notice, when trimming could not. It also drops it, giving the provider's reason, when a provider refuses a resumed turn in words Clawboo does not recognize and sending the conversation again could only fail the same way. Team chat now says when an agent's session was dropped this way, and such a turn no longer shows advice about a wrong context-window setting, which stays for OpenClaw. Hermes and Codex on `codex exec` now report a context overflow as `context_overflow`, so a board task on them starts fresh on its next run too. A failed quiet Hermes run gives its reason instead of its session id or a startup warning, and an overflow Hermes recovered from, or one a sub-agent hit, no longer reads as the cause of a later failure. Claude Code's `blocking_limit` and `rapid_refill_breaker` endings now count as out of room, like `prompt_too_long`, and Claude Code's own text for these endings no longer appears as the agent's reply in team chat: it goes on the board as the failure's detail. A rate limit whose message says "too many tokens" is no longer read as a context overflow on Clawboo Native or `codex exec`: it shows its own reason and counts as a rate limit. A resumed run that hits a rate limit or an overload now keeps its session on every runtime, in one-to-one chat and team chat. A context overflow is now always filed as one, even when a token count in its message looks like a status code. A chat notice written in the same millisecond as the reply before it no longer disappears from the chat.
- af5ec22: **Retry** now rescues a board task whose Claude Code run outgrew the model's context window. Such a run ends as out of room, and the task is blocked. Until now its session was kept for the task's next run, so every Retry continued the session that had overflowed, which overflowed again and blocked the task again. Now a run in team chat that reports a context overflow leaves no session behind, and the next run starts fresh. Claude Code, Codex in both its modes, Hermes and Clawboo Native report one; for all of them but Claude Code this saves one failed Retry. A task already blocked this way before the update overflows once more on its first Retry, which drops the session, and the Retry after that starts fresh.
- dd3c4fb: A provider key set in the environment Clawboo is started with, such as `ANTHROPIC_API_KEY`, now shows as connected on the Providers page, where it used to read as not connected even though runs used it. The row says the key comes from the environment and offers no Update or Disconnect, since the dashboard cannot change it; when a saved key exists too, it says the one in the environment is used first. Setting up OpenClaw still reuses only a saved key, so a key from the environment is never written to disk.
- 43c35aa: Task comment and team chat events now keep their author fields (`authorType` and `authorAgentId`) readable in the event log API and in tool call records, instead of storing them as `[REDACTED]`. The secret masking treated any field whose name contains "auth" as a credential, so these fields were blanked along with real keys. Fields that hold credentials, such as `authorization`, `auth` and access tokens, are still masked. Events saved before this update keep the masked value.
- 90ab3d6: Setting the time zone Routines run in now takes the person check, like creating or changing a Routine. An agent or a script nothing vouches for can no longer move every Routine's next run.
- 8e219b6: A due routine that runs on an OpenClaw agent, or a team routine whose message goes to one, now waits up to 5 minutes for the Gateway to connect instead of failing on it. Right after Clawboo starts, the Gateway connects a few seconds later, so a routine that came due while Clawboo was stopped or the computer was asleep used to fail and wait for its next time; it now runs once the Gateway is back, as other routines already did. The wait carries over a restart, and the idle read counts a waiting routine as work under way, so stopping and starting Clawboo for it cannot loop. The schedules list also says when no OpenClaw Gateway is set up at all (`not_configured`), rather than reporting one that is set up but disconnected.

## 0.6.0

### Minor Changes

- c9215fb: Restore archived teams and move agents between teams from the dashboard.

  **Archived teams.** The team rail ends with an **Archived** group listing archived teams, which were otherwise shown nowhere. Click one and choose **Unarchive** to bring it back.

  **Move to team.** Right-click an agent on the Org chart or a team graph and choose **Move to team**. The move happens in one step through the new `POST /api/agents/:agentId/move`: the agent's own routines go with it, tasks it has not started stay on the old team's board unassigned instead of firing at an agent that left, and its old rooms and session state are cleared. A routine bound to one of the old team's tasks is paused there instead of moving. A team's lead, Boo Zero and an agent with a task in progress or in review cannot be moved.

- 6ce571a: The Board is calmer and easier to read. It opens on Kanban, a dense status board with Needs you first, and keeps Today, Week and Month as its calendar views; a view you already picked is kept. Cards and lanes are neutral, with colour only in each column's status mark and amber for what needs you. Titles are 14px, times and costs use plain figures, and cards no longer tint, clip, lift on hover or roll their counts. The header is one bar: the title, the team, the Star and New task (C). The toolbar holds Find (/ or Cmd+K), Filter (by agent, tasks nobody has, or what is running now), Display (routine runs, the Cancelled column, cost and time on cards) and the view menu. A Needs you card shows why it waits and one action, with the rest in its menu. The task drawer reads like a document: the agent's report once, as markdown, then the brief, the properties, verification, the workspace, run history, comments and activity, each folding from its heading, and J and K step through the column. Loading, empty and filtered states match the board.
- 9bbe4f9: New task on the board now starts with one field: write what should get done and press Enter. It suggests who should do it by matching your words to each agent's name and the role in its SOUL.md, and otherwise suggests the agent you last gave a task to, then the team lead. A note beside the agent says why, and you can pick someone else; picking an agent also picks its team, so with the board showing all teams you no longer choose a team first. More options opens the full form with Team, Agent and Details.
- 2e81142: Runs that start at the same time no longer take a hard-cap budget past its limit together. Each run now holds its estimated cost on every budget it counts toward from the moment it is let start until it ends: task and API runs, agent routines, team chat, one-to-one chat and peer exchanges. On a nearly spent hard cap, a run that would go beside others starts only if the spend, what they hold and its own estimate fit under the limit; otherwise it is refused with "The <scope> budget is close to its hard cap, and runs already going have set aside the rest of it, so this run did not start." Each run is checked again right before it calls the model, its real cost replaces the estimate as it is recorded, and its hold goes when it ends, however it ends. Holds left by a server that stopped mid-run are dropped at the next start. The estimate is the most one of the agent's last ten runs cost, or 50 cents for a new agent, so a run can still cost more than it held. A run going alone and every warn-only budget, the default, behave as before. Usage on a model with no known price is held and charged at the default rate and follows the budget's mode. A task run refused this way answers `422` with `budget_held`, and an agent routine refused this way keeps its schedule.

  One-to-one chat with a Clawboo Native, Claude Code, Codex or Hermes agent now shows in **Tokens Used**: every turn that calls a model writes the same cost record a team-chat run does, from the runtime's own figures where it gives them and estimated from the text where it does not, whether or not the agent has a budget.

- 869c908: Budgets in Settings > Insights > Governance are now set by name. Pick agent, team or mission, then choose from a list you can search: agents show their team, so two agents with the same name stay apart, teams leave out archived ones, and missions list the top-level board tasks, newest first. You no longer need to look up an id first. Each budget shows the agent, team or task name, and shows the id once that agent, team or task is gone. The form no longer offers tenant, since nothing charges a tenant budget; any tenant budget you already have still shows.
- c9215fb: Choose who can use a connector from its own page, and give an agent that asked for one the access it asked for.

  **Who can use it?** Connecting a connector gives it to nobody, and the only way to give an agent access was to draw it on the Org chart, which the connector page never mentioned. A connected connector's page now lists your agents under **Who can use it?**, shows who already has access, and gives the agents you pick write access with risky calls asking first. The page no longer says a connected connector's tools are available to your agents.

  **An agent's request.** The card an agent posts when it needs a connector now carries that agent to the connector's page. The agent is preselected there and gets access as soon as the connector is connected, unless you took its access away before: then it stays preselected and only **Give access** shares it again. An OpenClaw agent, which a shared connector cannot reach, is never preselected or shared. The card counts a connector as done only once that agent can use it, and offers **Share** for a connector that is connected but not shared with it, so **Continue** no longer wakes an agent that still cannot reach the connector.

- 1363da2: The dashboard now locks itself to your computer by default, with a token only your user account can read, and the browser opens signed in.

  **A token for every install.** With `STUDIO_ACCESS_TOKEN` unset, the server makes a random token on its first start and keeps it in `~/.clawboo/access-token` (it follows `CLAWBOO_HOME`), readable only by you. Every `/api/` route and the Gateway WebSocket then need the `clawboo_access` cookie, as they always have with a token set. Other user accounts on the computer can no longer use the API. A program running as you still can: it can read the file as easily as it can read your database. The file is one per user account, not per app, so the Clawboo desktop app can use the same token. A file Clawboo cannot trust (not a regular file, readable by others and not narrowable, or not a valid token) stops the server with a `SECURITY: refusing to start` error that names it; delete the file to get a new token. `STUDIO_ACCESS_TOKEN` still wins when set, and a blank one (`STUDIO_ACCESS_TOKEN=`) still runs with no gate at all. `pnpm dev` runs with no gate. A network bind (`HOST=0.0.0.0`) now starts with the per-install token instead of refusing to start for want of one.

  **Signed in without the token in a URL.** `clawboo` and `clawboo restart` open the browser with a one-time sign-in link (`?access_code=`) that works once, within two minutes, so the token never appears in a URL, the browser's history or the opener's command line. The terminal shows only the plain address, now `http://127.0.0.1:<port>` instead of `localhost`, which can resolve to `::1`, where another program could listen on the same port. The CLI sends the token only to the port the server recorded in `api-port.txt`, so a program imitating the access gate on another port never receives it, and that includes a `STUDIO_ACCESS_TOKEN` you set in the shell. A sign-in link is spent only by a browser loading it as a page, or by the **Sign in** button of the small page a browser gets when it sends no fetch metadata (as it does not on a plain-HTTP network address, so a phone can still scan the QR code): a chat app fetching it for a preview does not spend it. The new `clawboo open` opens a signed-in browser on a running server, and `clawboo open --print` prints a one-time link instead, for a browser it cannot open, such as on a server with no desktop. When no browser opens, `clawboo` says to run `clawboo open --print` instead of failing silently. With `STUDIO_ACCESS_TOKEN` unset, the CLI reads the token file to reach the server.

  **The dashboard.** A browser without the cookie gets one screen, "This dashboard is locked to your computer", which names `clawboo open`, instead of a dashboard full of failed reads. **Open on another device**, at the bottom of the sidebar, makes a one-time link for another browser, with a QR code for a phone when the dashboard's address is one a phone can reach.

  **For scripts.** `POST /api/access/launch-code` (behind the gate) answers `{ gated, code, expiresAt, expiresInMs }`. The gate's `401` now says ``Clawboo access token required. Run `clawboo open` on the computer running Clawboo, or open /?access_token=<token> once to set a cookie.`` and carries `"gate": "clawboo-access"`. A script that calls the API of a default install needs the cookie, made from `~/.clawboo/access-token`.

- 2edd13b: `clawboo stop`, `clawboo restart` and the in-app update now wait for agent runs to finish instead of cutting them off.

  **Stop and restart wait for agents.** Before they stop the server, `clawboo stop` and `clawboo restart` hold it, so it starts no new agent run, and wait up to 10 minutes for the runs already going. The spinner says how many are left. At the bound they stop anyway. `--wait <seconds>` sets the bound, `--force` stops at once as before, and Ctrl+C cancels the wait and leaves the server running (exit code 130). A server too old to be held is stopped at once; one that does not answer the request to hold it is not stopped, and the command exits 1.

  **The in-app update waits too.** Once the new version is installed, the server waits up to 10 minutes for the agent runs still going before it restarts, and no new run starts in the meantime (nor during the first 5 minutes of the install). The update chip reads "Waiting for N agent runs to finish before restarting." and offers **Restart now**. A failed install lets work start again. One update runs at a time: a second request while one runs is refused with `IN_PROGRESS`.

  **Your own stop scripts can do the same.** `POST /api/system/hold` holds the server under an owner id you pick, `GET /api/system/hold` says whether any agent run is still going (`backgroundWork: "present"` or `"none"`), and `DELETE /api/system/hold/:owner` releases it. Only the owner that placed a hold releases it, and a hold lapses after 60 seconds (5 seconds to 15 minutes with `ttlSeconds`) unless it is placed again, so a stop script that crashes cannot leave the server held. `self-update` is the in-app update's own owner id. While held, every run the server would start waits in the run queue, tasks agents hand each other stay in To do, and a Routine that falls due fires once the hold lifts or the server starts again. A 1:1 chat with an OpenClaw agent runs in the OpenClaw Gateway, outside the hold. The new `system.hold` flag in `GET /api/system/capabilities` says a server has it.

- ae47b2b: Clients can ask the server which version and features it has.

  **`GET /api/system/capabilities`** answers with the running version, a client API revision, the oldest release whose clients the server still serves, and a flag for each optional feature: the runtimes it can run, chat rooms, 1:1 chats, the check on finished work, comments that reach a running task, the workspace view and preview, routines, memory and similarity search, connectors, and which event streams resume from `Last-Event-ID`. It reads nothing from disk beyond the version, writes nothing, and sits behind the origin check and access token like every other `/api` route.

  **A server supports clients of its current and previous minor release.** Nothing a client in that window uses is removed or renamed; when something has to go, it goes in a minor release and the API revision goes up. The new Supported versions page explains the window, how a client checks it, and what the npm install, the desktop app and the phone web app each offer.

  **The in-app update confirms the new version before it reloads.** After an update the dashboard used to reload once any server answered the settings route. It now reads the new route and reloads once a server on a different version answers.

  **A contract test pins what clients rely on**: the capabilities answer, every API route and method, and the events and fields of the team chat, 1:1 chat and event streams. Removing or renaming any of them fails the test unless the API revision goes up.

- e1ca85f: Clawboo can send a browser notification when something new needs you while its tab is in the background: a task whose run failed or stopped responding, one an agent marked blocked, work that did not pass its checks, and an agent waiting for your approval. The board offers it once, with an explanation, and asks the browser only when you click Turn on. Several arrivals at once make one alert, and a click opens the task or Needs you. Turn it off or send a test alert in Settings, under System. The Clawboo desktop app keeps using its own notifications. The task drawer is quieter too: an empty Activity box is one line, the Live mark no longer covers the first event, and opening a task without a worktree no longer logs an error. Panel titles and section labels now use the type scale and the muted text colour.
- 6f0cfca: Admins who deploy Clawboo for a team can pin settings in one file.

  Put a JSON file at `~/.clawboo/operator.json`, or anywhere with `CLAWBOO_OPERATOR_SETTINGS` pointing at it. Every key also has an environment variable, which wins over the file. The first keys are `disableSelfUpdate` (`CLAWBOO_DISABLE_SELF_UPDATE`), `disableBrowserAutostart` (`CLAWBOO_DISABLE_BROWSER_AUTOSTART`) and `catalogIndexUrl` (`CLAWBOO_CATALOG_INDEX_URL`).

  A pinned setting applies to everyone. The new **Deployment** card in **Settings** > **System** shows each setting, and a pinned one reads "Set by your administrator" with no way to change it there. `GET /api/system/operator-settings` returns the same, and `PUT /api/system/operator-settings/:key` saves a value for a setting nobody pinned, which applies to the whole install.

  Clawboo reads the file once at startup and never writes it. A file it cannot trust stops the server with `CONFIG: refusing to start.` and the reason: invalid JSON, an unknown key, a value of the wrong type, a file any user can write, a `CLAWBOO_OPERATOR_SETTINGS` naming a missing file, or anything that looks like a credential. An invalid value in one of the keys' environment variables stops it the same way.

- 624667e: Sign in from the locked screen by pasting a one-time sign-in link.

  **The locked screen has a Paste a sign-in link box.** Paste a link from **Open on another device** or `clawboo open --print`, or just its code, and press **Sign in**. This is how an app added to a phone's home screen gets in: on an iPhone or iPad that app keeps its cookies apart from Safari's, and a link you tap opens in Safari instead of the app. A pasted link is exactly as strong as an opened one. The box sends the code the way the server's own sign-in page does, so it works once, within two minutes, and sets the same cookie. The code never appears in the address bar, and nothing is stored in the browser.

  **Only a link for this dashboard is accepted.** It must name the address the dashboard is open at, with the same `CLAWBOO_BASE_PATH`. A link for another address or another dashboard, a link that carries the access token, the token itself, and text that is not a sign-in link are refused with a plain message, and nothing is sent. The box never opens the address you paste. A link that was already used or has expired comes back to the locked screen, which says so.

  **Open on another device says how.** On an address a phone can reach, the dialog now says that an app on a phone's home screen signs in by pasting the link, next to its **Copy link** button. Opened at `0.0.0.0` or `[::]`, the address a network bind listens on, it no longer shows a QR code a phone cannot use, and says to open the dashboard at the computer's network address instead.

- a71d0d9: Run Clawboo behind an SSO reverse proxy that signs identity tokens and see who approved what.

  **Off by default, set by an administrator only.** Set `CLAWBOO_PROXY_IDENTITY` (or `proxyIdentity` in the operator settings file) to `on` or `required`, with the proxy's public key or JWKS URL, its issuer and its audience. The dashboard has no switch for it. Clawboo holds only public keys: it refuses to start with a private key or a shared HMAC key, and accepts only asymmetric signatures, because agents run as Clawboo's own user and could read a shared secret.

  **Each request can name the person who sent it.** The proxy adds a signed token (a JWT) to each request. By default the token is bound to the request's method and path, lives at most 60 seconds and works once; `session` binding takes the sign-in token Cloudflare Access and oauth2-proxy send instead. A token that verifies names the person, and Clawboo records them on approvals (`resolvedBy`), team chat and 1:1 chat messages, task comments, and the board events for creating, moving, assigning and linking tasks. A forged, unsigned, expired, replayed or wrongly bound token is refused with `401`, never let through as an unnamed person. With `required`, a request without a good token is refused too, so an agent that reads the access token file can no longer use the API as a person.

  **Beside the access token.** While the access token is on, requests still need it. `GET /api/access/identity` says which mode is on and who the request is, the capabilities route reports `auth.proxyIdentity`, and **Settings** > **System** > **Deployment** shows the mode. It adds names, not permissions: everyone who gets through the proxy can still do everything, and the records live in a database programs running as Clawboo's user can change. See the new guide, Run Clawboo behind a sign-in proxy.

- a9dddb7: Your reply on a task now reaches its agent whatever the task's status, and you can see where it went. A reply to a task that is waiting on you, or waiting in To do, starts the agent on it again, so answering a blocker no longer needs a second click on Retry; quick replies start one run between them. A reply to a running task goes into the run, and one to a task in review waits for the agent to read after the check. A task moved back to To do still reaches the agent it belongs to. A finished task cannot run again, so the reply is not sent and the note under it offers to send it as a follow-up task for the same agent. The board's task drawer now has a reply box, and both the drawer and the chat's task card show under each reply where it went. The chat card's Send and retry button is gone, since a reply now does both.
- 864c246: Team chat work is now checked like the task runner's. On a team with a work check (the command you set in the team's settings, such as `npm test`), a task handed off in team chat, or given to an agent on the Board, that changed the team's folder is done only once that command passes in the folder. A large or risky change, or work a teammate handed down from its own task, also gets the same independent reviewer the task runner uses. A failed check sends the task back to its agent with what failed, once by default, and then to Needs you; whoever handed the task off hears about it only after the check.

  Clawboo sees what a task changed through a history of the team's folder that it keeps outside the folder, in `~/.clawboo/team-folder-history/`, so the folder never becomes a git checkout. The check runs on the whole folder, so it also covers what a teammate changed there at the same time. Without a work check, team chat work stays unchecked, and OpenClaw agents, which work outside the team's folder, are not checked.

- 5420800: A team's settings have a **Work check** box for the command Clawboo runs to check the team's task-runner tasks that changed files, such as `npm test`. Saving it sets the team's verify command, and saving it empty clears it so each agent writes its own check again. An **Active check** line says which of the two runs now.
- a318313: An agent working a board task now knows which task it is on, and starts from that task's story instead of from zero.

  **The task, in the run.** A run on a board task, a teammate's hand-off or a task you gave from the Board, now gets a task block before its waiting items: the task's id and title, its priority when not Normal, why the run started, the tasks it is part of, the results of finished tasks it waited on, its newest comments, and how the last attempt ended (it failed with an error, went quiet and was stopped, or was cut off). Every part has a limit, and a task with hundreds of comments still starts with a block of the same size, saying `get_task` has the rest. Only tasks on the run's own team's board appear in it. Before, the agent got only the task's text: a retry, a reply or a second run started with no idea what happened last time.

  **Text from the board is data.** The titles, results and comments in the block, each teammate's result in a task update, and the notes that reach an agent with a tool result are quoted under a line naming who wrote them, so nothing in them can pass for an instruction from Clawboo or from you.

  **The task id, for the agent's tools.** On Clawboo Native, Claude Code, Codex and Hermes, `get_task` and `add_comment` use the run's own task when a call leaves the id out, and `block_task` does too on a team run. The task rides the run's Tasks address inside its signature, so a runtime cannot point it elsewhere. OpenClaw agents are told the id to pass.

  **The same session for the same task.** Clawboo Native, Claude Code, Codex and Hermes continue their own session from their last run on a task, and are told what changed since: whether the title or description changed, and only the new comments. A task given to a different agent starts fresh, a finished or cancelled task ends its session, and a run that fails to continue its session leaves the next one to start fresh. OpenClaw keeps one session per agent in each chat, so it cannot do this.

  **Priority.** A task has one of four priorities: Urgent, High, Normal and Low. Set it in the task drawer; cards mark Urgent and High. An agent waiting on several tasks starts the highest first. Any number written to a task's priority is now held to those four levels, so no task can jump ahead of an urgent one.

  **Comments name their real author.** An agent's `add_comment` call is always posted as an agent comment, under that agent's own name where Clawboo knows who is calling, whatever author the call names. A comment in the task block can never claim to come from you or from Clawboo when an agent wrote it.

- 5e10613: A team now has chat rooms, a comment on a running task reaches the agent while it works, and the workspace around a team is rebuilt: a sidebar you can resize and hide, and cards beside every chat for its graph, tasks, browser and activity.

  **Steer a running task.** Comment on a task from a team chat's Tasks card, or from Tasks & Routines on the agent's page, and the agent working on it reads the comment during the run, instead of only at its next one. Native agents, Claude Code, Codex and OpenClaw take it at the run's next step without stopping anything; Hermes pauses the run and resumes the same session with your comment. The comment always lands in the agent's mailbox as well, so a task that isn't running yet still gets it. Codex runs are now hosted in `codex app-server`, which is what lets them be steered; an older Codex without it falls back to `codex exec`, where a comment waits for the next run.

  **Rooms.** Next to the team's own chat, now called General, a team can have rooms, each with a subset of its members. A room is its own conversation: its own transcript, its own task cards and its own graph, while Boo Zero still leads every room and the team's rules, brief, memory and board stay team-wide. Create a room from the sidebar's New room, then pin, rename or delete it from its menu. Deleting a room archives it: its conversation is kept and whatever it was working on stops.

  **Clear chat.** Every chat's menu, General's included, can clear it. The messages are set aside rather than deleted, the agents start that conversation fresh (OpenClaw agents are sent `/reset`, as typing it does), and the chat's timeline stops showing the task cards made before the clear; they stay on the board and in the Tasks card.

  **Sidebar.** Drag the agent column's edge to resize it (double-click resets it); drag it narrow enough, click its toggle or press Cmd+\ and it hides completely. While it is hidden, a toggle at the start of each page's header brings it back, and hovering that toggle shows the sidebar over the page without docking it. The top of the column shows the team's name, a search, and a grid of the team's agents with a dot on the ones working. Below them are the rooms, and the nav: Home, Org chart (the new name for Atlas), Board, Connectors, Memory, Marketplace and Settings. Fleet now lives in Settings, under Insights. Cmd+1 to Cmd+4 open Org chart, Board, Connectors and Memory.

  **Cards beside the chat.** An agent's page puts its chat on the left and cards on the right, each toggled from the chat's header: Graph, Tasks & Routines, Browser, Activity and Details (its workspace, personality, permissions and files). Tasks & Routines shows the agent's tasks and the routines that send it work, with New routine set up for that agent. A team chat stacks a Browser window, the team's (or room's) graph, a Tasks card and Activity: the Tasks card sorts the team's work into Needs you, In progress, To do, Done and Cancelled, and opening a task shows its progress and comments, with the comment box that steers its agent and a button to open it on the Board.

  **Home.** Each team has a Home page, the place its dashboards and its agents' artifacts will live.

  **Org chart.** With the browser panel open, the radial org chart turns around Boo Zero to bring the team you pick next to the panel, and picking an agent steps it forward while its teammates make room. Closing the panel or switching team settles the team back. The turn is remembered; the focus is not.

### Patch Changes

- ac28617: Make the access token and the same-origin guard read a request's path the way the router does. Both now decide whether a request is an `/api/` request from every way the server reads its path, so every request the server routes to an `/api/` route needs the access cookie and passes the Origin and Host check, however its path is written. The MCP servers' attach-token exception applies only to a path that is under `/api/mcp/` every way it is read. A request whose target is a full URL instead of a path now gets `400` (`404` when Clawboo is served under a path prefix): browsers, reverse proxies and Clawboo's own clients always send a path.
- a22006c: Refuse an unusable access token, write credential files owner-only, and keep review worktree teardown inside its folder.

  **An access token with an unsupported character stops the server.** `STUDIO_ACCESS_TOKEN` may use only `[A-Za-z0-9._~-]`. A token with any other character, such as the `+`, `/` or `=` in `openssl rand -base64` output, used to turn the access gate off with a warning and keep running. On a loopback bind behind a reverse proxy on the same machine, that left every `/api/*` route open. The server now logs a `SECURITY: refusing to start` error naming the character and the allowed set, and exits 1, on every bind. `CLAWBOO_ALLOW_INSECURE=1` does not skip it: that variable allows running with no token, not with one the gate cannot use. If your server stops at boot after upgrading, regenerate the token with `openssl rand -hex 24`.

  **Files that hold credentials are readable by you only.** OpenClaw's `~/.openclaw/.env`, each OpenClaw agent's `auth-profiles.json`, Clawboo's `~/.clawboo/settings.json` and the file `clawboo backup` writes are now mode `0600`. An existing file is narrowed to `0600` before new contents are written into it; when that fails on a file others can read, Clawboo refuses the write. `~/.openclaw` and `~/.clawboo` are created `0700` when Clawboo creates them. A backup file is `0600` from the first byte, and a backup that fails removes its partial file. Modes are best-effort on Windows.

  **Review worktree teardown stays in its folder.** Removing a reviewer's checkout now refuses any path that is not directly inside the review worktree folder, instead of deleting whatever path it was given.

- 56216ee: Creating and deleting agents now works without an OpenClaw Gateway, and a new agent made on the Org chart always joins a team.

  **Create.** Create Boo shows on every install. A new Boo runs on OpenClaw while the server is connected to an OpenClaw Gateway and on Clawboo Native otherwise, and the dialog says which. It still joins the team selected in the sidebar. The graph's New agent, from a thread or the + button, follows the same rule; without a Gateway it used to fail with `gateway_disconnected`, and a new native agent now appears on the canvas at once instead of after a reload.

  **Delete.** The trash icon in the all-agents list and a team's Delete with agents no longer need a Gateway. Delete with agents removes the team's agents instead of leaving them behind, and its confirm mentions the Gateway only when the team has an OpenClaw agent.

  **Org chart.** A thread pulled off Boo Zero and let go on empty canvas gives the new agent the team selected in the sidebar, or the first team when none is, and the picker's New agent row names it. The agent used to be made with no team, and the Org chart did not draw it.

  **Select in sidebar** is gone from the graph's right-click menu. It never marked anything in the sidebar; Open agent does.

- 7b1d92c: Keep agents' browsers off the Clawboo dashboard on every hop, and off the files on this computer. Playwright applied its dashboard block only to the address an agent opened, so a local page that redirected to the dashboard loaded it, and neither browser stopped a page's WebSocket to the dashboard's port. Both browsers now start with Chrome host rules that refuse the dashboard's addresses on its port, so a redirect, a page's script or a WebSocket cannot reach it either, and Chrome DevTools now blocks every `127.x.x.x` address on that port too. Chrome DevTools also opened `file:` addresses and showed the file to the agent, and Playwright opened `view-source:file:` ones. Chrome DevTools now refuses `file:` and `view-source:` addresses itself, and the broker refuses any call whose `url` argument would open a file on this computer in either browser, including a Windows drive or network path.
- 3c9e64b: An agent can no longer move a card back after you moved it. When you move a task on the board while an agent is still working on it, the run is stopped, but a coding agent could still call its task tools before the stop landed and put the card back where you took it from. Those status changes are now refused, with a message telling the agent the task's status is yours to set and not to try again. Once the task runs again, the agent's status changes work as usual.
- 4f0c127: Several API routes answer with the status and body their documentation describes.

  **Schedules.** A cron spec that does not parse answers `400` with `code: "invalid_cron_spec"` instead of `invalid_body`. Changing, pausing, resuming, deleting or running an OpenClaw Gateway cron job the Gateway does not have answers `404 unknown_schedule` instead of `500`. A create, change, pause or resume answer carries `teamName` and `agentName`, and a team routine's lead `runtime`, the same as the list. Pausing a Routine clears its `nextRunAt`, so a paused Routine no longer shows a next run; resuming sets a new one.

  **Other routes.**

  - `POST /api/exec-allowlist/revoke` answers `502` only when the Gateway call fails. A failure inside Clawboo, such as a database read, is a `500`.
  - `POST /api/capabilities/install` answers `422` with the scan's `findings` when the injection scan blocks the install, instead of a `500`.
  - `POST /api/agents/:agentId/screenshot/capture` answers a failed capture with a JSON `500` instead of an HTML error page.
  - `POST /api/runtimes/clawboo-mock/run` runs a task on the fault-injection runtime when `CLAWBOO_ENABLE_MOCK_RUNTIME=1` is set, instead of answering `404`.

- f272bc0: Loading the dashboard no longer counts against the API's request limit. The dashboard's script files, fonts and page shell were counted twice, once under their own limit and once under the API's, so a run of page loads could make the API answer "Too many requests" while API traffic itself was far below the limit. Those files now count only under their own limit, and both limits are unchanged.
- 5722f62: The app shell pads its top by the `--clawboo-titlebar-inset` CSS custom property, so an app that embeds the dashboard can draw its own title bar, such as an inset macOS one, without covering the sidebar. Unset, it is 0 and nothing changes.
- 2d9940e: Approvals now show up in the event log. Every approval card writes an `approval_requested` event when it opens and an `approval_resolved` event when it is answered or expires. This covers connector calls, Clawboo Native commands, risky hand-offs and OpenClaw commands. Before, nothing wrote `approval_requested`, and `approval_resolved` was written only when the hourly cleanup expired a request nobody had answered. A person's answer never reached the log, so the **Activity** feeds and anything reading `GET /api/obs/events` could not see an approval waiting or being answered. The events name the tool and never carry its arguments or the command text. The **Activity** feed now labels each approval row with its tool's name.
- 6da25cd: The live event stream, `GET /api/obs/stream`, takes `?kinds=` to send only some event kinds. A client can now follow approval requests and answers with `?kinds=approval_requested,approval_resolved` instead of polling the approval queue, without receiving every other event or waiting behind them after a reconnect. The stream also takes `?afterSeq=<seq>`, the cursor name `GET /api/obs/events` uses; before, it ignored that and replayed the whole log. A malformed `Last-Event-ID` header now falls back to the cursor in the query instead of replaying from the start. The Observability API page shows how to start from the approval queue and then follow the stream.
- bda02e3: A refused key, login or account now reads as what it is: the task waits in **Needs you** with **Fix sign-in**, nothing retries it into the same refusal, and a routine keeps its schedule through a rate limit or a provider outage.

  **Sign-in and billing failures.** Two new error classes, `Auth` (a missing, revoked or expired key or login) and `Billing` (no credit, an account on hold, a pending verification), replace the old filing of these under `UnexpectedEnv` and `ProviderError`, and neither is a harness bug. An empty OpenAI balance (`insufficient_quota`), which arrives as a 429, is now `Billing` instead of a rate limit. The class comes from the runtime's own error, never from what the agent wrote, and a run the idle guard ended is a `Timeout`. Claude Code, Codex and Hermes put the cause they know on the error's code, in the same words where they mean the same thing: Codex's typed app-server causes, and the `code` or `type` of the provider error Hermes prints. Network drops (a reset or refused connection, `fetch failed`, a dropped stream) are `ProviderError`, and a plan's usage limit is `RateLimited`. Each failed run's class is stored on its ledger row.

  **Needs you and Retry.** A task whose run failed on `Auth` or `Billing` shows **Sign-in failed** or **Billing problem**, and leads with **Fix sign-in**, which opens **Settings > Runtimes** at the runtime that ran it with its row open. **Retry** moves to the card's menu and asks first, quoting the error. The same goes for a card that groups several such tasks, and for the task drawer. Clawboo never retries such a task by itself.

  **Team chat.** When a delegated run fails on its sign-in or billing, the task's comment says so, and the report to the lead tells it not to re-delegate or retry the task and to tell you. Once you have fixed the sign-in, asking the lead to try again works.

  **Routines.** A routine keeps its schedule through a failure that may pass by itself (a rate limit, a timeout, a provider error or a dropped connection), records the error, and runs at its next time; a success clears it. Three such failures in a row, or any other failure, stop it until you resume it, and resuming starts the count again. The task a failed fire set aside says whether the routine runs again.

  **Claude Code.** A run whose conversation outgrew the model's context window (`terminal_reason: 'prompt_too_long'`) is out of room rather than failed: the task runner continues it in a fresh session with a handoff note, as it does at the turn limit.

- 1b93165: The board no longer says work started, or was handed off, when nothing happened.

  **Deleted chat rooms.** Deleting a room now waits for its work to stop, then moves its unfinished tasks to General, still stopped, so Retry, Assign or a reply runs them there. Before, those tasks stayed filed under the deleted room, where nothing could run them, while Retry, Assign and a reply all answered that they had started. Clawboo moves the tasks of rooms deleted before this update when it starts. A task left behind by a deleted team is now refused as having no team. Stopping a room also releases every task its work was running, not only the first.

  **Boo Zero's own chat.** Boo Zero is told that it cannot hand out work from its own chat, and sends you to the team's chat instead. A hand-off that still appears in a reply there shows as a **Not handed off** note, not as a "Delegated to" card for work that never starts.

  **Hand-offs to no one.** When a lead hands work to a name that is not a teammate in the chat, or to itself, it is now told the hand-off did not start, with the names it can use. The delegate tools now answer that the work is queued, since they answer before Clawboo has matched the name.

  **Agents' board tools.** On team chat runs, Claude Code, Codex and Hermes agents no longer get the tools that claim tasks or change their status, which the team engine does itself: a stray claim used to strand a card nothing could recover, and an agent marking its own task done cost its lead the result. They can still mark their own task blocked, and the task then waits in Needs you while the lead is told why. OpenClaw agents get no claim or status tools at all, since their tools cannot tell one agent from another. Elsewhere, `claim_task` claims for the agent that calls it.

  **Long tool calls.** A team chat run that is silent inside one tool call, such as a long build or a command that prints nothing, is no longer stopped after 10 minutes. It now gets 25 minutes, a minute past the 24 minutes a delegated task is allowed inside one tool call, so the task's own limit decides and the lead hears the real reason.

  **Cancelling through the task tools.** Cancelling a task with `update_task_status` now cancels the plan steps waiting on it, as Dismiss on the board does, and tells the agent that handed the task out. Before, those steps waited in To do forever.

- f272bc0: An agent's Boo no longer loses its body when another copy of it is mounted but hidden. With the sidebar hidden, its agent grid stays in the page for the peek panel, and a Codex Boo elsewhere (a card on the Board, for one) took its colours and outline from that hidden copy and drew only its eyes and paws. Every Boo now draws from its own copy, Codex, Claude Code and Hermes Boos and the generated mascot alike, wherever the others are and whether or not they are shown.
- 6f0cfca: The browser connectors can be kept from starting, and start lighter when they do.

  `CLAWBOO_DISABLE_BROWSER_AUTOSTART=1`, `disableBrowserAutostart` in the operator settings file, or the **Start the browsers on a new install** switch in **Settings** > **System** > **Deployment** stops Clawboo starting Playwright and Chrome DevTools on an install that has never had them. Browsers you connected still come back after a restart.

  When the exact version Clawboo pins is already installed, in npx's cache or beside Clawboo, each browser now starts from that copy instead of through `npx`, which kept an `npm exec` process running beside every browser and asked the registry on every start. Any other version still goes through `npx`. Chrome DevTools now runs with its usage statistics and its daily check for a newer version off, unless the server's own environment sets `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` or `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`.

- f897517: Saving a budget again no longer turns a hard cap into warn only. The Governance form started on **warn only**, so pressing **Set budget** for an agent, team or task that already had a hard cap silently switched it to a warning, and `POST /api/governance/budgets` did the same whenever a request left out `mode`. A save without a mode now keeps the budget's mode (a new budget still starts as warn only), and picking something that already has a budget switches the form to that budget's mode and says so under the form.
- 6f0cfca: A release reads the Marketplace catalog published with it. Every install used to read the catalog index from the `main` branch, so it got whatever `main` held that day, content written for a newer version included, and one change there reached every install at once. A release now reads the index at its own tag (`clawboo@<version>`). A development build still reads `main`, a release whose tag has no index falls back to `main`, and `CLAWBOO_CATALOG_INDEX_URL` still overrides both.
- ae47b2b: A chat that loses its live connection no longer skips messages.

  The team chat and 1:1 chat streams start at the newest message and only stored messages carried a resume id. A browser asks to resume only once it has received an id, so a connection that dropped before its first message reconnected at the newest message at that moment, and any message stored in between did not appear until the chat was loaded again. Both streams now open with a `cursor` event that carries the id they start from, so a reconnect resumes from there. Clients that do not listen for `cursor` see no change.

- f75e071: You can now chat one-to-one with a Claude Code, Codex or Hermes agent from its page, with no OpenClaw Gateway.

  The message box on these agents' pages used to go through the OpenClaw Gateway, which does not run them. Without a Gateway it read "Gateway not connected…", and with one a message went nowhere. These chats now run on the Clawboo server, the same way Clawboo Native chats do, and the reply streams back into the chat. Each agent picks up its own session from one message to the next, so it remembers the conversation, and `/reset` starts it fresh. Claude Code, Codex and Hermes also get the agent's persona (its `SOUL.md`) on every turn, as they do in team chat.

  Every 1:1 chat, Clawboo Native included, now starts in the agent's team working folder, `~/.clawboo/workspaces/<team id>` (`workspaces/_no-team` for an agent on no team, such as Boo Zero), never in Clawboo's own data folder. For Claude Code, Codex and Hermes the folder only sets where the run starts; they keep your full file access. A Clawboo Native agent can now read and write files in its 1:1 chat, only inside that folder, and one with **Running commands** switched on can ask to run a command there, which waits for your approval in the chat. Native's file tools also refuse a symlink that leads outside their folder.

  A turn that fails before it answers now leaves a notice in the chat with the reason, a run that goes silent for too long is ended and reported instead of holding the agent forever, and the send button stays on Stop for the whole turn, including a Hermes reply that only arrives at the end.

- 886ecb8: Agents running on a ChatGPT subscription work again. OpenAI's backend now refuses the models Clawboo used to pick for subscription runs ("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account"), so every such run failed. Clawboo no longer names a subscription model of its own: which models a ChatGPT plan may use is OpenAI's call, per account, and it changes.

  - **Hermes** on the subscription now runs your plan's own default, which Hermes asks the backend for, instead of a fixed model.
  - **OpenClaw** set up on the subscription gets your plan's own default model, read live from your Codex CLI. When that list is unknown, OpenClaw applies its own default.
  - **The model pickers** list your plan's models, read live from your Codex CLI, instead of a fixed list. Hermes's ChatGPT subscription group also offers **Plan default**, which works even before that list is known.

  **Codex too old for your plan.** An older Codex CLI cannot read your plan's current models and quietly falls back to the ones it shipped with, which OpenAI refuses (codex 0.136 did this). A failed Codex run now reports OpenAI's own reason and says to update the CLI, instead of an unrelated line from the CLI's log, and the Codex card in Settings → Runtimes shows an **Update** button when it detects an outdated CLI.

- 48c6978: Claude Code reads as installed when the Claude Agent SDK is. A Claude Code run starts the SDK's own `claude` binary from its platform package and never a `claude` CLI, but the Runtimes panel looked only for the CLI, so an install with the SDK alone read **Not installed** and could not pick Claude Code for a team. The panel, the install route and the runtime's health check now also accept the SDK's binary, found the way the SDK finds it (its platform package, the musl build first on a Linux without glibc), and `GET /api/runtimes` reports where the binary came from in `binSource`. With the SDK's binary there, **Install** no longer downloads the CLI as a second copy no run uses.
- 5d3e663: Claude Code no longer reads as ready when only a `claude` CLI is installed. Every Claude Code run loads the Claude Agent SDK and starts the SDK's own `claude` binary, never a CLI on `PATH`, so an install with the CLI alone read **Connected** once a key was saved while each of its runs failed asking for the SDK. Claude Code now reads as installed exactly when the SDK and its binary sit next to Clawboo, and the health check agrees. **Install** fetches the SDK (`npm install -g @anthropic-ai/claude-agent-sdk@0.3`) instead of the CLI; on a one-off `npx` run or a source checkout, which cannot load a globally installed SDK, it says what to run instead.
- 8ddb4f9: Claude Code agents leave your own Claude Code setup out. They used to load everything your `claude` command loads: your `~/.claude/settings.json` (plugins, hooks, `env`, permissions, model), the MCP servers you added to your own Claude Code, your `~/.claude/CLAUDE.md` and rules, and Claude Code's auto memory for the repository a task's worktree came from, which they could also write to. Now the driver loads only the project tier (`settingSources: ['project']`), excludes every `CLAUDE.md` above the working folder and in your home folder, and turns auto memory off, with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` set in the agent's environment so an inherited `0` cannot turn it back on. A repository's own `CLAUDE.md`, `.claude/settings.json` and `.mcp.json` still apply. Sign-in is unchanged: the Anthropic key goes in the environment, and the `claude` command's own sign-in is not a settings file. Auth you set in `~/.claude/settings.json`, such as an `env` block with `ANTHROPIC_BASE_URL` or an `apiKeyHelper`, no longer reaches agents; set those variables in the environment you start Clawboo with.
- d03b8cc: A task that passes its check with a completed review no longer keeps the open issues from an earlier pass with debt. Before, a task that passed with debt, went back to In progress and then passed cleanly still listed the old issues in `GET /api/board/:taskId`, in the Tasks MCP tools and to agents reading the task, though the task drawer already hid them. A pass whose review was skipped, returned nothing or did not complete keeps the reviewer's issues, because nobody looked at them again, and drops only the issue a failed test command left. A failed check still keeps the open issues, and a second pass with debt adds its issues to the earlier ones. Each attempt's own result is kept as before. A task checked before this update keeps its old list until it is checked again.
- fd1475d: With `STUDIO_ACCESS_TOKEN` set, `clawboo` now sees the server it just started instead of printing "Dashboard is taking too long to start." and exiting while the server runs. The command uses the token from your shell, sent only to a port that answered with Clawboo's own access-token refusal, so `clawboo stop` and `clawboo restart` also work on a server whose token that shell has.
- 8ddb4f9: Connector access set to ask every time (`approvalPolicy: always`) now always asks. A standing rule from an earlier **Always** answer used to be checked before the policy, so a remembered tool ran without asking even under `always`. The policy now comes first: a standing deny still denies, a standing allow no longer skips the prompt, and the request is marked never-remember, so the card offers no **Always** and an API `allow_always` saves no rule.
- 48c6978: Connectors and the shell commands you approve for a Clawboo Native agent keep npm's own prefix, cache and update-check settings. Their environment starts empty so that no credential leaks into them, and that also dropped every `npm_config_*` variable, so an approved `npm install -g` failed with `EACCES` on a server whose npm prefix points at a folder of its own. `npm_config_prefix`, `npm_config_cache` and `npm_config_update_notifier` now pass through in either spelling; no other npm setting does, so npm credentials such as `npm_config__authToken` stay out. Connectors also start with `npm_config_update_notifier=false` unless it is set, so an `npx` start does not check the registry for a newer npm.
- 018c917: Starting Clawboo no longer risks stopping an unrelated process. At startup, Clawboo stops connector processes that a crashed or force-quit server left running, and it told them apart from other processes partly by the system's boot time. Inside a container that is the host's boot time, which a container restart keeps, so a connector's process id from before the restart could name another process. On a system without `ps`, that process was stopped with no check of when it started.

  Each connector record now also names the PID namespace it was written in and when that namespace's first process started. A record from another namespace, or from before the namespace started again, is dropped without stopping anything. On Linux, nothing is stopped when Clawboo cannot read those two values from its own namespace. On every system, a process whose start time cannot be read is now left running: the server log says why, and the record is kept so the next start can check it again. Records written by an older version are dropped unchecked on Linux, and judged as before on macOS and Windows, which have no PID namespaces. Agent processes recorded before a container restart are never stopped either.

- 4f0c127: Agents are told only about connectors shared with them, and several status reports now match what is set up.

  **Connectors an agent was not given are not named to it.** The connectors note on a turn you read listed every connector you had connected as usable, including ones never shared with that agent. That told the agent it could use tools it could not see, and told it which apps you had connected for other agents. It now names only the connectors whose tools that agent actually has, and never offers one you already connected as something to add. An OpenClaw agent reaches Clawboo's tools through one setting all OpenClaw agents share, so it is told only about connectors shared with every agent, not the browser each agent is given at first start. A Clawboo Native agent whose tools MCP server is switched off is told about none.

  **Approving an OpenClaw command through `POST /api/capabilities/approve` releases it.** It used to mark the approval answered while the Gateway kept holding the command. It now answers through the Gateway, exactly as `POST /api/tools/approvals/:id/resolve` does.

  **Codex rows read Ready after `codex login`.** In **Settings > Capabilities**, Codex's Clawboo server rows read **Pending auth** before you sign in to Codex and **Ready** after, instead of **Pending auth** always.

  **Clawboo Native refuses a key for a provider it cannot run on.** `POST /api/runtimes/clawboo-native/connect` with a provider such as `minimax` answers `400 unknown provider` instead of storing that key as your Anthropic key.

  **Smaller fixes.**

  - `GET /api/providers` lists, in `poweredRuntimes`, every runtime that reads the provider's key: Clawboo Native for every provider it can drive, and Hermes for Anthropic and OpenAI keys too.
  - OpenClaw keys held by any agent count as configured in `GET /api/system/openclaw-config` and `GET /api/system/models`, not only the first agent that has a key.
  - `team_chat_subscribe` no longer skips posts when `limit` cuts a page short: the next read starts after the last post returned.
  - The `memory_search` tool tells agents the default mode correctly: hybrid when an embedding provider is set up, otherwise keyword.

- bf0a2f5: Spend tracking now counts what agents really cost, and a hard cap no longer throws away work that was already paid for.

  - **Local Ollama models are free.** A run on a model your own Ollama serves was charged the $3/$15 per million token default rate and shown as an estimate. It is now recorded at $0, a task that only ran locally reads **free** on the Board, and no budget is charged. This covers Clawboo Native agents on Ollama and OpenClaw agents whose model is an `ollama/` one. Ollama's cloud models (a `-cloud` tag) still count, because they do not run on your machine.
  - **A hard cap keeps a finished result.** Claude Code and Codex report what a run cost only as it ends. When that last report took a budget past its hard cap, the run was recorded as cancelled, its result was dropped and the task went back to To do, so a retry paid for the same work again. The finished result is now kept and posted, the task moves on as usual, a comment says the cap was reached, and the next run is refused until you raise the cap or resume. A run that keeps working past the cap is still stopped.
  - **Every run is charged.** An OpenClaw routine run that failed, timed out or was stopped charged no budget, and an agent routine or API run that ended without a cost report (a Claude Code run that failed first, or a Hermes run that reported no usage) recorded nothing. These are now estimated from the length of the prompt and reply, the same way team chat already estimated them.
  - **Tokens Used lists every runtime.** The view counted OpenClaw agents only, so Clawboo Native, Claude Code, Codex and Hermes agents always read zero. Their runs are now listed too: Board and API runs, routines and team-chat runs. Earlier runs are not backfilled.

- 1a7a097: Saving SOUL.md keeps your custom personality instructions. While **Use Custom Instructions** was on, the SOUL tab under **Agent Files** showed the slider personality instead of your text, and saving SOUL.md there wrote the slider text over your instructions. The tab now shows your instructions, and saving it keeps them.
- 4f0c127: Labels and hints that pointed at things the dashboard no longer has now say what is there.

  - `clawboo --help` describes Clawboo as running a team of agents on Claude Code, Codex, Hermes, OpenClaw or built-in agents, not as a platform for OpenClaw teams. The launch message points at the Org chart instead of the Ghost Graph.
  - The team introduction screen ends with **Continue to team chat**, where it takes you, instead of **Continue to Team Space**.
  - The welcome screen's shortcut to token use is labelled **Tokens Used**, like the page it opens, instead of **Cost**.
  - The Command Approval hint under **Settings > System** sends you to an agent's **Details > Permissions**, not to a Personality tab that no longer holds the setting.
  - A **Not started** card on the board says what is wrong (marked In progress, but no agent has it and nothing is running) instead of saying it was moved there by hand, which the board does not allow.
  - A risky hand-off approval card says the leader wants to hand a task to the named teammate and shows the task text, instead of `wants to run "Delegate:code"`.

- ea1c91f: Close gaps in the guard that keeps agents' browsers off the Clawboo dashboard. With `HOST` set to anything but `127.0.0.1`, such as a loopback alias like `127.0.0.2` or a LAN address, neither browser connector blocked the dashboard at that address, and the broker check let calls naming a LAN address through. Both browsers and the broker check now block the address set in `HOST`, and Playwright also blocks every `127.x.x.x` address on the dashboard's port. Both also block the port on every name under `.localhost`, which Chrome sends to this computer without asking DNS, on IPv4-mapped addresses such as `[::ffff:127.0.0.1]`, and on `[::]`. The broker check that refuses a connector call naming the dashboard now reads the address the way a URL parser does, so a percent-escaped or full-width spelling of `localhost` or `127.0.0.1`, a leading zero on the port, or a tab or line break inside the address no longer slips past it. That check is the only one between the dashboard and a connector that fetches URLs itself.
- 8ddb4f9: Risky hand-offs are never remembered. An `allow_always` answer to a risky hand-off, which only the API could send, used to stop that leader's risky hand-offs from asking again, with no end date and nothing in the dashboard to undo it; for Boo Zero it covered every team. Now every risky hand-off opens its own approval, marked never-remember, and an `allow_always` answer allows that one hand-off. An `allow_always` recorded before this change no longer skips anything.
- 1a7a097: Deleting an agent deletes the routines that send work to it. They used to stay behind and fail with `agent ... not found` on every run until removed by hand. Team routines target no agent and are not affected. An OpenClaw agent deleted while its Gateway is offline keeps its routines until the Gateway confirms the delete, so a Gateway that refuses it and brings the agent back does not lose them. `POST /api/agents/cleanup-ghosts` also removes the routines of the rows it deletes.
- cc96b40: `clawboo stop` and `clawboo restart` no longer stop a server that stops answering while its agent runs are going. When three polls in a row get no answer during the wait, the command now checks the server's port. If the server is gone, the stop finishes as before. If it is still there but silent, the command leaves it running, says "The server stopped answering while N agent runs were going, so it was not stopped.", prints a command that stops its process by hand, and exits 1. Before, it went ahead and stopped it, which could interrupt those runs or report a busy server as not running. A server that does not answer the request to hold it gets the same hand-stop command; `--force` cannot reach a silent server, because it finds a server by asking it.

  A server too busy to answer is now never mistaken for no server. When the port Clawboo recorded still takes connections but answers nothing, `clawboo stop` (with or without `--force`) keeps its record, says the server was not stopped and prints the hand-stop command, instead of deleting the record of a running server and reporting that none was running. `clawboo restart` starts no second server while that port is held, by a silent server or by a Clawboo server answering there, and exits 1 instead.

  When the command cannot release the hold it placed, it now says so on every path, including a server that did not answer the hold and a stop that found no server: the server then starts new work again within a minute, when the hold lapses.

- 37cb47d: The task drawer now shows the open issues a passing check did not look at again. When a task passed with debt, went back to In progress and then passed a check whose review was skipped, returned nothing or did not complete, its open issues stay on the result, and `GET /api/board/:taskId` and agents already saw them. The drawer hid them. Its Verification section now lists them under **Passed**, marked **Not reviewed again**. A pass whose review completed still lists none, and the issue a failed test command left never shows on a pass, since the command passed. A failed check also keeps the open issues, and the drawer now lists them under the failure, marked **Still open from an earlier pass with debt**. There the failed command's issue shows only while the latest command still fails.
- 09c401d: A check whose test command passes no longer keeps an earlier "test command failed" issue when its reviewer fails the work. Before, a task that passed with debt because its command failed, went back to In progress, then ran the command green but had the reviewer block it, still listed the old command failure in `GET /api/board/:taskId`, in the Tasks MCP tools and to agents reading the task. When that was the last attempt, the result was a pass with debt and the task drawer showed the stale failure too. The reviewer's issues, earlier and new, are kept as before, and a failed command still keeps every issue. A task checked before this update keeps its old list until it is checked again.
- 4bae131: A teammate's result now reaches whoever handed the work off even if Clawboo restarts in between. The task update used to wait in memory, for a few seconds and then for as long as the lead was busy with another turn, so a restart in that window lost it: the result stayed on the board, but the lead never heard about it and never wrote its summary.

  Each task update is now saved as soon as the task finishes, and it counts as delivered only once the run that received it has finished. If that run never finishes, because Clawboo stopped or restarted, the run failed, or it could not start, the update is sent again: within about half a minute while Clawboo keeps running, or shortly after it starts again. After 3 more tries it is given up, with a note in the chat that the results are on the board. Pressing Stop drops an update that was waiting for its recipient's turn, as before, and one whose run the Stop ended; deleting a room drops the updates still waiting in it the same way.

- 6a4509d: Clawboo now caps how many agent runs execute at once across the whole server, 8 by default; set `CLAWBOO_MAX_CONCURRENT_RUNS` to change it. Board tasks, team chat turns and the tasks they hand out, one-to-one chat, peer exchanges and Routine runs all count. A run that arrives while every slot is busy waits its turn instead of starting at once: it is never failed for waiting, the idle watchdogs do not count the wait, and **Stop** takes it out of the queue. A run whose agent is already busy waits without holding a slot, so one agent's backlog never blocks the others. Routines that fall due together now start as slots free up rather than all at once.
- f897517: The Governance panel no longer says a hard cap pauses work the moment a scope crosses 100%. It now says what happens: the budget reads paused once recorded spend reaches its limit and new runs it covers are refused, while a run already going is usually charged when it ends and finishes; only some Clawboo Native runs stop partway.
- f897517: A paused hard-cap budget now refuses new team-chat and one-to-one chat turns before they start. Team chat (General, rooms, team routines, Board tasks and hand-offs) checked no budget before a turn, so a team kept working after its budget read paused, and only a priced Clawboo Native run could be stopped. Each run now checks the agent's budget, the team's and, for a run on a task, its mission's, the same way the task runner does. A refused message gets a notice in the chat naming the paused budget instead of a reply. A refused hand-off or Board task is not started: it waits in **Needs you** with the same reason in a comment, and the agent that handed it off is told why. A refused team routine records that reason as its error. One-to-one chat checks only the agent's own budget, the one it is charged to. A run already going when a cap pauses still finishes unless it is a priced Clawboo Native run, so press **Stop** to end it.
- bf1a212: A Hermes installed without its live mode now says so, offers a one-click update, and its running tasks say how a comment will reach them.

  **Update Hermes.** Clawboo asks Hermes with `hermes acp --check`, in a throwaway home it removes afterwards, whenever the runtimes list is read (at most once every ten minutes, or after a minute when a check could not tell, never waiting for the answer). The onboarding runtimes step now reads that list again while it shows, as the Settings panel does, so the answer reaches it too. A Hermes without ACP reads **Update available** in **Settings** > **Runtimes**, and its row offers **Update Hermes** beside its keys and sign-in. The update reinstalls `hermes-agent[anthropic,acp]<1` in place (`pipx install --force`, or `pip install --upgrade --user`), then asks Hermes again before it reports done, so the next run uses ACP. An update of any runtime now runs to the end when its client goes away (a closed panel, a reloaded page) instead of being stopped part way, and a second install of a runtime while one runs is refused with `INSTALL_RUNNING`. A Hermes without ACP also stays on its quiet path from that answer alone, so no run pays for a failed ACP start first. The runtimes list reports the answer as `acpMissing`, and its Hermes `steering` and `streaming` follow it.

  **An exact hint on running tasks.** The line beside **Send** on a running task now follows the run on it: a Hermes run on its quiet path reads "… pauses to read this, then carries on.", including a run that fell back from ACP while new runs would be live, and the other way round. With no run to ask, it follows what the agent's runtime takes now. `GET /api/board/:taskId` reports the run's way as `runSteering`, and an adapter can report it per run with the new optional `runSteering(run)`.

- 2908973: Hermes agents now run over Hermes's Agent Client Protocol mode (`hermes acp`), so you see their text, reasoning and tool calls as they happen, their runs report token counts, and a comment on a running task reaches the agent without stopping the run.

  **Live runs.** Each Hermes run is one `hermes acp` process: Clawboo opens a session (or loads the one a task resumes), sets the model, sends one prompt and streams Hermes's session updates into the run. The cost is now estimated from Hermes's token counts instead of the length of its text. A comment goes in as `/steer`, which Hermes reads after the tool call in progress; one that arrives while Hermes writes its final answer is sent as one more turn, so it is never dropped. Stop cancels the turn. A task or comment that starts with a slash reaches Hermes as text, never as one of its own commands such as `/model` or `/reset`. Runs keep the same headless posture as before: no prompts before commands or edits, Clawboo's MCP servers attached, and the agent's own Hermes home.

  **Failures stay failures.** Hermes's ACP mode answers a failed turn as a finished one. Clawboo reads a turn that reports no token counts as failed, with the error Hermes logged as the reason.

  **Install and fallback.** Clawboo now installs `hermes-agent[anthropic,acp]<1`. A Hermes installed earlier without the `acp` extra keeps working: each run falls back to the quiet `hermes chat` mode, which steers by stopping and resuming, and Clawboo skips ACP for ten minutes after such a fallback. Reinstall with `pipx install --force 'hermes-agent[anthropic,acp]<1'` to get live runs. `CLAWBOO_HERMES_TRANSPORT=quiet` keeps every run on `hermes chat`.

  The ACP client is agent-neutral, so another ACP agent can reuse it later.

- fd1475d: The Hermes install now picks the newest Python from 3.11 to 3.13, the versions `hermes-agent` installs on. A Python 3.14 on the same machine no longer wins over an installed 3.12. When Clawboo finds no Python in that range and pipx is not installed, the error names the range it needs and the versions it found.

  A Hermes agent on your ChatGPT plan stays on it. Its page shows its model with **ChatGPT plan** instead of offering OpenRouter models that would move it off the plan, and a model change through the API keeps the agent's provider unless the request names another.

- ccffcd8: Install the dashboard as a web app, and use the board and chats at a phone's width.

  **Installable.** The dashboard serves a web app manifest with the Boo icons, so Chrome and Safari offer to add it to the home screen, where it opens in a window of its own. Every URL in the manifest is relative, so the installed app starts at the dashboard's mount, under `CLAWBOO_BASE_PATH` too, and nothing it opens carries a query. The manifest and its icons load without the access cookie, the shell asks for it with `crossorigin="use-credentials"` for a sign-in proxy that needs one, and the API still needs the cookie. There is no service worker, so nothing is cached for offline use. The `theme-color` follows the light or dark theme. A phone's browser offers the install only over HTTPS; see the remote access guide.

  **Phone width.** Narrower than 640 px, the sidebar opens as a drawer over the page from the button at the start of each header, and closes on Escape, a tap beside it, or the move to another page. It keeps its own state and never changes the docked sidebar's collapsed setting. The board shows one column at a time, a screen wide with Needs you first, and stops at each column as it is swiped. An agent's page and a team's chats show the chat alone, and each card opens over the whole screen and closes back to the chat, without changing which cards the wide layout keeps open. The app fills the visible viewport (`100dvh`), so a phone browser's toolbars no longer cover the message box. Headers drop the GitHub star and other extras to keep their names readable, and New task's buttons wrap instead of running off the dialog.

  **Board header.** The board now has the sidebar button the other pages have, so a collapsed sidebar can be reopened from it without the keyboard shortcut.

- 72882bd: The Kanban board's lanes run unbroken to the bottom again. On a board with few cards, a faint line crossed every lane where its cards ended, left over from the rule that separates days in the Today, Week and Month views; those views keep it. Dropdown menus now fit their longest option, so the board's team picker reads "Growth" in full instead of "Gro..." when that team is checked, and the same holds for every other dropdown that was as narrow as its button, such as the Marketplace's sort.
- 6e612b1: Clawboo Native now runs on a local Ollama with no API key and no environment variable, as onboarding has always promised.

  Picking **Ollama** on the onboarding connect step used to record nothing. Without `OLLAMA_BASE_URL` set, the team you deployed next landed on Anthropic, no Boo Zero was created, and the first team message answered "Clawboo Native has no provider key connected". Even with the variable set, every deploy row read "Clawboo Native unavailable" and the 1:1 chat stayed disabled with a "Disconnected" badge while team chat worked.

  Clawboo now records the Ollama choice itself, and that choice counts as a connected provider everywhere: the runtime reads Connected, agents deployed without a model pick run on Ollama, Boo Zero is created on it, and both team chat and 1:1 chat work. Ollama is reached at `http://localhost:11434/v1`, or at `OLLAMA_BASE_URL` when you set one. Pull the model first (`ollama pull llama3.2`, the default).

  You can also turn Ollama on or off later from **Settings → Runtimes → Clawboo Native → Manage**, which now lists it beside your provider keys, with its default model and a **Disconnect Ollama** that leaves your keys alone.

- cece4c4: An approval nobody answers is now closed as soon as Clawboo stops waiting for it. When a connector call, Clawboo Native command or risky hand-off runs out of time, Clawboo marks the request expired and writes `approval_resolved` with the decision `expired` right away. Before, the request stayed pending for up to 25 hours, until the hourly cleanup found it. In that time the event log heard nothing, and the agent's link to the connector on the graph stayed amber as if a call were still waiting. An answer that arrives after a request's time is up is now refused with `409 approval expired` instead of being recorded, so a late **Always** no longer saves a rule for a call that never ran. The graph and the `pendingApprovals` count in `GET /api/capabilities` now count only requests that can still be answered.
- 6ce571a: Images in an agent's markdown no longer load on their own. An image in chat, a task's report or its comments used to load from wherever its address pointed as soon as it was shown, so an agent steered by something it read could send data out in that address. It now shows as a link named after its alt text that opens only when you click it; an address that is not a web or same-site one is only named.
- fd1475d: A Marketplace deploy now starts each member on a runtime you have connected. When the suggested runtime is not connected, the member moves to the first one that is: Clawboo Native (with an API key or a local Ollama), then OpenClaw, Claude Code, Codex and Hermes. With only a ChatGPT sign-in, that is Codex. It used to move every member to Clawboo Native, which cannot run without a provider. The note on the row now names the runtime it uses, for example "OpenClaw unavailable · using Codex".

  Pressing Deploy again after "No agents could be created" now works. The failed attempt left an empty team behind, and the retry tried to create a team with the same id, which the server refused. Clawboo now removes that empty team when no agent could be created, so the retry starts clean. If it cannot remove it, the message says so, so you can delete it before trying again.

- 8ddb4f9: `GET /api/mcp/config` checks the identity it signs, and the attach secret can be replaced without a restart. The route answers `400` with `unknown team: <id>` when `scopeTeamId` names no team, and `agent <id> is not on team <team>` when `scopeAgentId` is a Clawboo agent from another team. An id no Clawboo agent uses is still signed as given, for an outside agent's own identity. New `POST /api/mcp/attach-secret/rotate` (access cookie required while the gate is on) replaces the secret behind every `attachToken`, `scopeSig` and `provSig`: every URL minted before stops verifying, in every Clawboo process on the database, since the secret is no longer cached per process. Clawboo's runtimes get new URLs on their next run. A connected local OpenClaw Gateway is re-registered at once and, if it refuses the write, again over the next few minutes; the answer's `gateway` field (`updated`, `retrying` or `not-connected`) says which. It replaces the documented `sqlite3 ... DELETE FROM settings` recipe.
- 282b7c1: Close an access-gate bypass on installs behind a reverse proxy on the same machine. With `STUDIO_ACCESS_TOKEN` set, the gate skipped the cookie for any `/api/mcp/*` request from a loopback address, so that Clawboo's own runtimes could reach their MCP servers. A proxy such as nginx, Caddy or a Cloudflare Tunnel connector forwards every request from `127.0.0.1`, so anyone who could reach the proxy could use the Tasks, Memory, Tools and TeamChat MCP servers without the token, and could ask `/api/mcp/config` to sign them an attach URL for any agent, and with it that agent's connector grants.

  A loopback address no longer admits anything on its own. Every MCP attach URL Clawboo writes now carries an `attachToken`, derived from the install's attach-signing secret, and a cookieless request to an MCP server needs it. The token only counts on a request that dialed the loopback port directly: it is refused from another host and on any request that came through a proxy. `/api/mcp/config` always needs the cookie. The runtimes Clawboo spawns, the verification critic included, get the token automatically, and keep loopback off any HTTP proxy configured in the server's environment (`NO_PROXY`). A local OpenClaw Gateway is re-registered with the token on the next connect; a remote one is never handed it.

  If you attached an agent yourself by URL on an install with the gate on, copy the URL again from `GET /api/mcp/config` (sending the access cookie): the old one carries no token and now gets a `401`. The Claude Code snippet now quotes the URL so its query survives the shell, and the request log masks the token and the attach signatures. The self-host guide now says a reverse proxy needs the access token unless it authenticates requests itself, and shows how to deny the four MCP server routes at nginx, Caddy and a Cloudflare Tunnel.

- 282b7c1: Close two identity gaps in the MCP servers and harden the server's HTTP edge.

  **TeamChat no longer takes an author from tool arguments over HTTP.** A TeamChat session without a signed room-and-author binding used to accept `authorAgentId`, `teamId` and `roomId` from the model, so it could read any team's room and post into it as any agent. The verification critic and any run for a task without a team attach exactly that way. Such a session is now served no TeamChat tools, the same rule Tasks and Memory already apply to an unidentified caller. Runs with a team keep their bound tools, and the TeamChat stdio bin, where the operator is the caller, still takes identity from its arguments.

  **`create_subtask` checks the team.** On a session bound to a team, a parent task from another team is now refused with the same "not found" a read gets. Before, the new subtask inherited the other team, the cross-team write that `create_task` already refused.

  **The API routes match case exactly.** `/API/settings` and other case variants no longer reach the lowercase routes. The access gate already folded case, so nothing got past it, but the router now agrees with it.

  **A warning for a proxy with no token.** With `STUDIO_ACCESS_TOKEN` unset, the server now logs a one-time `SECURITY:` warning when a request arrives through a reverse proxy, since everything behind that proxy is then reachable without a credential. It never blocks a request.

- 6e612b1: Clawboo Native agents now run on the provider you picked as your default.

  A team deployed without a per-agent model pick used to take the first provider with a key in a fixed order (Anthropic, then OpenAI, then OpenRouter, then Ollama). An `ANTHROPIC_API_KEY` in your shell or in OpenClaw's `~/.openclaw/.env` therefore put every agent on Anthropic, a billed provider, even after you picked another provider as your default, while the deploy dialog still read "Default · <your model>".

  Agents now use your default provider whenever it is set up. The leader runs your default model and the specialists run that provider's faster, cheaper model. On Ollama every agent runs the model you picked, as long as Ollama still has it pulled. The fixed order only applies when you have no default, or its provider is no longer set up. Each row of the deploy dialog now names the model that row will actually get, so the leader and the specialists can read differently.

- 4f0c127: `POST /api/obs/ingest` is removed. Nothing in Clawboo called it: the server writes every event in the observability log itself. The read routes under `/api/obs/` are unchanged.
- 6e612b1: Clawboo Native now lists the models your local Ollama has actually pulled, instead of always offering `llama3.2`.

  Onboarding used to check only that Ollama answered. With Ollama running but `llama3.2` never pulled, you got through onboarding and then every run failed with "model not found".

  The onboarding model dropdown and the Ollama row in **Settings → Runtimes → Clawboo Native → Manage** now list the chat models your Ollama has pulled. Embedding models such as `nomic-embed-text` are left out, because they can't run an agent, and a model that can't use tools is marked. If Ollama is running with no chat model, both places say so and show `ollama pull llama3.2` with a **Check again** button. Continue on the connect step now also checks that the model you picked is pulled, and gives the `ollama pull` command when it isn't.

  Agents created without a model pick on Ollama start from your default Ollama model, or from `llama3.2` when none is recorded, and keep it when it's pulled. Otherwise they get the most recently pulled model that can use tools, the same one for the lead and the specialists, so Ollama doesn't swap models in memory between turns. The model the pickers preselect is a fallback recommendation worked out the same way from `llama3.2`. A run that still reaches a missing model, or one without tool support, now says which model and how to fix it instead of showing Ollama's raw error.

- 6e612b1: Setting up OpenClaw now works on a local Ollama. If Ollama is the provider you connected for Clawboo Native, **Set up OpenClaw** configures OpenClaw on it instead of asking for an Anthropic, OpenAI or OpenRouter key.

  `POST /api/system/auto-configure-openclaw` has a new Ollama step, the last one before the key prompt: a connected key, OpenClaw's own ChatGPT sign-in and the offer of that sign-in to a signed-in `codex` CLI all come first. It writes `OLLAMA_API_KEY=ollama-local` to OpenClaw's `.env` and a default model your Ollama has pulled, and points OpenClaw at `OLLAMA_BASE_URL` when you set one. Like the rest of the route it never replaces a default model you already set, and it keeps an `OLLAMA_API_KEY` that already has a value.

  The response also says whether Ollama has that default model. When it doesn't (or Ollama isn't running), the setup stops before starting the Gateway and shows the `ollama pull` command, instead of reporting a success whose first message would fail.

  `POST /api/system/configure-openclaw` now returns the `model` it wrote, which for Ollama can differ from the one requested.

- 6e612b1: Setting up or reconnecting OpenClaw now connects to the Gateway port in your OpenClaw config. `POST /api/system/auto-configure-openclaw` kept a `gateway.port` you had changed, but it always saved `ws://localhost:18789` as Clawboo's Gateway URL, so the Gateway started on your port while Clawboo tried to connect on 18789. The saved URL now uses the same port the Gateway route starts on.
- a029480: Connecting OpenClaw with a Google key now sets a Gemini model that still runs. Clawboo wrote `google/gemini-2.0-flash` as OpenClaw's default model, but Google shut that model down on 2026-06-01 and OpenClaw's config validation now rejects it as an unknown model. The default is now `google/gemini-3.6-flash`, Google's named replacement, and the OpenClaw model picker lists Gemini 3.6 Flash in place of Gemini 2.0 Flash.

  Setup never replaces a default you already have, so if an earlier version set `google/gemini-2.0-flash`, pick another model under **Manage > Default model**.

- 886ecb8: The OpenClaw model pickers show OpenClaw's live model catalog again on OpenClaw 2026.9. That version refuses to list models when several agents are configured and none is named the owner, which is typical of an install running a Clawboo team, so the pickers had quietly fallen back to Clawboo's built-in list and model context windows were unknown. Clawboo now asks again for your default agent (the one marked default, else `main`, else the first) when OpenClaw refuses, and leaves installs that list fine unchanged.
- 13ebc1a: The OpenClaw Node.js range now matches the OpenClaw release Clawboo installs. Since 2026.9.34, OpenClaw needs Node 24.22.1 or later on the 24 line, or 26.12.1 or later (`>=24.22.1 <25 || >=26.12.1`). `GET /api/system/status` used to report Node 22 and Node 25 as `sufficient`; on those versions npm quietly installs an older 2026.9 patch instead of the current one. It now reports them as not sufficient, and `node.required` shows the new range.
- 56216ee: An OpenClaw agent deleted while its Gateway is down no longer comes back. Before, only Clawboo's copy was removed: the next time the Gateway connected, the agent reappeared without its team and was then put into the first team. Clawboo now remembers the delete, sends it to the Gateway on the next connection, and keeps the agent out of the sidebar and the graphs until then. If the Gateway refuses the delete, for example because it is its only agent, the agent comes back.
- 6e612b1: `POST /api/system/configure-openclaw` with the `ollama` provider now writes a config OpenClaw can run. Before, every OpenClaw run on that config failed with "Unknown model: ollama/llama3.2", whether or not the model was pulled.

  OpenClaw only runs Ollama models once it has an Ollama credential, and Clawboo wrote none. It now writes `OLLAMA_API_KEY=ollama-local`, the local marker OpenClaw accepts, which isn't a secret.

  The default model is now one your Ollama has actually pulled: the requested model (or `llama3.2`) when it's pulled, otherwise the most recently pulled model that can use tools, the same pick a new Clawboo Native agent gets.

  If you set `OLLAMA_BASE_URL`, OpenClaw now uses that Ollama too. OpenClaw doesn't read the variable itself, so Clawboo writes it into OpenClaw's config.

- 8ef5824: Approving this device during OpenClaw setup no longer leaves the setup stuck. When the reconnect after approval failed, or OpenClaw still reported the device as unapproved, the approval card stayed on "Approved. Reconnecting…" with only Cancel to press. The setup now shows what went wrong with a Retry button, and Retry brings back a fresh approval card if the device still needs approving.

  In onboarding, pressing Escape on the team step to go back to Add runtimes no longer disconnects an OpenClaw Gateway you just set up there.

- 1a7a097: Creating an OpenClaw agent works on OpenClaw 2026.9. That Gateway refuses TOOLS.md, and Clawboo wrote one for every new OpenClaw agent, so **Create Boo** and Marketplace deploys failed partway: the agent existed in the Gateway without its AGENTS.md or its command permissions. Clawboo no longer sends TOOLS.md. A Marketplace member's tool notes, such as its skill list, now go into its AGENTS.md under a **Tools** heading, the same move `openclaw doctor` makes on upgrade, and members on other runtimes no longer get a TOOLS.md nothing reads. **Agent Files** no longer offers an empty TOOLS tab; a TOOLS.md that already has text still shows.
- 0f6724e: The Org chart's Radial layout no longer piles each team's Boos on top of each other.

  **Radial spacing.** Each team's Boos used to fan out so close together that they overlapped, and only the graph's settling animation pushed them apart. With "reduce motion" turned on in the operating system that animation never ran, so the Org chart, the screen the app opens on, showed every team as one stacked pile with the names printed over each other. The fans are now spaced so that no Boo, name or thought bubble lands on a neighbour: a big team's fan opens wider and reaches further out, and the ring of teams grows when their fans would meet. An Org chart already saved in Radial keeps its positions, which now settle apart instead of staying piled up; press Re-layout to move it onto the new spacing.

  **Reduced motion.** With reduce motion on, the graph now lands straight on the positions its animation would have reached instead of skipping that step, so Boos dropped onto each other, or drawn in by the agent browser, still end up apart. The camera's fit after a layout or a resize no longer glides either.

  **Zoom controls.** The Org chart and the Team graph beside a team chat now frame their Boos above the zoom and fit controls in the bottom-right corner, when they first lay out, when they are resized and when you press Fit to view, so the last Boo in that corner is no longer hidden under them.

- 1a7a097: Removing a route on the Org chart works without an OpenClaw Gateway, like adding one already did. Without a Gateway, **Remove Connection** on a route used to do nothing. If the agent's AGENTS.md cannot be read, the route now stays and **Failed to remove routing** appears, where it used to vanish from the canvas and come back later. The empty Org chart now says to create a Boo or deploy a team instead of "Connect to a Gateway to see your fleet."
- fd1475d: A task that was in review when Clawboo restarted now waits in Needs you, with a comment saying its run stopped, instead of going back to To do and running again on its own.
- c9215fb: The default browser access can browse. Playwright marks nearly every tool destructive, navigate and click included, so the write access each agent gets for the browser only allowed reading the page. The catalog now names Playwright's truly destructive tools itself (running arbitrary code and handing local files to a site); those still need admin access, and every other action works with write access and asks first under the default policy. Chrome DevTools marks nothing destructive, so the catalog names its two dangerous tools too: running script in the page and uploading a local file now need admin access.

  Neither browser can open the Clawboo dashboard. Both start with the dashboard's address on this computer blocked, on the port the server really uses, and Clawboo refuses any connector call that points at it, so an agent cannot use a browser to approve its own requests or give itself connectors. Other local addresses stay reachable.

- ff2108b: Keep scripts off in previews opened in a tab, accept a comment as yours only from the dashboard, and keep a parent Claude Code session out of agent runs.

  **A preview runs no script, even in its own tab.** The task drawer's **Preview** frame already ran no scripts, but **Open** loaded the same agent-built page in a tab of its own, from the dashboard's address, where its scripts ran and could call the API as you. Every preview response now carries `Content-Security-Policy: sandbox allow-same-origin`, the frame's own flags, so the page is just as inert in a tab. Styles and images still load.

  **Only the dashboard comments as you.** A comment posted as yours (`authorType: 'user'`) steers the agent doing the task, and any local program could post one with `curl`. `POST /api/board/:taskId/comments` now keeps `user` only for requests from the dashboard's own page, judged by the browser's `Sec-Fetch-Site` and `Sec-Fetch-Mode` headers. A `user` comment from anywhere else is saved as an agent comment: it is not delivered as your reply and starts no run, though like any comment a short line of it still goes to the team room, where the agents can read it. This is a speed bump, not a security boundary: a program running as you can send the same headers or write the database.

  **Agent runs no longer inherit a Claude Code session.** A Clawboo server started from a terminal inside Claude Code passed that session's `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` on to every runtime it started. They are now removed with the other scrubbed variables. Claude Code settings such as `CLAUDE_CODE_USE_BEDROCK` still pass through.

- d05bef7: Agent runs no longer outlive a Clawboo that stopped unexpectedly. When the server crashed or was force-quit, a Codex, Hermes or Claude Code run it had started, or a command you approved for an agent, could keep running and keep editing the task's folder after the next start handed that task back to the board. Clawboo now records every agent process it starts, and on its next start it stops the ones left behind by a server that is no longer running, before it hands their tasks back.

  It only stops a process it can show is the one it recorded: started during the current system boot, less than 12 hours ago, and before the record was written. A second Clawboo running on the same data folder keeps its runs. When the system cannot report when a process started, nothing is stopped.

- 9af28ef: Keys saved in Clawboo are now masked by value wherever Clawboo scrubs secrets before saving: tool-call records, observability events, governance audit entries, memory, run summaries and the verify gate's output. The scrub only knew the shapes of a few providers' keys, so a supported key of another shape (a Groq `gsk_` key, a Mistral key, an xAI `xai-` key) was stored in clear, for example when an agent ran `printenv GROQ_API_KEY`. Every provider key, connector credential and connector sign-in token in the vault is now replaced with `[REDACTED]` as written, inside JSON text and inside URLs, and the mask follows the vault as keys are added, replaced and removed. Values shorter than 12 characters are left alone so they cannot wipe ordinary words, and field names are never changed.
- c9215fb: "Do not ask again for this for 30 days" works on connector calls that change something. The box saved a rule, but a second risk check asked again on every call without reading it, so the prompt came back every time. That check now honors the rule. Calls that delete or destroy something never offer the box and always ask. Answers remembered by an earlier version, when the box could not stop these prompts, are cleared once on the first start after the upgrade, so none of them starts allowing changes nobody agreed to remember.
- 1a7a097: Boo Zero's Global Brief is gone. It was saved but never sent to Boo Zero, while its editor said it was read on every interaction. Boo Zero's Brief tab now holds only the display name, and `GET` and `PUT /api/boo-zero/global-brief` are removed. Team settings now say that a team's rules are read on every turn, and that its brief is read only when Boo Zero's own chat mentions the team.
- 1a7a097: Agents are no longer offered two tools that did nothing. `web_search` only repeated the query back and appeared once `TAVILY_API_KEY` was set, and `delete_path` deleted nothing. Clawboo's own tools are now `echo` and `note`; for web search, connect a search connector such as Exa and give it to the agents that need it.
- 48c6978: Routines run in a time zone you choose, one setting for every routine on the install and independent of the server process. They used to run in the process's zone, which in a container is UTC unless `TZ` is set, so a routine set for 9:00 ran at 9:00 UTC. The routine dialog now says which zone the time is in, with **Change** to pick another; it starts as the server's own zone, so an install that never sets one runs exactly as before. Changing it moves every armed routine's next run to the new zone, in the same write. A `once@` time typed in the dialog now needs a `Z` or an offset, because the browser and the server would otherwise each read it in their own zone. `GET` and `PUT /api/schedules/time-zone` read and set it, and `GET /api/schedules/occurrences` reports it. In `@clawboo/scheduler`, `nextOccurrence`, `probeCronSpec` and `occurrencesInWindows` take an optional IANA zone.
- 6e9d0bf: Hermes teammates get Clawboo's tools, Claude Code login and billing errors stop counting as finished work, and a task's verdict says who chose its check and whether its review happened.

  **Hermes.** Clawboo now attaches its Tasks, Memory, Tools and TeamChat servers through the `mcp_servers` block of the Hermes home's `config.yaml`, the only place Hermes reads them from. The servers go inside your own `mcp_servers` mapping when the copied config has one, so your servers keep working. A Hermes run also reports that it is still alive every minute, so a delegated Hermes task that works for more than eight minutes is no longer stopped as unresponsive.

  **Claude Code.** A run that ends on an API error (an invalid key, an expired login, a billing limit, a rate limit) now fails with the error and its cause, instead of finishing as done with the error text as its result.

  **Native agents.** Google agents default to `gemini-3.6-flash` (Google shut down `gemini-2.0-flash` on 2026-06-01), and Gemini 3 tool calls keep their thought signatures, so multi-step tool turns work. Anthropic runs, direct or through OpenRouter, use prompt caching, and cached prompt tokens are priced at the cache rates.

  **Verification.** A team can set its verify command with `PUT /api/team-verify-command/:teamId`; the gate runs it in place of the command in the task's `init.sh`, and new task worktrees are set up with it. Every verdict records where its command came from, and the task drawer flags a check the agent wrote itself. A review that failed or came back empty is shown as such instead of "Reviewed by".

- fd1475d: Disconnecting a runtime no longer deletes keys other runtimes run on. It deletes only the saved keys that runtime alone reads, keeps the rest for the runtimes still using them, and stops the disconnected runtime from using any key until you connect it again. The dialog now names each saved key it deletes and each one it keeps. Claude Code and Hermes can connect again with a kept key through **Use saved key**.
- 6f0cfca: After an update from the dashboard, the server restarts with the node options it was started with. A server started as `node --max-old-space-size=4096 dist/server.js` used to come back with Node's defaults. The inspector's options are left out, since the old server still holds its port.
- 6f0cfca: The dashboard's update can be turned off, and it is no longer offered where it cannot work.

  `CLAWBOO_DISABLE_SELF_UPDATE=1`, or `disableSelfUpdate` in the operator settings file, removes the **Update available** chip, makes `GET /api/system/self-version` answer as it does with `?local=1` (no call to npm's registry), and makes `POST /api/system/self-update` refuse with a message saying an administrator turned it off. Use it on an install that something else manages, such as a container image, a distro package or a service manager. A browser that last saw an update available checks again before showing the chip, so it does not linger after the switch, or after an update.

  Without it, a global install whose folders the server's user cannot write, such as a root-owned `/usr/local`, is no longer offered **Click to update**. The update there could only fail with a permission error or leave a copy that no longer matches what installed it. The chip copies the update command instead, and the update route refuses with the reason.

- 9af28ef: Two Clawboo instances served under different path prefixes on one hostname (`CLAWBOO_BASE_PATH` behind a reverse proxy) no longer share the dashboard's browser storage. Browser storage belongs to the hostname, not the path, so a new instance skipped its welcome screen because another one had finished it, and the theme, layout, board view, tour and update-check state carried over between them. Every key the dashboard stores now starts with the instance's prefix (`/a:clawboo.theme`), including the theme read before the page paints. A key saved by an earlier release, without the prefix, moves to the first instance that reads it, so an upgraded instance keeps its settings. An instance served at the root keeps its keys exactly as they are.
- 14f41d9: Five more of Clawboo's time limits now count only time the machine was awake, so closing a laptop's lid no longer fails work that was fine when the lid closed.

  - A run waiting for its turn on an agent that is busy with another run (up to 10 minutes) is no longer refused on wake. Before, the team delegation failed to start, a scheduled routine on that agent stopped firing, and a direct message got "This agent was busy" instead of an answer.
  - A task's verify command (10 minutes) that was still running is no longer killed on wake, which had marked the check as failed and used up one of the task's fix attempts.
  - A command you approved for an agent (5 minutes) is no longer killed on wake.
  - An agent's browser is no longer closed as idle (10 minutes) on wake, so the page it was working on survives.
  - A message steered into an OpenClaw run before the sleep can no longer end that run when the Gateway confirms it after the wake.

  Each limit still applies at its usual length, counted in time the machine was awake. A sleep of under about a minute can still count.

- 79e7ef1: Team work survives the machine going to sleep. Closing a laptop's lid while agents were working used to fail every in-flight delegation on wake: the time asleep counted as silence, so each delegate's task was blocked, its plan steps were cancelled, and the lead was told it had timed out although nothing was wrong. Clawboo's watchdogs now notice that the process was suspended, from the gap between two of their own checks, and leave that time out.

  This covers the team delegation watchdog (8 minutes, or 24 inside one long tool call), the per-session wedge timer that ended runs after 10 silent minutes, the run idle guard (30 minutes), the board sweep that releases tasks whose run stopped heartbeating, the 10-minute limit on a scheduled OpenClaw routine run, and the two-hour ceiling after which a team that looked silent was unloaded and its runs stopped. A delegate that really goes silent is still stopped at the same limits, counted in time the machine was awake.

- 1a7a097: System Health no longer reports problems that are not there, and says plainly when trace export is off.

  **OpenClaw Gateway check.** On an install that never set up OpenClaw, the check read **Degraded** on every start and the panel said "Running degraded." It now passes as skipped. It still runs, and still degrades when the Gateway is down, once Clawboo's settings name a Gateway or OpenClaw's `openclaw.json` exists.

  **OpenTelemetry.** The observability line read "OTel exporter active" whenever an OTLP endpoint was set, even though the npm package does not include the OpenTelemetry SDK and nothing was exported. It now reads "OTel exporter active" only when the exporter started, and "local event log (OTLP endpoint set, exporter not running)" otherwise. The **OTel exporter** check says when the SDK is missing. `GET /api/health` gains `config.otelConfigured`, and `config.otelActive` now means the exporter started.

- 4a3c306: A task that passed with debt opens in the task drawer again. Opening one used to replace the view with a "Couldn't load" error card, because the drawer could not show the open issues the check left. The Verification section now lists each open issue with its severity, what it is, and why it stayed open, for example `[security] Token logged in plain text: unresolved at cycle exhaustion`.

  The Verification section's warnings are easier to read. "Written by the agent", "Review did not complete" and "Review returned nothing" were small amber text below the WCAG AA contrast floor. They now use the regular text color with an amber warning mark beside them.

- 758b1e0: **Retry** and **Assign** on a task the task runner ran now run it through the task runner again, instead of handing it to team chat.

  The task runner runs agent Routines and `POST /api/runtimes/:id/run` on Clawboo Native, Claude Code, Codex and Hermes. It gives a run a git worktree when the task names a repository and checks the work before **Done**; team chat does neither. A rerun from the board used to go to team chat, so it lost both. The runner now saves what it ran a task with (runtime, agent, repository, kind and model), and **Retry** or **Assign** on that task runs it the same way again. **Assign** uses the new agent's runtime, and keeps the saved model only on the same runtime. A reply on the task and the automatic restart after a failed run go through the runner too. A rerun that cannot start, for example because a budget is paused, moves the task to Needs you with the reason, and a rerun of a task paused for a handoff runs to the end instead of pausing again. An agent on OpenClaw, which the runner does not run, still gets team chat, and a removed agent's task asks for an Assign. Tasks the runner ran before this version saved nothing, so their reruns still go to team chat.

- fd1475d: `POST /api/team-chat/exchange` runs its turns again. It used to cancel every exchange as soon as it started, because it took the end of the request body for a client disconnect. It now stops only when the client really disconnects.
- fa48533: Team chat's work check handles three rare board failures better. If a check could not run and the board would not move the task to Needs you, the task now stays in review and Clawboo tries the move again, instead of failing the run with the card still in review, where nothing picked it up. Work that failed the check is never marked Done, even when the board could not be read or did not take the move. If the check passed but the board would not mark the task Done, the update to whoever handed it out now says exactly that, instead of saying the agent blocked the task. And if a fix round cannot start, the later steps of the task's plan stay queued, so a Retry carries the plan on, as when a check fails for good.
- 6d95836: Team chat runs, and task runs that only read (research and review, routines included), now start in a folder of their team instead of Clawboo's own data folder. This covers Claude Code, Codex, Hermes and Clawboo Native agents. Each team gets one folder, `~/.clawboo/workspaces/<team id>` (under `CLAWBOO_HOME` when that is set), created so only your user can open it and shared by every member and every room of the team, so a file one teammate writes is where the next one looks. A read-only task with no team uses `~/.clawboo/workspaces/_no-team`. Before this, Claude Code, Codex and Hermes started these runs in the folder that holds Clawboo's database and saved keys. If the folder cannot be created, the run does not start.

  For Claude Code, Codex and Hermes this changes only the folder they start in: they still run with your full file access and with their own permission prompts off, as before. Clawboo Native agents now have their file tools (read, write and list files) in team chat and on read-only tasks, kept inside the team folder. Their file tools also no longer follow a symlink out of the folder they work in. A Native agent can run commands only if you switched that on for it, and it asks you before every command. OpenClaw agents are unchanged, and task runs that change files still work in their own copy of the repository.

  An agent's Workspace tab now shows its team folder, read-only, beside any task worktrees, so you can open the files your agents saved there. Deleting a team deletes its folder and those files too, and the delete confirmation says so. If the folder cannot be removed, the team is still deleted and a message says the folder stayed. Archiving a team keeps the folder.

- 3cd660b: Updating from the dashboard keeps working after the first update, and the OpenClaw Gateway starts again after an OpenClaw upgrade without a trip to the terminal.

  **Updates.** The dashboard server used to run inside Clawboo's own install folder, which `npm install -g clawboo@latest` replaces. After one update from the "Click to update" chip, the server and everything it started sat in a folder that no longer existed: the next update failed with "exit code 7", the OpenClaw Gateway could not be started, and the restart into the new version never came up. The server now runs in `~/.clawboo`, and a server that does start in a deleted folder moves to a valid one before it loads anything else, so the restart after an update comes up on the new version. Updating from 0.5.0 benefits too: the old version's update starts the new one, which recovers by itself.

  When an update fails, the chip now shows npm's own reason (a missing version, a network failure, a permission problem, a package whose install script failed) instead of only an exit code.

  **OpenClaw Gateway.** A newer OpenClaw can refuse to start until `openclaw doctor --fix` migrates data an older version wrote. When Clawboo starts the Gateway and OpenClaw asks for that, Clawboo runs `openclaw doctor --fix --non-interactive` once and starts the Gateway again, leaving any launchd or systemd Gateway service alone. A Gateway that fails to start for another stated reason now reports that reason at once instead of after a 60-second wait.

  **Board.** While one of a routine's runs is still going, the calendar marks the right next run: a later run the same day can be the next one, and a run is only shown as possibly skipped while it is the first still on the calendar.

- fd1475d: Checked task-runner work now has a fair first check. The agent is told before it starts, in its instructions and in the worktree's `TASK.md`, to set `VERIFY_CMD` in `init.sh` to the command that proves the work, so the first check no longer always fails on the placeholder. A task whose title or description names a risky action, such as deploy, delete, publish, production or secret, now always gets the reviewer, using the same words team chat uses to ask before a risky hand-off.
- fd1475d: The reviewer that checks larger or handed-off task-runner work now counts toward budgets. Its run is charged to the same agent, mission and team as the work it reviews and shows in Tokens Used. Completing a task's worktree through the API also works when the task is back in To do: an empty diff lands it in Done and a non-empty one runs the check, where before the task silently stayed in To do.
- 4e0c2da: Clawboo now works with a task worktree recorded in the work folder, `~/clawboo-work` by default (`<CLAWBOO_HOME>-work` when `CLAWBOO_HOME` is set, or `CLAWBOO_WORK_DIR`), where a newer layout keeps task worktrees, review checkouts and team folders outside `~/.clawboo`. New ones still go in `~/.clawboo`. This makes it safe to roll a version that keeps them in the work folder back to this one.

  Pausing and completing a task now act on the checkout the board records for it, where they used to rebuild the path under `~/.clawboo` and act on that; a record that is not the task's folder under `~/.clawboo/worktrees` or the work folder's `worktrees/` is refused before anything is removed. The work check runs in a checkout under either place and still refuses anywhere else, including the work folder's team folders and a checkout folder that is a link to somewhere else; it runs in the checkout's real path. A paused task's checkout is rebuilt where the board records it, and when a checkout has to be made again under `~/.clawboo` instead, the board records the new place. The worktree cleanup also removes old checkouts in the work folder's `worktrees/`, but only ones the board records, so a folder another install keeps there is left alone, and it marks a task's workspace stale only when the checkout the board records was the one removed. A repeat `POST /api/board/:taskId/workspace` returns the recorded checkout's path.

- 32f2095: Rebuilding a task's worktree no longer deletes uncommitted work, and the preview, the Workspace tab and the task drawer no longer follow a link an agent planted in its worktree.

  A task that runs again rebuilds its checkout from the task branch when Clawboo thinks the checkout is gone. That check answered "gone" whenever `git worktree list` failed, for example on a timeout, and the rebuild then deleted the folder, uncommitted changes included. Clawboo now tells "not listed" apart from "git did not answer". When git does not answer, the run does not start, nothing is changed, and the task goes back to To do with a `[not started: worktree unchecked]` comment. A checkout still on the task branch with nothing uncommitted is reused as it is, so files git ignores, such as `.env`, stay. Any other folder is replaced only when it holds nothing the rebuild would lose. One with uncommitted changes, files git ignores, a commit no branch holds, a repository of its own, or contents git cannot read is left as it is: the run does not start, and the task waits in Needs you with a `[blocked: worktree kept]` comment that names the folder. Startup cleanup skips such a folder instead of removing it, and `POST /api/board/:taskId/workspace` answers `409 unsafe_to_rebuild`.

  The artifact preview checked a file and then opened it by name, so an agent could swap the file, or a folder above it, for a link to another file between the two steps, and the server would send that file. The preview, the Workspace tab's file view and the task drawer's task files now open each file so that a link or a hard-linked file is refused, and check after the open that the file is still the one inside the worktree; on Linux that check asks the kernel where the open file is. A task file that is a link is left out of the drawer, and one cut at 256 KB says so. A preview file that exists but cannot be opened answers 500 instead of 404.

## 0.5.0

### Minor Changes

- fa4aa95: The Board is now a calendar and a task board at once: the status columns run across the top and the days run down the side, so every card sits in its status column on its day.

  **Days as rows.** Week is the default view, starting on your locale's first weekday; Today shows today alone with every card in sight, and Month shows every day of a month. All is the same board with one row instead of days, every task newest first, with the same columns, lanes and cards. Open work sits on the day it was added and stays in its row as it moves across the columns; work that reaches Done or Cancelled moves to the day it finished. Open work from before the range is gathered in an Earlier row, so a later week never hides something still in play; it opens by itself when it holds work that is running or waiting, and otherwise stays folded with a note of what it holds. It is a kanban first: each column is a lane in a faint wash of its own colour that runs unbroken down the board, and the days are fine rules inside the lanes. Every column fits a 1440-pixel window. The day column carries the calendar the way a calendar heads a day, the weekday over the date, with weekends shaded grey and today's date in a red circle, the only red on the board (focus rings are ink). Pick a date in the day column or the date picker to light its row across the board; pick it again or press Escape to put it out.

  **Cards without badge soup.** A card is an event chip in its column's colour, held at its top-left corner by a short bend of that colour that reaches further on hover. Its one detail row reads: the agent's Boo (or a dashed circle when nobody has it), the runtime's mark, one status mark (Verifying, or an amber cross or dashed circle for a failed or indebted verdict) or else the cost, and the stamp. Unassigned work no longer claims to run on OpenClaw. Finished work on a past day sits on plain paper. Drag a card from anywhere on it with a mouse; it lifts with its column's width, and a move that lands at once drops straight in, while a cancelled or confirm-gated one flies back. When an agent moves a card, its corner snaps on and a faint ring fades, and counts roll to their new number. Empty days collapse into a thin seam across the board, the way a spreadsheet shows hidden rows, with a handle in the day column naming the days it holds; click the handle or the line to open them. A day that holds only routine runs keeps a thin row with each run on one line. Today's row sits a little above the board, a plain sheet with a soft shadow, so the eye lands there first. A busy cell shows its three newest cards and then **+N more** (the card you just touched always stays in sight), and each card is stamped with when it was added or finished, or with how long its run has been going for work in progress. Finished work from a day gone by takes two lines, in All as in the calendar: its title on one, its details on the other. In a cell, the day's cards come before its routine runs, and runs on a busy day are one line except today's and the next one.

  **Routines on their days.** Every routine's upcoming runs appear in To do on the days they will run, as a dashed outline with a fine pencil hatch, the routine's name over its time, so they never read as tasks that already exist; the next run firms up to a solid edge. The Routines switch carries the number of upcoming runs. A routine that runs several times a day shows once with a count. Clicking a run shows its schedule in plain words ("Weekdays at 9:00 AM"), where it goes, its next runs and what happens when it runs, with **Run now** and **Open routine**, which opens the full routine on the board. The runs come from the new `GET /api/schedules/occurrences`, which projects armed routines onto the days the browser asks about, in the time zone the scheduler fires in, starting from the run the ticker has actually scheduled. Paused routines, routines stopped after a failure, spent one-time routines, routines whose team or agent can no longer receive a run, and OpenClaw's own cron jobs are left out. A **Routines** switch hides them.

  **Needs you lives in today.** Approvals and stuck tasks are waiting now, so they sit in today's row in the first column, as compact amber chips that say in amber why each one waits, with quiet Retry, Assign and Dismiss actions. Tasks that broke the same way share one card with Retry all and Dismiss all, which ask once and report once, and a card that no longer needs you fades away with focus handed on. On another week the column folds to a rail, and a **Needs you** chip in the time bar leads back to today whenever that cell is out of sight.

  **Since you last looked.** Back from being away, the line under the Board title says what changed meanwhile ("Since 2:10 PM: 3 done, 2 started, 1 new"), the cards that changed carry an ink dot until you look at them, **Show** steps through them oldest first, and **Mark seen** clears them. Your own moves and what changed while you watched are left out, and what you saw under one team filter counts under the others that show the same card.

  **Find.** The magnifier in the time bar, or **/**, finds any task by its title, agent, details or id, and any routine by name, grouped by where each sits against the range on screen ("In this week", "Before this week", "After this week"). Enter takes you to the card, even one tucked behind **+N more**; Shift+Enter opens it.

  **Getting around.** **Today**, the chevrons and a date picker on the range title move through time, and a new range slides in from the side you moved toward. While today is out of sight, the Today button points to it, and arriving there makes today's date ping once; **T**, the left and right arrows, and **D**, **W**, **M** and **A** do the same from the keyboard while the board has focus. Cancelled folds into a rail with its count until you open it.

  **Moving cards by hand.** A drop goes to the column under the pointer and nowhere else: letting go over a column that refuses the card, over Needs you, or outside the columns sends it back, where before it could land in whichever neighbour the lifted card overlapped, the folded Cancelled strip included. Needs you steps back with the other refused columns during a drag, and the card's own column no longer lights up as a target. In progress takes no card from another column and the task drawer no longer offers it, since moving a card there by hand started nothing; a card left there that way shows in Needs you as **Not started**, with Retry. Finishing a card yourself asks which day it finished when it sits on another day: today, the day it sits on, or another day from a small calendar, and the card lands on the day you pick (the board PATCH takes a new `completedAt`). Cancelling always asks first, because it cannot be undone, and cancels the later plan steps that were waiting on it. A failed check is asked about before the card moves. Moving a card an agent is still working on stops that run, so it no longer keeps spending and its late result can no longer re-stamp the card, cancel later steps or ask the lead to retry; back in To do it starts over with the same agent, and a card bound to an agent is picked up within seconds rather than at the next minute's check. Whoever delegated the task is told a person marked it done or cancelled it. A card with no agent dropped in To do goes straight to Needs you with Assign. While you drag, the outline sits where the card will land, the folded Cancelled strip says what letting go does, and a line under the card in your hand says when it keeps another day; after the drop one toast says what happened, with **Show** when the card went to a day the board is not showing, and the board scrolls the card into view. Cancelled opens only when it will show the card.

### Patch Changes

- 100fda0: Task costs are now honest, teammate replies stay out of the team chat unless you asked for them, and the team lead knows what each teammate does.

  **Task cost.** A task's cost is now the sum of every run of it, recorded on each run in the execution ledger. Failed, stopped and timed-out runs are counted, and a retried task no longer shows only its last run. When a runtime reports no charge, Clawboo prices the run from its token usage, or from prompt and reply length when there is none, and the card marks it as an estimate (`~$0.02 est.`). A task that has not run shows no cost instead of `$0.000`, and the drawer says "None recorded". The execution ledger names the runtime that actually ran. Claude rates were corrected to Anthropic's list prices (Haiku 4.5, Haiku 3.5, Opus 4.5 and later, Sonnet 5), and dotted model ids such as `anthropic/claude-haiku-4.5` now match their rate. `GET /api/board` rows carry `runCost`, and execution rows carry `runtime` and `costSource`.

  **Team chat.** A teammate's reply reaches the chat only when you addressed it or it is the lead's summary:

  - A teammate that handed part of its task to others and got the results back after finishing no longer answers in the chat as if you had asked. Its follow-up is added to its task card and passed to whoever gave it the task, so the lead's summary is what reaches the chat. A task you assigned keeps it on the card.
  - Stop now also stops a reply or task that was about to start (waiting behind another run on the same agent), and a run from before the Stop no longer starts new work after it or frees the slot of a run started after it.
  - A delegated task still waiting to start is no longer failed as silent after 8 minutes, and one released while waiting no longer runs into the chat.
  - A message you send an agent that is working on a task is always shown.

  **Team lead routing.** On the lead's turn, the team roster now lists each teammate with its runtime and a one-line role read from its `SOUL.md`, so Boo Zero routes work by what a teammate does instead of by name alone. Other turns still list teammates by name. OpenClaw teammates show only their runtime, because their files live on the Gateway.

## 0.4.0

### Minor Changes

- a28711e: Gmail, Slack, Jira and thirty-eight more, through Composio.

  Apps clawboo cannot sign in to on its own now sit in their own band on the
  connectors page. Paste a Composio project key once, press Connect on an app,
  approve it at the provider, and it stays connected. Every connected app also
  appears as its own node on the graph, attached to the agents that can reach it.
  That last part is deliberate: a single node marked Composio would hide the fact
  that an agent can read your email, where a Gmail node says it plainly, and a
  thing you can see is a thing you can take away.

  This replaces a first attempt that did not work, and the reason it did not is
  worth writing down.

  That version attached to Composio's MCP endpoint, which is the surface meant for
  MCP clients like Claude Desktop, and then tried to run product features by
  calling the model-facing meta-tools and reading their free-text answers. Every
  piece of machinery it grew existed to recover typed facts from prose: a JSON
  Schema sniffer that guessed argument shapes at runtime, a parser for status
  words, a retry ladder for a default action whose own description says it "always
  creates a new auth link", and finally a third loading state to cover a three
  second read on page load. Pressing Connect on an already-connected app minted a
  fresh consent link and sent the operator back to the provider, every time.

  Composio's documentation points applications at their API instead, and their own
  reference application does the whole integration in a few hundred lines, because
  a typed answer needs no recovery. This now does the same: one typed client, one
  call that says which apps are connected, one call that starts an authorization.

  Eight hundred and eighty lines went, and two hundred and forty came back. Gone
  with them: forty-one apps declared as catalog connectors that could never be
  launched and never held a session, the `brokeredBy` escape hatch and the eleven
  branch sites that existed to tell everything downstream that this kind of
  connector was not really one, and the schema inference layer entirely. The
  catalog is twenty honest connectors again.

  The key is written to the encrypted vault and never returned. Every response
  about it carries a boolean and nothing else.

- a28711e: Make the connector directory reachable, and give it its logos.

  Four hundred registry servers shipped and almost none of them could be found.
  The band holding them rendered only under the Unchecked pill or when a search
  found nothing curated, so the default view looked like the whole of clawboo's
  connector support at nineteen entries. Searching was the only other way in and
  it failed on the words people actually type: one curated match on a tag was
  enough to suppress the band entirely, so "search" hid sixty-seven registry
  matches behind a single hit and "file" hid twenty. A search now shows both
  populations, still under their own headings with their own counts.

  The sixty that did render were the wrong sixty. The snapshot is written in
  publisher order, so the visible page was every publisher sorting before
  `io.github` and the three hundred and twenty-seven entries under it could not be
  reached by scrolling at all. There is a Show more button now, and the band leads
  with the entries whose names clawboo recognises, which is the only signal
  available: the registry publishes no downloads, no stars, nothing.

  Logos where there are logos. brandMarks.ts claimed to be generated and had no
  generator, so its thirteen paths could not be reproduced or extended.
  scripts/generate-brand-marks.ts now builds it from simple-icons and reproduces
  all thirteen byte for byte, plus thirty-two registry entries that turned out to
  name something people know: Docker, GitLab, Instagram, Bitbucket, Wikipedia,
  QuickBooks, Zotero and the rest. Matching is conservative and every judgement
  call is a named alias, because a wrong logo says a server is official when it is
  one developer's project. Most registry servers have no logo at all, and those
  still draw a monogram rather than a borrowed one.

  Two rendering faults go with it. Brand marks were broken everywhere except the
  connectors panel: the stylesheet holding their colours mounted only there, so
  every mark on the graph canvas drew black on a transparent tile. And the
  monogram's letterform was fixed at a lightness chosen for a white page, which
  left it close to invisible in dark mode.

  The thread picker asks what kind first. Pulling a thread onto empty canvas
  opened one list of fifty-one rows with thirty-two skills above nineteen
  connectors, so the first connector sat past a full screen of scrolling. It now
  opens on three rows, Connectors, Skills and New agent, each carrying its own
  count. Typing skips the chooser and searches every kind at once, so anyone who
  knows the name pays nothing for the extra step, and the last row creates an
  agent named after the query. That also removes the second text field, which used
  to sit inside the list and fight the search box for keystrokes.

  Composio ships as a curated connector, which closes the hole where clawboo's
  own connectors stop. clawboo cannot register an OAuth app with Google or
  Atlassian or Salesforce, so there is no Gmail, Slack, Drive or Jira entry and
  there cannot be one. Composio brokers all of them.

  It needs no integration code and no pasted key. Its endpoint advertises its
  authorization server at the standard well-known path, that server offers dynamic
  client registration with PKCE and a public client, and clawboo's existing OAuth
  path handles the rest. It connects the same way Linear and Sentry already do,
  and there is no Composio-specific code anywhere in the repo.

  The connector says what it costs you, in its own detail view rather than in a
  document nobody opens: Composio signs you in to each app and keeps that app's
  tokens on its own servers, clawboo holds only a token for Composio itself, and
  anything connected through it is reachable by Composio.

- 4aaca7e: The agent and team catalog is no longer bundled into the published CLI. Browsing it now costs a thin index rather than the whole corpus. The grid reads a name, a summary, and the tags, and the two large fields it never displayed, the full instruction body and the skill text, accounted for most of what every install was carrying. Those load per entry, when you open one. A small compiled seed still ships so a fresh install has something to show before it has reached the network, and the rest is served from `catalog/`, which is excluded from the npm tarball. Each pack's bytes are checked against a recorded hash before anything parses them, so a truncated or altered file fails closed rather than being read.

  The catalog itself grew to nineteen packs, seventeen of them adapted from upstream community repositories under permissive licences, each pinned to the commit it was taken from. Every card and detail view now names where its content came from, giving the repository, the commit, and the licence, because this is community work rather than Clawboo's own. Clawboo does not review what these agents and skills instruct a model to do, and the marketplace says so at the point where you are choosing rather than only in the documentation. The final call on whether to run something is yours.

- a28711e: Make connectors something you turn on rather than something you configure.

  The Connectors tab used to answer "what is this" and leave "how do I get it" to
  you. Every card now carries a price and a verb: Ready, One click, Needs a key,
  Needs a folder, and the button next to it does that thing without opening
  anything. The shelf is ordered by how close each entry is to working, so the top
  of it is what you can have right now. The `npx` command, the pinned version and
  the paste-into-another-runtime block moved into a Technical details disclosure;
  they are one click away rather than the first thing you read.

  The `3/3 risk` chip is gone. It counted lethal-trifecta legs, which describe what
  a connector can reach rather than whether it is safe, and a bare fraction beside
  a name reads as a score. In its place the detail pane states the consequences in
  sentences, and lists the actual tools your agents can call once it is running.

  GitHub connects now. Its authorization server publishes no dynamic registration
  endpoint, so clawboo could never sign itself in, and the tile said so and stopped
  there. Its MCP server accepts a personal access token, which makes it one field.

  The Ghost Graph's buttons say what they do. `Detach` is now `Stop sharing`,
  because it revokes another agent's access and the old label read as "remove this
  connector". There is a real `Turn off`. `Sign in` runs the sign-in instead of
  showing a toast about it, and `Configure` opens that connector's card rather than
  dropping you on a panel with no indication which row was yours.

  Agents know what they could have, and can hand you the button. A user-facing turn
  now carries the connectors that are live, a few that are one click away with what
  each costs, and an instruction not to work around a missing one: no browsing to a
  vendor's site to read what a connector would return, and no asking you to sign in
  on its behalf. When an agent does need one, it names it and stops, and the answer
  arrives in the conversation as a card whose buttons are priced the same way the
  shelf prices them. Pressing one opens that connector's own page. Nothing connects
  on an agent's say-so.

  And the directory got much longer without getting less honest. 230 servers from
  the official MCP registry sit below their own divider, with their own count that
  never merges into the curated one, loaded only when you ask for them. clawboo has
  not read any of them and says so. Adding one shows you the exact command before
  anything runs, and on confirm it becomes your own entry rather than something
  clawboo vouched for.

  Every remaining seam between wanting and having got one click shorter. Saving
  what a connector asked for also connects it, in one Save and connect button.
  The folder and file fields carry suggestion chips computed server-side, so
  every chip is a path that exists on this machine. A search that misses
  everything says so, instead of showing a divider announcing an inventory of
  zero. And the pinned-version contract on community entries is now enforced by
  a real check rather than by spelling: a registry row carrying a dist-tag or a
  range is refused at ingest and again in CI, because a consent step that shows
  one command must never run another.

  The long tail is now drawn from the whole registry. The ingest paged through a
  name-sorted listing under a fixed page bound, which did not sample the registry
  so much as truncate it alphabetically: it stopped partway through the letter C
  and never reached the namespace where nearly every well-known open-source MCP
  server publishes. It now walks all 24,000 entries, asks for latest versions
  only, and picks the 400 by most-recently-maintained rather than by alphabetical
  position. Entries that collide on a name keep their publisher instead of
  silently dropping, because sixty-six servers are called some variant of "mcp".

  And the snapshot's digest is checked. It was recorded and never verified, and
  could not have been verified as written, because the recorded hash covered the
  generator's raw output while the committed bytes are the formatted ones. It now
  covers the file's canonical form, and `pnpm verify:connectors` recomputes it, so
  a hand-edited entry fails CI instead of shipping.

  Connectors is its own place now, in the sidebar under Marketplace. It was the
  fourth tab of a shop you visit once, which is the wrong shelf for the recurring
  errand of connecting the tools your agents actually use.

  The list looks like one too. Every connector carries its real logo, extracted
  from the public-domain Simple Icons set and committed rather than fetched, so
  the shelf still renders with the network off and browsing it still leaks
  nothing. A connector that is a capability rather than a brand gets a glyph for
  what it does; the unchecked long tail gets a monogram tinted from its own name.
  Cards became rows, the state pill became the button's verb, and a connected
  connector is a green tick with no sentence attached.

  The two lists are named for the reader: Popular and More connectors, each with
  its own count. The counts still never merge into one total.

- a28711e: Build the graph on the graph.

  The canvas could already author three kinds of edge: dropping a skill tile on a
  Boo installed it, dropping a connector tile shared it, and dragging Boo to Boo
  wrote a routing line. Every one of those gestures started from an 8-pixel
  transparent handle inside a ring that only opened on an unlabelled click, so the
  whole thing was unreachable. Releasing a thread on empty canvas hit a branch
  that returned with the comment "the gesture just ends".

  Every Boo now carries one visible port. Pull a thread and let go: on a node it
  connects, on empty canvas a searchable picker opens where you dropped, listing
  only what that thread can legally end in. Picking a row creates the thing there,
  already wired. Typing a name creates a Boo in the same team as the one you
  pulled from, already routed to it. Each Boo shows what it carries under its
  name, so the ring stops being a secret.

  Removing works the same way for everything. Click an edge and press Remove
  Connection in its panel, or select it and press Backspace: routes, skills and
  shares all come off, and a share carries an eight-second Undo. That Backspace is edge-only and
  sits beside React Flow's own key handling rather than enabling it, because the
  built-in path removes an agent from the screen without telling the server. Edges
  that cannot be removed say why rather than offering a delete that silently does
  nothing.

  Spawning no longer rearranges the canvas. A node with no saved position looked
  identical to a stale layout blob, so every spawn discarded every hand-placed
  position and re-solved from scratch: the node you dropped jumped, and so did
  everything else. A spawned node now records where it was dropped before it
  arrives.

  Configure on a connector tile is gone rather than relinked; it was the only
  button on that toolbar that navigated away. Edit personality and Edit files
  collapse into Open agent, because all three were the same call under three
  labels. Credentials, folder pickers, custom servers and team creation are absent
  from the canvas by design: each needs more than a name or a pick.

  Three older defects go with it. The canvas lock froze dragging and selection but
  left edge drawing live, so routing could be rewritten on a locked canvas. Two
  handlers returned early when there was no OpenClaw Gateway, which is every
  native install, silently swallowing connect and delete. And the agent detail
  view's smaller graph carried its own narrower copy of the connection rules, so a
  gesture that worked on one canvas snapped back on the other with nothing said.
  That graph now shares the rule and scopes it: it draws one agent, so routing and
  sharing say there is no second endpoint instead of validating and doing
  nothing.

- d549d80: Team memory is now a graph, and it learns which facts were worth keeping.

  Memory used to be a flat list behind the settings gear. It is now a sidebar
  view: facts cluster by what they have in common, similar facts link up, hubs
  draw bigger, and a procedure and its versions collapse into one node. Type to
  dim everything that does not match, press Enter to run a real search and light
  up the hits with their neighbours, click a node to read it in full and walk
  outward through its links.

  Underneath, recall got an opinion. Agents can now say whether a fact they were
  given actually helped, and those reports decay over thirty days, so a fresh
  correction outweighs an old success. A fact two different teammates found
  useful is preferred and gets surfaced first; one that misled someone is
  dropped from automatic recall entirely, though it stays searchable with its
  status visible. Recall also walks one hop out from its best matches, avoiding
  hub facts so a single popular note cannot crowd out the rest, and every
  recalled line now carries an id the agent can cite back.

  Facts also record where they came from: which agent, which runtime, which task.
  Provenance rides outside the signed scope, so it describes without granting,
  and an unverified session records nothing rather than something it made up.

  Nothing is required to get this. Without an embedding provider the graph builds
  from tags alone and says so plainly rather than quietly showing less.

- 0887faa: The board has a Needs you column, and a task you create goes to one agent.

  **New task** now asks for a team, then an agent on it, then the task. The task is bound to that agent and starts right away, or waits in To do while the agent is busy and runs when it is free. It shows on the board and as a card in the team chat, and only that agent works on it: the result lands on the task card, and the team lead is not asked to follow up. Before, a task created from the board was given to nobody and sat in To do.

  The Needs approval column is now **Needs you**, and it stays open when empty. Besides pending approvals, it holds every task nothing on the board will move by itself, with a badge saying why: Failed (Failed 3× after repeated failures), Timed out, Stopped, Needs review, Blocked, or Unassigned. Each card shows the error or reason and offers Retry, Assign, or Dismiss. Retry also works on a task Clawboo stopped retrying on its own.

  In review and Blocked are no longer columns. A task being verified stays in In progress with a Verifying badge, and a blocked task shows in Needs you. The task statuses themselves are unchanged.

  Task cards in the team chat have a Comments & activity button that opens the task's comment log and live activity inside the card, and an Open on board button that opens the task's full view on the Board. The task drawer shows the brief, the agent and team, and the comment log, and a stuck task can be handed to another agent from it.

  `POST /api/board` accepts `assigneeAgentId`, `POST /api/board/:taskId/retry` and `POST /api/board/:taskId/assign` are new, and board task rows carry an `attention` field naming why a task needs you.

  Fixed along the way:

  - A task handed to an agent while it was still replying in the chat was completed with that reply, and the task's own output then appeared in the chat. A task now waits until its agent is free.
  - A task update to the team lead listed work that had failed for good or been stopped as still outstanding, so the lead kept waiting on it.
  - A stuck task kept the chat's Stop button showing longer after every reply.
  - A team whose chat had board task cards but no messages showed the empty welcome screen and hid the cards.

- 94c9e25: Add a connectors directory to the marketplace and surface capability health on the Ghost Graph.

  The marketplace gains a Connectors tab listing 19 verified MCP connectors. clawboo now runs an
  outbound MCP client, so 18 of them connect from the tab itself: it starts a local server as a
  child process, or signs in to a remote one over OAuth and holds the connection. The tile says
  which of the two it is, and what the connector still needs from you first, whether that is an API
  key, a folder to work in, or a sign-in. GitHub is the one entry it cannot run, because that
  provider requires a pre-registered OAuth app; its tile says so. Every entry still carries a
  copy-paste config block for Claude Code, Codex or VS Code, which is the fallback for a runtime
  you would rather attach it to yourself.

  You can also add a server the catalog does not list, by giving clawboo the command or the URL.
  Credentials and OAuth tokens go into the encrypted vault, namespaced per connector, and are never
  returned by any API. A connector child inherits an explicit allowlist of environment variables
  rather than clawboo's own environment. Signing out deletes the tokens and stops the connection.

  On the graph, capability tiles now explain themselves. A single status badge follows a strict
  precedence, and the tooltip carries the diagnostics and the runtime's own remediation hint,
  which the graph previously computed and discarded. Connector tiles gained a source handle so a
  connector can be shared with a second agent, refused connections now say why, and tiles collapse
  to dots when zoomed out.

  Also fixes the MCP config transcoder, which claimed a comment-preserving merge but silently
  emptied the file it could not parse.

- b6528ee: The Scheduler is now Routines, and a routine goes where you point it.

  A routine is either a team task or an agent task. A team task posts its instructions into the team's group chat, addressed to the team's lead (Boo Zero), which answers or brings in teammates exactly as it would for a message you typed. The message shows in the chat under the routine's name, and the lead is told nobody may be watching, so it carries the work out instead of waiting on questions. An agent task gives one agent a task: the dialog asks for a team, then an agent on it, and the result lands on the task card, which the team chat shows too. The old "Its own life" choice, which created an OpenClaw Gateway cron job, is gone from the dialog. Existing Gateway jobs are still listed in their own section, where they can be enabled, disabled, run, or deleted.

  Every routine now opens. Its view says where it sends, what it does, and when it runs next, and lists its recent runs with how each went, linking an agent run to its task. A routine can be edited in place: who it is for, the instructions, the name, and the schedule, which now takes a custom cron expression with a preview of the next run.

  Fixed along the way:

  - An agent routine for a native, Claude Code, Codex, or Hermes agent failed with `dispatch refused: workspace_unavailable`. A scheduled task defaulted to a kind that needs a git worktree, and a routine has no repository to make one from. It now runs the way the agent works a task delegated in team chat. A routine given a `repoPath` through the API still gets its own worktree.
  - An OpenClaw agent's routine finished its task, but nothing led to the result. Its runs were recorded under the executor type the team engine uses for its own runs, so the engine treated them as its own and never reported them finished. They now record their own type, and each run links to its task, where the agent's report is.
  - Creating an OpenClaw Gateway cron job through the API paired an `agentTurn` payload with the main session, which the Gateway accepts and then skips on every fire, and updates were sent in a shape OpenClaw 2026.9 rejects. The session now follows the payload kind, and updates go under `patch`.
  - One long run held up every other routine until it finished, and Run now waited for the next rescan, up to a minute. Routines now start on time whatever else is running, and Run now starts within a moment. `CLAWBOO_ROUTINE_DISPATCH_DEADLINE_MS` is gone, since the scheduler no longer waits on runs.
  - A run that ended on a runtime error without a final message gave its reason only as `(no output)`. It now reports the error the runtime gave. A failed agent run's task moves to Blocked with a note naming the agent and the error, instead of sitting in To do where any agent could claim it. That holds when the run throws rather than failing cleanly too, including an OpenClaw run whose connection drops mid-stream, which used to leave its task In progress with nothing driving it.
  - A routine could be resumed through the API while a run was still in flight, which armed it to fire again on top of that run. Pause and resume are now refused until the run finishes, and a run's outcome only lands on a routine that is still running.
  - Cancelling a confirmation opened from inside a dialog, such as deleting a routine or a status change in the task drawer, also closed the dialog behind it. A confirmation now keeps its own clicks.

- 65c3c91: Clawboo can now be served under a URL path prefix. Set `CLAWBOO_BASE_PATH=/clawboo` and the whole app moves together: the dashboard, every `/api` route, the SSE streams, and the Gateway WebSocket proxy. This is for the case where Clawboo shares a hostname with other apps behind a reverse proxy, which previously could not work because the built dashboard asked for its assets and its API at the origin root and got a 404 for each one.

  The prebuilt bundle needs no rebuild to move. The server templates the mount point into the shell it serves, and the app reads it at runtime, so the same package that `npx clawboo` installs works at the root and under any prefix.

  The shell the server sends always carries the mount point, whatever spelling asked for it. That matters because a shell without it boots an app that addresses the origin root for everything, which on a shared hostname means handing clawboo's requests to a neighbouring app. Recognizing the shell is therefore a question for the filesystem rather than for string comparison, since more than one spelling names one file: the request and the shell are both resolved to their canonical paths and compared, which is what makes a case-insensitive volume, a symlink, or a percent-encoded name all land on the templated copy.

  Requests are stripped of the prefix before any routing or security check runs. That is deliberate and load-bearing: the same-origin guard and the access gate decide what to protect by matching on the API path, and anything they do not recognize is treated as a static asset and let through. Mounting the API somewhere they were not looking would have left every prefixed route unauthenticated. Stripping first means both keep the checks they already had, and the prefixed surface is enforced exactly as the root one is. The access cookie is scoped to the prefix, so a sibling app on the same origin never receives it. The unprefixed `/api` surface stays served for the loopback control plane that talks to it directly (the CLI discovery probe, the callback URLs handed to spawned runtimes, the self-update check) and stays exactly as gated as before.

  An invalid value makes the server refuse to start and say why, rather than quietly serving at the root and looking like a broken proxy. In development the Vite dev server still serves the dashboard at the root and proxies the API, so the prefix shapes only what the API server accepts. Leaving it unset keeps every behavior a previous release had, with one deliberate addition: the served shell carries a base tag naming its mount, which at the root is simply the root.

- 94c9e25: Add the grant spine: one row that is both the permission the tool broker enforces and the edge the
  Ghost Graph draws.

  Three tables (`connectors`, `capability_grants`, `approval_rules`) and a repository in
  `@clawboo/db`. A connector tile can now be dragged onto a second Boo to share it, and detached to
  revoke, backed by real `/api/grants` routes rather than an endpoint the UI hoped existed.

  The coupling is the point. The badge on a tile is not a second reading of a status column: the
  graph and the broker call the same `decideGrant`, over the same candidate rows, keyed the same way.
  An expired grant whose row has not been swept yet renders as expired, because that is what the
  runtime would do with it.

  What the gate governs is narrow and deliberate. Core builtins are clawboo's own verbs and stay
  ungoverned; a grant that could revoke them would be a switch for turning the product off. Every
  tool a connector supplies goes through the gate from the moment that connector is connected, so
  connecting one is also the act that puts it under governance.

### Patch Changes

- 9118670: Stop System Health reporting a permanently unreachable Gateway on an install where the Gateway is connected and serving.

  The boot probe is fired as `void runBootProbe(...)` at the same moment the Gateway connect starts, and its reachability check took a single instantaneous sample. On a healthy install that sample landed mid-handshake: the probe ran at +60ms and `hello-ok` arrived at +187ms, so the check read `connecting` and recorded a failure. Because `/api/health` serves `getLastBootReport()`, a snapshot taken once and never recomputed, that failure then stood for the life of the process. Every boot logged `Boot probe: running degraded`, and the System Health view reported `OpenClaw Gateway not reachable, serving last-synced agents from SQLite` about a Gateway that had been connected the entire time.

  The check now waits for the connection to settle, polling to the same 1500ms budget it already had rather than answering before the answer could be true. A Gateway that is genuinely down still reports unreachable and still only degrades, never fails the boot; it just takes the full window to say so. An already-connected Gateway answers immediately and pays nothing.

  The staleness of the snapshot itself is left alone: serving the boot report from GET is deliberate, and the "Re-run probe" button (`POST /api/health/recheck`) is the intended way to refresh it. What was wrong here was the probe sampling before the thing it measures could exist, not the caching. A warning that is always wrong is worse than no warning, because it teaches people to ignore the real one.

- 0a9620a: Upgrade an existing `clawboo.db` in place instead of silently skipping the change. The schema is bootstrapped by one `CREATE TABLE IF NOT EXISTS` block, and SQLite skips the whole statement when the table already exists, so a column added to an existing table never reached any database created before it: the upgrade looked clean and then failed at runtime on the first query that touched the column, with delete-and-recreate the only working repair. `ensureSchema` now reconciles first, reading the declared column set back out of that same DDL and adding whatever an existing table is missing, then applies the DDL batch. That order matters: a new column usually ships with an index over it, and `CREATE INDEX` on a column that does not exist yet would take the whole batch, and the boot, down. Both steps run in one transaction, so a failure leaves the file exactly as it was rather than half-upgraded. Parsing the DDL rather than hand-listing migrations keeps one source of truth, and a test asserts the parsed column set is identical to what SQLite creates from it. A column SQLite could never add to a database that already has rows now fails the build rather than a user's upgrade, and if one ever escapes that gate the bootstrap throws with a message naming the column and the remedy. The boot probe's schema check verifies the resulting columns rather than only that the tables exist, and treats a missing one as fatal. Columns a newer release added are left alone, so opening a newer database with an older Clawboo does not destroy them.
- 1211c16: Harden the server surface against hostile and malformed input, without changing what any of it does for a working setup. The HTTP API and the dashboard now carry request rate ceilings. The general ceiling sits far above what the dashboard's own polling produces, so nothing a real operator does approaches it, and the routes that cost the most per request get a much lower one: installing or reconfiguring a runtime, driving the gateway, launching a CLI sign-in, approving a device, and replacing the running binary. The point is that a runaway client or a script pointed at the port cannot drive those the way it could before.

  Task worktree paths are now validated where they are built rather than trusted where they are used. A task id has to be a single plain path segment before it can become a directory name or part of a branch name, and the two operations that recursively remove a checkout confirm the directory still belongs to the task naming it, so a malformed id or a doctored record fails loudly instead of steering a delete. The verification gate resolves its working directory inside Clawboo's own state directory before it runs a worktree-authored verify command through a shell. The per-identity runtime home checks the segment it derived rather than trusting the rewrite that produced it, and the CLI sign-in relay confirms a resolved binary is really the tool it asked for, so a lookalike earlier on PATH cannot be launched under that tool's identity.

  Text handling that reads model output or untrusted logs was rewritten to stay linear. Thinking tags, delegation and plan tags, and embedded tool-result blocks are now located by pairing each opener with the next closer in a single pass, rather than by a pattern that rescans the rest of the text for every opener that has no closer, which is exactly the shape a mangled tag stream from a weak model produces. Secret redaction got the same treatment for PEM private key blocks in both the display and storage layers, and several trailing-run patterns were replaced with plain string operations.

  Three smaller correctness fixes travel with it. Stripping HTML for context now repeats until the text stops changing, because removing one tag can splice its neighbours into a new one, and it decodes `&amp;` last so a sequence written to be read literally is not decoded twice. Markdown table cells in the team brief escape backslashes before pipes, so a member-supplied `\|` can no longer break a row into extra columns. The provider model cache derives its "is this the same key?" discriminator with a salted key-derivation function instead of a bare digest, since a fast digest of a credential with a short fixed prefix is close to a reversible lookup.

- 650525e: Enabling or disabling an OpenClaw Gateway tool from the Capabilities dashboard now works. The panel offered the button and the request came back rejected every time, because the rule for which rows a source can write was spelled out twice: once where a record is read back from the database, and once in the OpenClaw source that performs the write. They disagreed. The database copy said no OpenClaw config row is writable, which also caught the `tools.allow`/`tools.deny` rows that are in fact the one Gateway write Clawboo supports, so the dashboard rendered a button whose only possible outcome was a 422. Both sides now read one shared predicate, so what the panel offers and what the server allows cannot drift apart again. MCP connectors and plugins stay read-only, since writing those is still unimplemented.

  Fixed a second defect in the same write, which that gate had been hiding: it read the Gateway config from the top level of the `config.get` response instead of unwrapping the snapshot, so on current OpenClaw the existing tool lists read as empty and the patch replaced the whole `tools.allow`/`tools.deny` policy with just the tool being toggled. That would have discarded every other allow and deny entry, including the `sessions_spawn` and `sessions_yield` denies Clawboo relies on to stop agents spawning sub-agents. Toggling a tool now preserves the rest of the policy.

  A toggle attempted while the Gateway is offline now answers 503 with a plain `gateway_disconnected` rather than surfacing a raw error string in the toast.

- d549d80: Similarity links in Memory now actually appear.

  On a machine running Ollama without its embedding model, the graph said
  similarity was waiting on data while every saved fact quietly lost its
  vector. Clawboo now checks the model is installed, says plainly what is
  missing, and offers the fix in place: install the model from the app with
  progress, retry indexing, or switch provider. Facts saved while nothing could
  embed them are indexed in the background as soon as a provider can, and
  starting Ollama, pulling the model or adding a key takes effect without a
  restart.

  Local stays local. Once your memory has been indexed with Ollama, an OpenAI
  key is never used on its own, even while Ollama is down: switching is a button
  that says how many facts it sends, it lasts until Ollama is back or the key is
  disconnected, and Memory shows while it holds.

- ae22d01: Clawboo Native no longer lets an agent drift onto a provider it cannot reach. Three fixes, found by auditing a clean install with a non-Anthropic key. First, seeding a team with no explicit provider (`POST /api/onboarding/seed-native-team` with a bare body) now resolves the provider from what is actually usable instead of assuming Anthropic: the recorded leader-model pick when that provider can still run, then the first connected provider in priority order, and only when nothing is connected at all the old Anthropic fallback. Previously an OpenRouter-only user could seed a team whose agents were configured for `ANTHROPIC_API_KEY`, which passed every health check and then failed every run. A derived pick is recorded as the default leader model only when it can run, and the lazily created universal leader now ignores a recorded pick whose provider has since become unreachable, so neither path can mint a leader that cannot run. A recorded Ollama pick is always honored, since it is keyless and always routes, so choosing a local model is never quietly swapped for a billed provider.

  Second, `PATCH /api/agents/:agentId/model` now accepts an optional `provider` and moves `primaryProvider`, `primaryModel`, and `envVar` together, validating the provider name. The model picker in agent detail sends the provider of the group you clicked rather than guessing from the model id, which matters because the Anthropic, OpenAI, and OpenRouter groups fill with live model lists from the provider once a key is stored, and those ids are not in the curated catalog. Picking another provider's model therefore moves the agent to that provider instead of stranding it posting an unknown model to its old endpoint. An unknown provider is a 400 rather than being silently dropped, a model-only request still changes just the model, which is how a custom id for the current provider is set, and a custom id never re-points the agent's provider.

  The model picker when creating a team had the same blind spot with a quieter symptom: picking one of those live-listed models left the new agent on its provider's default instead, because the pick could not be matched back to a provider and was discarded. It now carries the group through as well, so the model you choose is the model the agent is created with.

  Third, agents now report `providerReady` on `GET /api/agents`: whether a key resolves for that agent's own configured provider, counting fallbacks exactly as the runtime router counts them. Runtime-level health stays deliberately permissive, green when any provider is connected, so this per-agent flag is what reveals an agent parked on a disconnected provider. The agent detail and chat headers show an amber "No provider key" badge with a shortcut into Runtimes for exactly that case, instead of a green badge over an agent that could never reply. The badge is informational and does not block sending, so fixing the key never leaves the composer stuck.

- 38d0111: Reuse one SQLite connection per process instead of opening one per request, and bound the write-retry budget to 1.5 seconds of wall clock so a contended write can no longer block the server for seconds at a time.
- 97bd237: Board statuses and the legal-transition table now come from one shared module (`@clawboo/board-core`) instead of four hand-maintained copies, so the board UI can no longer drift from the transitions the server enforces. The group-chat task card derives its status pill from the same module: a task with an off-list status now shows its raw status name instead of being mislabelled "Queued".
- 86ea611: Give team coordination an event plane and a liveness plane, so agents stop going stale mid-task. The board already carried state correctly, but nothing pushed a change to a running agent and nothing proved a run was still alive, which is why a cascade could look busy while everyone in it had gone quiet. Three things change. A post-commit board lifecycle bus now fires on every task create, release, status change and execution completion, and a durable per-agent mailbox delivers to a teammate exactly once across every channel it might arrive on: a digest at the start of the next run, a live signal into a native run already in flight, or a trailing block on the next MCP tool response, which is what finally reaches spawned runtimes like Codex and Claude Code mid-run. Liveness became a fact instead of a guess: every drain that claims a board task now heartbeats it every 30 seconds on a timer rather than on event traffic, so a working-but-silent run keeps proving itself, and the stale sweep that reclaims abandoned work dropped from an hour to three minutes without any risk of releasing live work. Orphan reaping on boot is liveness-aware, a drain that stops producing events is bounded by an idle timeout instead of hanging forever, waiting on a busy agent times out instead of wedging that agent's chat and schedules, and a user Stop is now durable so a restart cannot resurrect stopped work. A dispatch pump means delegation-derived work fires on its own instead of waiting for someone to type, bounded by a ledger fire policy so a permafailing task cannot loop. Orchestrator eviction is gated on quiescence, so walking away from a long cascade no longer aborts every delegate in it at the thirty-minute mark. The verification fix loop now runs outside the per-identity mutex, where it can actually acquire it, so a failed verification gets its retry instead of stalling.

  Two changes affect installs that already exist, so they are worth calling out separately. Native team agents now get the TeamChat MCP and a read-only Tasks MCP attached by default, where both were previously off: board writes stay engine-owned, because a model-issued create or claim races the orchestrator, but reads were never the risk and without them a leader could not see the board it presides over. And because nothing rewrites a stored agent's tools, agents created before this release are frozen with both switched off, which disables the coordination plane they are now expected to use. A one-shot repair therefore runs at first boot after upgrade and turns those two axes back on for existing native agents, leaving every other tool toggle exactly as the user set it. It runs once, records that it ran, and never reverses a later deliberate change.

- 9118670: Move the OpenClaw Gateway pin from `~2026.5` to `~2026.9`, and fix the four things that broke.

  The pin was never really a protocol pin, whatever the comment beside it said. Both lines speak connect protocol v4 and the Gateway accepts any advertised range containing its current protocol, so the range clawboo sends negotiates against either. Every real breakage was somewhere else, and each one was found by running against a live 2026.9.2 Gateway rather than by reading.

  **Agent creation.** OpenClaw 2026.9 keys the agent roster by id under `agents.entries` and treats the legacy `agents.list` array as an alias for it. The two cannot coexist: `list` alone still validates, but alongside `entries` it is rejected as `Unrecognized key: "list"`, and a Gateway that cannot validate its config does not start. Setting a per-agent model override appended to `list`, so on any install `openclaw doctor` had migrated, one model change wrote a config that would not boot. The write now targets `agents.entries`, folds a legacy `list` into it rather than writing both, sets `agents.ownership: "explicit"` when a write makes the roster multi-agent, and no longer removes an entry when its model is cleared, because under `entries` the key is the agent's roster membership and deleting it deletes the agent.

  **The capability toggles.** `config.patch` now refuses a patch that would shorten an array unless the caller names it in `replacePaths`, reporting `config.patch would remove entries from array path(s): tools.allow`. Capability toggles re-assert the whole `tools.allow` / `tools.deny` set, so the enable half kept working and the disable half was rejected outright. `encodeConfigPatchParams` derives `replacePaths` from the payload rather than making each call site remember to declare it, and deliberately skips object maps such as `mcp.servers`, which merge RFC 7386 style where a key is removed by sending it as null.

  **Chat sends.** Every send re-applied the agent's exec config to the session first, and `execSecurity` / `execAsk` are retired: they remain in the protocol v4 schema but any request carrying either, `null` included, is refused with `execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead`. That INVALID_REQUEST raised "Failed to apply execution permissions" on every message. Those fields are no longer sent from any of the three call sites. They are not replaced by `permissionMode`, which is not their equivalent: it also sets the session's filesystem boundary, so mapping the exec choices onto it would silently re-scope what every agent can read and write. `execHost` survives and is all that is sent; the exec posture lives in the per-agent approvals policy, which the Gateway still honours.

  **Approvals.** The browser socket declared no capabilities, and the Gateway registers an exec-approval route only for connections that declared `exec-approvals`. A run with no route is not queued for a human, it is denied: `exec denied: Headless runs cannot wait for interactive exec approval`. So the agent reported the command as blocked and no card ever appeared. Browser connections now declare it, and the full round trip was measured end to end: request, resolve, resolved, and the approved command's real output back in the transcript.

  **Client identity.** Browser connections announced `client.id: "openclaw-control-ui"`, claiming to BE the Gateway's own bundled Control UI. 2026.9 build-checks that exact id, so a browser making the claim whose `client.buildId` does not equal the Gateway's is refused with `protocol mismatch: Control UI updated; reload this page to continue`, a message that names a protocol and means nothing of the kind. clawboo has no Gateway build id and never will, so every browser connect failed and the dashboard sat on "No agents yet" while the server-side connection was fine. It now announces `webchat-ui`, the other allowlisted browser-UI id, which is not build-checked.

  **Node floor.** Checked against the range OpenClaw actually requires (`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`) instead of `major >= 22`, which passed a Node 22.12 that cannot run OpenClaw and a Node 23 that is excluded, and reported the machine ready right up until `npm install -g` refused. Onboarding shows the real requirement rather than "v22+ required".

  **Model refs.** Clawboo keeps writing `openai-codex/<model>` for the ChatGPT-subscription path. `openclaw doctor --fix` migrates that ref to the canonical `openai/<model>` and enables the `openai` and `codex` plugin entries the canonical form needs; writing `openai/*` without those entries stops the OpenClaw CLI, so the two halves cannot be separated and the docs now say so.

- 1a71521: Close out the remaining hardening on derived filesystem locations and the Windows shim launcher. A task's worktree directory is now pinned under the worktree root at the one place it is derived, so every consumer of that location, from provisioning through scaffold writes to the recursive cleanup, builds on a path that has already been checked, and the directory created for a fresh worktree is taken from that checked value rather than resolved a second time from raw inputs. A runtime's per-identity home gets the same treatment: the assembled path is confirmed to sit under the runtimes root before anything creates or hands out the directory that will hold a runtime's private state.

  The Windows `.cmd`/`.bat` shim route now double-quotes the resolved command token on the cmd.exe line instead of caret-escaping it. Quotes are what cmd.exe honours in the program position, so a resolved path containing spaces, ampersands, or parentheses stays one literal token, and a quote can never appear inside a Windows file name to close the wrapping early. The CLI sign-in relay also spawns its two modes as two distinct calls, the cmd.exe shim route and the plain no-shell argv route, so each spawn is exactly the mode it claims rather than a merge of both possibilities.

- 70841f3: Reject task dependency links that would introduce a direct or transitive cycle.
- b6528ee: Remove `POST /api/onboarding/seed-native-team`, the endpoint that created a two-agent "My First Team" (a Team Lead and a Coder).

  Onboarding stopped using it when the wizard started sending new users to the marketplace, where they pick a team and deploy it, so nothing in Clawboo called it. It stayed documented as a quick way to stand up a default team, which let a placeholder team appear that no user had chosen. The endpoint, its `seedNativeTeam` wrapper in `@clawboo/control-client`, and its docs are gone. Deploy a team from the marketplace, or through `POST /api/teams`, instead. The onboarding endpoints that record the native leader model are unchanged.

- 992b546: Bound task creation at the Tasks MCP boundary so a looping agent can no longer fill the board. `create_subtask` (and `create_task` with a `parentTaskId`) return a tool error once a parent has 24 live children or the task would nest more than 2 levels deep; a parentless `create_task` is rate-limited to 30 root tasks per rolling 5 minutes. Each check shares one transaction with its insert, so two attached runtimes racing the same parent cannot both slip past a ceiling. An unknown or empty parent id now returns a tool error instead of failing the tool call with a protocol error, and every refusal carries a machine-readable reason so a repeat offender trips the circuit breaker instead of looping. A parented `create_task` now inherits the parent's team. A dependency cycle over the REST board API returns 409 instead of 500, and the ancestor-chain walk terminates instead of hanging if a database has a corrupt parent cycle. Fix a related off-by-one that let the orchestrator create depth-2 tasks the executor then refused to run forever: the depth ceiling now lives in one shared constant, and the deepest task that can be created is also dispatchable. Hitting the per-turn fan-out cap now writes the `cap_hit` audit row the Governance dashboard has always documented. A multi-step plan emitted by a task already at the depth ceiling is now refused once, up front, instead of quietly creating every step one level too deep where nothing could ever run them.
- 7903898: A team-chat run that ends without an answer now says why. Previously this was a silent non-response: you sent a message, the agent showed Working for a moment, and then nothing arrived, which is indistinguishable from an agent that simply chose not to answer. The reason was written only to the observability log, where nobody looking at the conversation would find it.

  Two shapes of silence are covered. A run that fails before producing any text posts the reason, and the most common cause is also the most fixable, so an agent whose provider has no key is pointed at that runtime's settings by name rather than at a fixed one. A run whose stream simply stops without ever reporting a terminal now says that too, rather than leaving the chat empty. Both are posted as system messages, not as the agent's turn, so neither is mistaken for something the agent said or filtered out as a refusal.

  A run the server itself ended reports that too, naming the cause: a budget cap, or a run that went quiet long enough for the watchdog to end it. These arrive as ordinary aborts, indistinguishable from someone pressing Stop, so they were previously swallowed as if the silence had been chosen.

  Runs that should stay quiet still do. A run that dies part way through a reply commits the partial text it already streamed, which speaks for itself, and that now holds whether the run reported an error or its stream simply stopped: previously the second case cleared the reply off the screen and replaced it with a notice saying nothing had come back. A leader that delegates and has nothing to add speaks through the board. A delegated child run reports on the board too, where a notice would surface in a room the user never opened. And a run the user stopped is not a failure at all.

  Telling those apart needed a fix in the Claude Code runtime. Stopping one of its runs reported a crash rather than a deliberate stop, because that runtime, alone among the four, did not mark its own aborts. It now does, the way the native, Codex and Hermes runtimes already did. That also changes what the board does with a stopped run: previously a Stop was recorded as a failure, which blocked the task and cancelled whatever depended on it, and it is now released the way a stop should be.

- f1c95d0: Stop a replayed Gateway `chat:final` from re-committing a turn or double-billing its tokens, keep verbatim re-utterances in the transcript, and bound the rendered chat timeline with a "Load earlier messages" control.

## 0.3.1

### Patch Changes

- 8d96a6c: ---

  ## "clawboo": patch

  Team chat reliability, plus provider and model UX:
  - **Replies no longer vanish** — every streamed team-chat reply now commits to the transcript (or is cleanly cleared), so a delegating agent's message can't disappear on the next update or on reload. A native 1:1 reply that fails mid-stream is preserved instead of silently dropped.
  - **Live Working/Idle badges** — the sidebar agent and Group Chat status indicators update in real time for native / server-orchestrated team runs and native 1:1 chats, not just OpenClaw over a live Gateway.
  - **Runtime provider manager** — the Runtimes panel's Manage view for Clawboo Native, OpenClaw, and Hermes lists the LLM providers you have actually connected (synced with Settings → Providers), each with per-provider connect/disconnect, one-click reconnect using an existing key, and a default-model picker for Native. A native runtime with no key now honestly reads "Disconnected" with a "Set up in Runtimes" shortcut instead of a false ed".
  - **Reconnect any provider** — reconnecting Clawboo Native is no longer Anthropic-only; reconnect with any provider you have already configured.
  - **Two-layer team model picker** — when creating a team, pick a provider first (only the connected ones), then its model. The picker shows the exact default model that will run instead of an opaque "Recommended", and opens on the provider the current model actually belongs to.
  - **Onboarding tidy** — the Add-runtimes step shows connected providers read-only, with a Back button to the provider step where keys are added.
  - **Sidebar tooltip** — the mascot's hover tooltip appears promptly and reads "Boo Zero", matching what clicking it opens.

## 0.3.0

### Minor Changes

- d543d11: Native-first. Clawboo now runs Gateway-free on a single provider key: onboarding connects a key, optionally adds Claude Code / Codex / Hermes / OpenClaw, then deploys a real marketplace team. Adds a providers hub across ten providers with live model lists, per-agent runtime and model pickers, and a first-run capability tour. Native teams chat and delegate end to end, with orchestration running server-side so a cascade survives a tab close. The Ghost Graph gains runtime badges, model orbitals, and MCP connector nodes, so every agent surfaces its attached MCP and built-ins. A degraded Gateway no longer blocks the dashboard: a non-blocking banner offers the recovery that actually applies.

## 0.2.0

### Minor Changes

- The v0.2.0 liberated cut. Native agents are built in (paste a provider key, no external CLI), and OpenClaw, Claude Code, Codex, and Hermes join as peer teammates in one chat, sharing one durable board, one tiered memory, and one capability dashboard, all governed and verified. Includes the team-task scheduler, per-runtime native homes, an encrypted credential vault under `~/.clawboo/`, and a release-cut security audit. See CHANGELOG.md for the full arc.

## 0.1.9

### Patch Changes

- 53a05b2: Welcome redesign, lighter install, and team color collections:
  - **New calm Day-sky welcome** — a soft animated sky with drifting clouds (pure CSS/SVG) replaces the WebGL ShaderGradient atmosphere on the onboarding splash and home welcome, with a faint "boo-verse" of distant boo silhouettes drifting behind the clouds. The welcome is theme-independent (always the bright sky).
  - **Removed the WebGL/three.js stack** (`@shadergradient/react`, `@react-three/fiber`, `three`, `three-stdlib`) — smaller install/bundle, no GPU cost on first paint.
  - **Fresh installs default to light theme** so onboarding happens in light mode; switch to light/dark/system anytime after.
  - **Team color collections** — each team picks from 8 color palettes with per-team hue rotation, and the create-team preview matches the deployed palette (DB migration 0004).
  - **Token-usage tracking by team & agent**; onboarding flow improvements; removed the unused Ollama-check API.

- 6f718e2: Fixed a Windows hang in `/api/system/status` (hit by the onboarding DetectStep): the synchronous `where` / `which` binary probe (`findExecutable`) is now timeout-bounded, so a slow spawn under Windows Defender can no longer block the server's event loop and stall the request.

## 0.1.8

### Patch Changes

- 4ecda72: Light/dark theme with toggle + persisted preference, premium design-system pass (4-tier surfaces, type scale, motion), Atlas radial layout, GitHub star CTA, authentic provider brand marks + app-consistent model dropdown in onboarding, and onboarding-hang/atmosphere fixes.

## 0.1.7

### Patch Changes

- 9309ee0: Fix device pairing on fresh macOS installs (v0.1.7):
  - `POST /api/system/approve-device` now uses `spawnSync` for the `openclaw devices approve --latest` preview step so the CLI's preview-mode non-zero exit code no longer swallows the request-id stdout we need to parse. Step 2 (the real approval) keeps `execFileSync` but surfaces `stderr` / `stdout` from any thrown error instead of Node's `Command failed: <argv>` wrapper.
  - The onboarding wizard's `StartGatewayStep` now catches `GatewayResponseError { code: 'NOT_PAIRED' }` and renders the in-product `DevicePairingApproval` card inline. Users no longer have to do a manual page refresh to escape the wizard's "Something went wrong" panel on a fresh-install machine with OpenClaw 2026.5.x. After approval, the wizard auto-retries the connect and advances normally.

- 9038cab: Windows compatibility hardening (bundled into v0.1.7):

  **`.cmd` spawn failures**: Windows users hit "Network error" at the install-OpenClaw step because Node 18.20.2+ refuses to launch `.cmd` / `.bat` files without `shell: true` (CVE-2024-27980 hardening). The throw escaped the request handler after SSE headers were flushed and the browser surfaced the dropped connection as a generic network failure. Added `shell: isWindows` to six `child_process` call sites that target `.cmd` shims (detectOpenClaw, approveDevicePOST steps 1+2, installOpenclawPOST, gatewayControlPOST start, getModelsFromCli) and wrapped the two SSE-emitting sites in try/catch so synchronous spawn errors surface as clean SSE events instead of crashing the request handler.

  **Windows polish**: further testing surfaced four more issues:
  - `cmd.exe` console window popped up in front of the dashboard on every shellout — `shell: true` opens a visible console on Windows by default. Added `windowsHide: isWindows` alongside every `shell: isWindows` (six sites).
  - CLI dashboard poll timed out after 15s — bumped to 45s (90 × 500ms) in `apps/cli/src/index.ts` because the bundled CJS cold-boot on Windows is slow (Windows Defender real-time scanning + Node's first-load module compile).
  - `agents.create` timed out at 30s on team deploy — bumped the gateway-client's default RPC timeout from 30s to 60s and added per-call 120s overrides to `agents.create` and `agents.files.set` to cover the worst-case OpenRouter model-capabilities fetch on Windows (observed up to 74s in user logs).
  - "Retry" button at the Gateway-start step didn't recover (only page refresh did) because the 15s server-side polling fired before the Gateway finished binding (~51s on Windows), and a Retry click would spawn a duplicate openclaw process racing the first for port 18789. Bumped server polling to 60s (120 × 500ms), extracted the polling loop into a `pollUntilReachable` helper, and added a mid-launch detection check via `readGatewayPid` + `isProcessAlive` — if a previous request already spawned the Gateway and its pid is alive, the new request joins the existing polling instead of spawning a duplicate.

  All of the above are no-ops on Unix; macOS compatibility is preserved.

## 0.1.6

### Patch Changes

- 7a8c3ff: fix(bootstrap): always verify OpenClaw install state instead of trusting stale localStorage.

  Users running 'npx clawboo' on a machine where they'd previously
  onboarded an OLDER clawboo but then uninstalled OpenClaw got dumped
  straight to the 'Connect to an OpenClaw Gateway' screen. The connect
  attempt then failed with 'Gateway closed (1011): upstream error'
  because no OpenClaw was running, and there was no way to re-run the
  install wizard from that point.

  Root cause: GatewayBootstrap had a fast-path optimization that
  returned early when localStorage['clawboo.onboarded'] was set, never
  calling /api/system/status. localStorage persists by browser origin
  (localhost:18790) — it survives uninstalling the npm package AND
  clearing ~/.openclaw/. So a once-onboarded user couldn't re-enter
  the wizard even after a full system reset.

  Fix: always fetch /api/system/status. If OpenClaw is installed AND
  configured, mark onboarded (idempotent) and skip the wizard.
  Otherwise clear the stale localStorage flag and sw the wizard so
  the user can re-install + reconfigure. The on-disk system state is
  the source of truth; localStorage is just a hint cleared whenever
  they disagree.

## 0.1.5

### Patch Changes

- 1cc97fe: feat(connection): in-dashboard device pairing approval for OpenClaw 2026.5+.

  OpenClaw 2026.5.x dropped auto-pair-on-first-connect. Every fresh
  Clawboo install hits a NOT_PAIRED rejection on first connect, requiring
  the user to drop into a terminal and run two openclaw CLI commands.

  This release adds an inline "Approve this device" UI in the Gateway
  connect screen. When the connect throws NOT_PAIRED, the form swaps to
  a single button that hits a new POST /api/system/approve-device
  endpoint. The server shells out to `openclaw devices approve --latest`
  to extract the pending requestId, then `openclaw devices approve <UUID>`
  for the actual approval (--latest alone is a preview-only flag; the
  explicit ID is required for approval).

  After approval, the SPA auto-retries the original connect attempt with
  the same URL + token state. Users complete onboarding with a single
  button click instead of context-switching to a terminal.

  The approval UI also shows the manual CLI fallback (openclaw devices
  approve --latest → openclaw devices approve <requestId>) as a footer
  hint for power users who prefer terminal workflows or whose openclaw
  CLI is on a non-standard PATH.

## 0.1.4

### Patch Changes

- 68ebc29: fix: OpenClaw protocol-4 compatibility + Windows install support.

  Two independent blockers prevented users from completing onboarding:
  1. PROTOCOL MISMATCH. OpenClaw 2026.5.18 (latest) bumped the WS connect
     protocol from 3 to 4. Clawboo's gateway-client advertised maxProtocol: 3
     only, so every fresh install (which ran `npm install -g openclaw@latest`)
     got an incompatible openclaw and hit "Something went wrong: protocol
     mismatch" at connect time.

     Fix: bump maxProtocol to 4 in packages/gateway-client/src/client.ts.
     minProtocol stays at 3 so older openclaw (2026.3.x and earlier) still
     negotiates correctly. Also pinned the install spec to `openclaw@^2026.5`
     so a future minor bump landing protocol 5 doesn't silently break users.

  2. WINDOWS SPAWN ENOENT. Windows users saw `Error: spawn npm ENOENT` when
     clicking Install in onboarding, AND the OpenClaw detection step always
     reported "not installed" even after a successful manual `npm install -g`.
     Both root-caused to Unix-only commands: `execFileSync('which', ...)` and
     `spawn('npm', ...)` (Windows npm is npm.cmd).

     Fix: new apps/web/server/lib/platform.ts helper with findExecutable
     (cross-platform which/where) and resolveShimName (appends .cmd on
     Windows). Applied at system.ts:57+343, modelCache.ts:59, and
     processManager.ts:74 (which also gained a netstat-based fallback for
     port-to-PID lookup on Windows). CI smoke-test-bundle now runs on a
     matrix of [ubuntu-latest, windows-latest] so Windows regressions can't
     ship undetected.

## 0.1.3

### Patch Changes

- aef820f: fix(cli): HTTP-verify Clawboo identity during port discovery, don't TCP-probe blindly.
  The OpenClaw Gateway listens on auxiliary ports (18791, 18792) in addition to its main 18789. Those fall inside Clawboo's 18790-18809 fallback window. v0.1.2's `findRunningDashboard()` did a TCP-only probe, so when 18790 was free but 18791 was held by Gateway (or by Chrome's --remote-debugging-port, or any other listener), the CLI mistook the unrelated port for Clawboo's already-running dashboard, skipped spawning the bundled server, and opened the browser to that port's 401 page (rendered as "Unauthorized" plain text).
  Fix: new `probeClawbooDashboard()` does a TCP probe AND a Clawboo-shaped JSON check on `/api/settings`. Only ports that return a real Clawboo response are accepted.
  Also adds `scripts/test-clean-install.mjs` — a full clean-install simulation that boots a fake non-Clawboo listener on 18791 before invoking the CLI, guaranteeing this exact regression class can't ship again. Wired into both `ci.yml` (PR gate) and `publish.yml` (last-line defense before npm publish).

## 0.1.2

### Patch Changes

- e7b9363: fix(server): SPA root path now serves index.html in the bundled production server.

  Replaces an Express 5 wildcard catch-all (`/{*splat}`) that failed to match the bare `/` path under path-to-regexp v8 with a version-agnostic `app.use(handler)` SPA pattern. Also adds a `smoke-test-bundle` CI job that boots the bundled server and curls `/` so this class of bug can't ship again.

  Fixes the "Cannot GET /" that affected v0.1.1.

## 0.1.1

### Patch Changes

- be71923: First real release. Replaces the v0.0.0 / v0.1.0 placeholder builds.

  Ships the v0.1.0 marketplace-redesign milestone:
  - 304 first-class agent catalog entries across 3 sources (agency-agents, awesome-openclaw, clawboo builtin)
  - 82 workflow team templates (5 builtin, 5 agency-workflows, 42 awesome-openclaw, 30 synthetic excellence partitions)
  - 3-tab marketplace (Skills / Agents / Teams) with single-agent deploy flow
  - Atlas global org-graph + Group Chat team halos with Boo Zero as universal leader
  - Multi-agent orchestration: structured `<delegate>` protocol, multi-step `<plan>` state machine, parallel workstreams with auto-synthesis, relay-batching, override-fix retry
  - DelegationCards / PlanCards / WorkstreamCards with tint-aware borders, accordion topology, completion flash
  - Auto-install onboarding (Detect → Install → Configure → StartGateway → Team → Deploy)
  - Dynamic API port resolution (default 18790, auto-fallback through 18809) — never collides with other dev servers
  - Hybrid agent knowledge delivery (AGENTS.md essentials + CLAWBOO.md reference + self-documenting `[Team Update]` envelopes)
  - Local-DB ghost cleanup + per-agent KV cleanup on agent delete
  - 857 unit tests, 12 e2e tests, full CI gating via `pnpm verify:ingest` on marketplace codegen
