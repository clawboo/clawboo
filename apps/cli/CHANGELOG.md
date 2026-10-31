# clawboo

## 0.6.0

### Minor Changes

- 6ce571a: The Board is calmer and easier to read. It opens on Kanban, a dense status board with Needs you first, and keeps Today, Week and Month as its calendar views; a view you already picked is kept. Cards and lanes are neutral, with colour only in each column's status mark and amber for what needs you. Titles are 14px, times and costs use plain figures, and cards no longer tint, clip, lift on hover or roll their counts. The header is one bar: the title, the team, the Star and New task (C). The toolbar holds Find (/ or Cmd+K), Filter (by agent, tasks nobody has, or what is running now), Display (routine runs, the Cancelled column, cost and time on cards) and the view menu. A Needs you card shows why it waits and one action, with the rest in its menu. The task drawer reads like a document: the agent's report once, as markdown, then the brief, the properties, verification, the workspace, run history, comments and activity, each folding from its heading, and J and K step through the column. Loading, empty and filtered states match the board.
- 9bbe4f9: New task on the board now starts with one field: write what should get done and press Enter. It suggests who should do it by matching your words to each agent's name and the role in its SOUL.md, and otherwise suggests the agent you last gave a task to, then the team lead. A note beside the agent says why, and you can pick someone else; picking an agent also picks its team, so with the board showing all teams you no longer choose a team first. More options opens the full form with Team, Agent and Details.
- a9dddb7: Your reply on a task now reaches its agent whatever the task's status, and you can see where it went. A reply to a task that is waiting on you, or waiting in To do, starts the agent on it again, so answering a blocker no longer needs a second click on Retry; quick replies start one run between them. A reply to a running task goes into the run, and one to a task in review waits for the agent to read after the check. A task moved back to To do still reaches the agent it belongs to. A finished task cannot run again, so the reply is not sent and the note under it offers to send it as a follow-up task for the same agent. The board's task drawer now has a reply box, and both the drawer and the chat's task card show under each reply where it went. The chat card's Send and retry button is gone, since a reply now does both.
- 5e10613: A team now has chat rooms, a comment on a running task reaches the agent while it works, and the workspace around a team is rebuilt: a sidebar you can resize and hide, and cards beside every chat for its graph, tasks, browser and activity.

  **Steer a running task.** Comment on a task from a team chat's Tasks card, or from Tasks & Routines on the agent's page, and the agent working on it reads the comment during the run, instead of only at its next one. Native agents, Claude Code, Codex and OpenClaw take it at the run's next step without stopping anything; Hermes pauses the run and resumes the same session with your comment. The comment always lands in the agent's mailbox as well, so a task that isn't running yet still gets it. Codex runs are now hosted in `codex app-server`, which is what lets them be steered; an older Codex without it falls back to `codex exec`, where a comment waits for the next run.

  **Rooms.** Next to the team's own chat, now called General, a team can have rooms, each with a subset of its members. A room is its own conversation: its own transcript, its own task cards and its own graph, while Boo Zero still leads every room and the team's rules, brief, memory and board stay team-wide. Create a room from the sidebar's New room, then pin, rename or delete it from its menu. Deleting a room archives it: its conversation is kept and whatever it was working on stops.

  **Clear chat.** Every chat's menu, General's included, can clear it. The messages are set aside rather than deleted, the agents start that conversation fresh (OpenClaw agents are sent `/reset`, as typing it does), and the chat's timeline stops showing the task cards made before the clear; they stay on the board and in the Tasks card.

  **Sidebar.** Drag the agent column's edge to resize it (double-click resets it); drag it narrow enough, click its toggle or press Cmd+\ and it hides completely. While it is hidden, a toggle at the start of each page's header brings it back, and hovering that toggle shows the sidebar over the page without docking it. The top of the column shows the team's name, a search, and a grid of the team's agents with a dot on the ones working. Below them are the rooms, and the nav: Home, Org chart (the new name for Atlas), Board, Connectors, Memory, Marketplace and Settings. Fleet now lives in Settings, under Insights. Cmd+1 to Cmd+4 open Org chart, Board, Connectors and Memory.

  **Cards beside the chat.** An agent's page puts its chat on the left and cards on the right, each toggled from the chat's header: Graph, Tasks & Routines, Browser, Activity and Details (its workspace, personality, permissions and files). Tasks & Routines shows the agent's tasks and the routines that send it work, with New routine set up for that agent. A team chat stacks a Browser window, the team's (or room's) graph, a Tasks card and Activity: the Tasks card sorts the team's work into Needs you, In progress, To do, Done and Cancelled, and opening a task shows its progress and comments, with the comment box that steers its agent and a button to open it on the Board.

  **Home.** Each team has a Home page, the place its dashboards and its agents' artifacts will live.

  **Org chart.** With the browser panel open, the radial org chart turns around Boo Zero to bring the team you pick next to the panel, and picking an agent steps it forward while its teammates make room. Closing the panel or switching team settles the team back. The turn is remembered; the focus is not.

### Patch Changes

- 56216ee: Creating and deleting agents now works without an OpenClaw Gateway, and a new agent made on the Org chart always joins a team.

  **Create.** Create Boo shows on every install. A new Boo runs on OpenClaw while the server is connected to an OpenClaw Gateway and on Clawboo Native otherwise, and the dialog says which. It still joins the team selected in the sidebar. The graph's New agent, from a thread or the + button, follows the same rule; without a Gateway it used to fail with `gateway_disconnected`, and a new native agent now appears on the canvas at once instead of after a reload.

  **Delete.** The trash icon in the all-agents list and a team's Delete with agents no longer need a Gateway. Delete with agents removes the team's agents instead of leaving them behind, and its confirm mentions the Gateway only when the team has an OpenClaw agent.

  **Org chart.** A thread pulled off Boo Zero and let go on empty canvas gives the new agent the team selected in the sidebar, or the first team when none is, and the picker's New agent row names it. The agent used to be made with no team, and the Org chart did not draw it.

  **Select in sidebar** is gone from the graph's right-click menu. It never marked anything in the sidebar; Open agent does.

- 3c9e64b: An agent can no longer move a card back after you moved it. When you move a task on the board while an agent is still working on it, the run is stopped, but a coding agent could still call its task tools before the stop landed and put the card back where you took it from. Those status changes are now refused, with a message telling the agent the task's status is yours to set and not to try again. Once the task runs again, the agent's status changes work as usual.
- f272bc0: Loading the dashboard no longer counts against the API's request limit. The dashboard's script files, fonts and page shell were counted twice, once under their own limit and once under the API's, so a run of page loads could make the API answer "Too many requests" while API traffic itself was far below the limit. Those files now count only under their own limit, and both limits are unchanged.
- f272bc0: An agent's Boo no longer loses its body when another copy of it is mounted but hidden. With the sidebar hidden, its agent grid stays in the page for the peek panel, and a Codex Boo elsewhere (a card on the Board, for one) took its colours and outline from that hidden copy and drew only its eyes and paws. Every Boo now draws from its own copy, Codex, Claude Code and Hermes Boos and the generated mascot alike, wherever the others are and whether or not they are shown.
- 72882bd: The Kanban board's lanes run unbroken to the bottom again. On a board with few cards, a faint line crossed every lane where its cards ended, left over from the rule that separates days in the Today, Week and Month views; those views keep it. Dropdown menus now fit their longest option, so the board's team picker reads "Growth" in full instead of "Gro..." when that team is checked, and the same holds for every other dropdown that was as narrow as its button, such as the Marketplace's sort.
- 6e612b1: Clawboo Native now runs on a local Ollama with no API key and no environment variable, as onboarding has always promised.

  Picking **Ollama** on the onboarding connect step used to record nothing. Without `OLLAMA_BASE_URL` set, the team you deployed next landed on Anthropic, no Boo Zero was created, and the first team message answered "Clawboo Native has no provider key connected". Even with the variable set, every deploy row read "Clawboo Native unavailable" and the 1:1 chat stayed disabled with a "Disconnected" badge while team chat worked.

  Clawboo now records the Ollama choice itself, and that choice counts as a connected provider everywhere: the runtime reads Connected, agents deployed without a model pick run on Ollama, Boo Zero is created on it, and both team chat and 1:1 chat work. Ollama is reached at `http://localhost:11434/v1`, or at `OLLAMA_BASE_URL` when you set one. Pull the model first (`ollama pull llama3.2`, the default).

  You can also turn Ollama on or off later from **Settings → Runtimes → Clawboo Native → Manage**, which now lists it beside your provider keys, with its default model and a **Disconnect Ollama** that leaves your keys alone.

- 6ce571a: Images in an agent's markdown no longer load on their own. An image in chat, a task's report or its comments used to load from wherever its address pointed as soon as it was shown, so an agent steered by something it read could send data out in that address. It now shows as a link named after its alt text that opens only when you click it; an address that is not a web or same-site one is only named.
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

- 6e612b1: Clawboo Native now lists the models your local Ollama has actually pulled, instead of always offering `llama3.2`.

  Onboarding used to check only that Ollama answered. With Ollama running but `llama3.2` never pulled, you got through onboarding and then every run failed with "model not found".

  The onboarding model dropdown and the Ollama row in **Settings → Runtimes → Clawboo Native → Manage** now list the chat models your Ollama has pulled. Embedding models such as `nomic-embed-text` are left out, because they can't run an agent, and a model that can't use tools is marked. If Ollama is running with no chat model, both places say so and show `ollama pull llama3.2` with a **Check again** button. Continue on the connect step now also checks that the model you picked is pulled, and gives the `ollama pull` command when it isn't.

  Agents created without a model pick on Ollama start from your default Ollama model, or from `llama3.2` when none is recorded, and keep it when it's pulled. Otherwise they get the most recently pulled model that can use tools, the same one for the lead and the specialists, so Ollama doesn't swap models in memory between turns. The model the pickers preselect is a fallback recommendation worked out the same way from `llama3.2`. A run that still reaches a missing model, or one without tool support, now says which model and how to fix it instead of showing Ollama's raw error.

- 6e612b1: Setting up OpenClaw now works on a local Ollama. If Ollama is the provider you connected for Clawboo Native, **Set up OpenClaw** configures OpenClaw on it instead of asking for an Anthropic, OpenAI or OpenRouter key.

  `POST /api/system/auto-configure-openclaw` has a new Ollama step, the last one before the key prompt: a connected key, OpenClaw's own ChatGPT sign-in and the offer of that sign-in to a signed-in `codex` CLI all come first. It writes `OLLAMA_API_KEY=ollama-local` to OpenClaw's `.env` and a default model your Ollama has pulled, and points OpenClaw at `OLLAMA_BASE_URL` when you set one. Like the rest of the route it never replaces a default model you already set, and it keeps an `OLLAMA_API_KEY` that already has a value.

  The response also says whether Ollama has that default model. When it doesn't (or Ollama isn't running), the setup stops before starting the Gateway and shows the `ollama pull` command, instead of reporting a success whose first message would fail.

  `POST /api/system/configure-openclaw` now returns the `model` it wrote, which for Ollama can differ from the one requested.

- 6e612b1: Setting up or reconnecting OpenClaw now connects to the Gateway port in your OpenClaw config. `POST /api/system/auto-configure-openclaw` kept a `gateway.port` you had changed, but it always saved `ws://localhost:18789` as Clawboo's Gateway URL, so the Gateway started on your port while Clawboo tried to connect on 18789. The saved URL now uses the same port the Gateway route starts on.
- 56216ee: An OpenClaw agent deleted while its Gateway is down no longer comes back. Before, only Clawboo's copy was removed: the next time the Gateway connected, the agent reappeared without its team and was then put into the first team. Clawboo now remembers the delete, sends it to the Gateway on the next connection, and keeps the agent out of the sidebar and the graphs until then. If the Gateway refuses the delete, for example because it is its only agent, the agent comes back.
- 6e612b1: `POST /api/system/configure-openclaw` with the `ollama` provider now writes a config OpenClaw can run. Before, every OpenClaw run on that config failed with "Unknown model: ollama/llama3.2", whether or not the model was pulled.

  OpenClaw only runs Ollama models once it has an Ollama credential, and Clawboo wrote none. It now writes `OLLAMA_API_KEY=ollama-local`, the local marker OpenClaw accepts, which isn't a secret.

  The default model is now one your Ollama has actually pulled: the requested model (or `llama3.2`) when it's pulled, otherwise the most recently pulled model that can use tools, the same pick a new Clawboo Native agent gets.

  If you set `OLLAMA_BASE_URL`, OpenClaw now uses that Ollama too. OpenClaw doesn't read the variable itself, so Clawboo writes it into OpenClaw's config.

- 8ef5824: Approving this device during OpenClaw setup no longer leaves the setup stuck. When the reconnect after approval failed, or OpenClaw still reported the device as unapproved, the approval card stayed on "Approved. Reconnecting…" with only Cancel to press. The setup now shows what went wrong with a Retry button, and Retry brings back a fresh approval card if the device still needs approving.

  In onboarding, pressing Escape on the team step to go back to Add runtimes no longer disconnects an OpenClaw Gateway you just set up there.

- 0f6724e: The Org chart's Radial layout no longer piles each team's Boos on top of each other.

  **Radial spacing.** Each team's Boos used to fan out so close together that they overlapped, and only the graph's settling animation pushed them apart. With "reduce motion" turned on in the operating system that animation never ran, so the Org chart, the screen the app opens on, showed every team as one stacked pile with the names printed over each other. The fans are now spaced so that no Boo, name or thought bubble lands on a neighbour: a big team's fan opens wider and reaches further out, and the ring of teams grows when their fans would meet. An Org chart already saved in Radial keeps its positions, which now settle apart instead of staying piled up; press Re-layout to move it onto the new spacing.

  **Reduced motion.** With reduce motion on, the graph now lands straight on the positions its animation would have reached instead of skipping that step, so Boos dropped onto each other, or drawn in by the agent browser, still end up apart. The camera's fit after a layout or a resize no longer glides either.

  **Zoom controls.** The Org chart and the Team graph beside a team chat now frame their Boos above the zoom and fit controls in the bottom-right corner, when they first lay out, when they are resized and when you press Fit to view, so the last Boo in that corner is no longer hidden under them.

- 3cd660b: Updating from the dashboard keeps working after the first update, and the OpenClaw Gateway starts again after an OpenClaw upgrade without a trip to the terminal.

  **Updates.** The dashboard server used to run inside Clawboo's own install folder, which `npm install -g clawboo@latest` replaces. After one update from the "Click to update" chip, the server and everything it started sat in a folder that no longer existed: the next update failed with "exit code 7", the OpenClaw Gateway could not be started, and the restart into the new version never came up. The server now runs in `~/.clawboo`, and a server that does start in a deleted folder moves to a valid one before it loads anything else, so the restart after an update comes up on the new version. Updating from 0.5.0 benefits too: the old version's update starts the new one, which recovers by itself.

  When an update fails, the chip now shows npm's own reason (a missing version, a network failure, a permission problem, a package whose install script failed) instead of only an exit code.

  **OpenClaw Gateway.** A newer OpenClaw can refuse to start until `openclaw doctor --fix` migrates data an older version wrote. When Clawboo starts the Gateway and OpenClaw asks for that, Clawboo runs `openclaw doctor --fix --non-interactive` once and starts the Gateway again, leaving any launchd or systemd Gateway service alone. A Gateway that fails to start for another stated reason now reports that reason at once instead of after a 60-second wait.

  **Board.** While one of a routine's runs is still going, the calendar marks the right next run: a later run the same day can be the next one, and a run is only shown as possibly skipped while it is the first still on the calendar.

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
