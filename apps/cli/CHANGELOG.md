# clawboo

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

- 0a9620a: Upgrade an existing `clawboo.db` in place instead of silently skipping the change. The schema is bootstrapped by one `CREATE TABLE IF NOT EXISTS` block, and SQLite skips the whole statement when the table already exists, so a column added to an existing table never reached any database created before it: the upgrade looked clean and then failed at runtime on the first query that touched the column, with delete-and-recreate the only working repair. `ensureSchema` now reconciles first, reading the declared column set back out of that same DDL and adding whatever an existing table is missing, then applies the DDL batch. That order matters: a new column usually ships with an index over it, and `CREATE INDEX` on a column that does not exist yet would take the whole batch, and the boot, down. Both steps run in one transaction, so a failure leaves the file exactly as it was rather than half-upgraded. Parsing the DDL rather than hand-listing migrations keeps one source of truth, and a test asserts the parsed column set is identical to what SQLite creates from it. A column SQLite could never add to a database that already has rows now fails the build rather than a user's upgrade, and if one ever escapes that gate the bootstrap throws with a message naming the column and the remedy. The boot probe's schema check verifies the resulting columns rather than only that the tables exist, and treats a missing one as fatal. Columns a newer release added are left alone, so opening a newer database with an older Clawboo does not destroy them.
- 1211c16: Harden the server surface against hostile and malformed input, without changing what any of it does for a working setup. The HTTP API and the dashboard now carry request rate ceilings. The general ceiling sits far above what the dashboard's own polling produces, so nothing a real operator does approaches it, and the routes that cost the most per request get a much lower one: installing or reconfiguring a runtime, driving the gateway, launching a CLI sign-in, approving a device, and replacing the running binary. The point is that a runaway client or a script pointed at the port cannot drive those the way it could before.

  Task worktree paths are now validated where they are built rather than trusted where they are used. A task id has to be a single plain path segment before it can become a directory name or part of a branch name, and the two operations that recursively remove a checkout confirm the directory still belongs to the task naming it, so a malformed id or a doctored record fails loudly instead of steering a delete. The verification gate resolves its working directory inside Clawboo's own state directory before it runs a worktree-authored verify command through a shell. The per-identity runtime home checks the segment it derived rather than trusting the rewrite that produced it, and the CLI sign-in relay confirms a resolved binary is really the tool it asked for, so a lookalike earlier on PATH cannot be launched under that tool's identity.

  Text handling that reads model output or untrusted logs was rewritten to stay linear. Thinking tags, delegation and plan tags, and embedded tool-result blocks are now located by pairing each opener with the next closer in a single pass, rather than by a pattern that rescans the rest of the text for every opener that has no closer, which is exactly the shape a mangled tag stream from a weak model produces. Secret redaction got the same treatment for PEM private key blocks in both the display and storage layers, and several trailing-run patterns were replaced with plain string operations.

  Three smaller correctness fixes travel with it. Stripping HTML for context now repeats until the text stops changing, because removing one tag can splice its neighbours into a new one, and it decodes `&amp;` last so a sequence written to be read literally is not decoded twice. Markdown table cells in the team brief escape backslashes before pipes, so a member-supplied `\|` can no longer break a row into extra columns. The provider model cache derives its "is this the same key?" discriminator with a salted key-derivation function instead of a bare digest, since a fast digest of a credential with a short fixed prefix is close to a reversible lookup.

- 650525e: Enabling or disabling an OpenClaw Gateway tool from the Capabilities dashboard now works. The panel offered the button and the request came back rejected every time, because the rule for which rows a source can write was spelled out twice: once where a record is read back from the database, and once in the OpenClaw source that performs the write. They disagreed. The database copy said no OpenClaw config row is writable, which also caught the `tools.allow`/`tools.deny` rows that are in fact the one Gateway write Clawboo supports, so the dashboard rendered a button whose only possible outcome was a 422. Both sides now read one shared predicate, so what the panel offers and what the server allows cannot drift apart again. MCP connectors and plugins stay read-only, since writing those is still unimplemented.

  Fixed a second defect in the same write, which that gate had been hiding: it read the Gateway config from the top level of the `config.get` response instead of unwrapping the snapshot, so on current OpenClaw the existing tool lists read as empty and the patch replaced the whole `tools.allow`/`tools.deny` policy with just the tool being toggled. That would have discarded every other allow and deny entry, including the `sessions_spawn` and `sessions_yield` denies Clawboo relies on to stop agents spawning sub-agents. Toggling a tool now preserves the rest of the policy.

  A toggle attempted while the Gateway is offline now answers 503 with a plain `gateway_disconnected` rather than surfacing a raw error string in the toast.

- ae22d01: Clawboo Native no longer lets an agent drift onto a provider it cannot reach. Three fixes, found by auditing a clean install with a non-Anthropic key. First, seeding a team with no explicit provider (`POST /api/onboarding/seed-native-team` with a bare body) now resolves the provider from what is actually usable instead of assuming Anthropic: the recorded leader-model pick when that provider can still run, then the first connected provider in priority order, and only when nothing is connected at all the old Anthropic fallback. Previously an OpenRouter-only user could seed a team whose agents were configured for `ANTHROPIC_API_KEY`, which passed every health check and then failed every run. A derived pick is recorded as the default leader model only when it can run, and the lazily created universal leader now ignores a recorded pick whose provider has since become unreachable, so neither path can mint a leader that cannot run. A recorded Ollama pick is always honored, since it is keyless and always routes, so choosing a local model is never quietly swapped for a billed provider.

  Second, `PATCH /api/agents/:agentId/model` now accepts an optional `provider` and moves `primaryProvider`, `primaryModel`, and `envVar` together, validating the provider name. The model picker in agent detail sends the provider of the group you clicked rather than guessing from the model id, which matters because the Anthropic, OpenAI, and OpenRouter groups fill with live model lists from the provider once a key is stored, and those ids are not in the curated catalog. Picking another provider's model therefore moves the agent to that provider instead of stranding it posting an unknown model to its old endpoint. An unknown provider is a 400 rather than being silently dropped, a model-only request still changes just the model, which is how a custom id for the current provider is set, and a custom id never re-points the agent's provider.

  The model picker when creating a team had the same blind spot with a quieter symptom: picking one of those live-listed models left the new agent on its provider's default instead, because the pick could not be matched back to a provider and was discarded. It now carries the group through as well, so the model you choose is the model the agent is created with.

  Third, agents now report `providerReady` on `GET /api/agents`: whether a key resolves for that agent's own configured provider, counting fallbacks exactly as the runtime router counts them. Runtime-level health stays deliberately permissive, green when any provider is connected, so this per-agent flag is what reveals an agent parked on a disconnected provider. The agent detail and chat headers show an amber "No provider key" badge with a shortcut into Runtimes for exactly that case, instead of a green badge over an agent that could never reply. The badge is informational and does not block sending, so fixing the key never leaves the composer stuck.

- 38d0111: Reuse one SQLite connection per process instead of opening one per request, and bound the write-retry budget to 1.5 seconds of wall clock so a contended write can no longer block the server for seconds at a time.
- 97bd237: Board statuses and the legal-transition table now come from one shared module (`@clawboo/board-core`) instead of four hand-maintained copies, so the board UI can no longer drift from the transitions the server enforces. The group-chat task card derives its status pill from the same module: a task with an off-list status now shows its raw status name instead of being mislabelled "Queued".
- 86ea611: Give team coordination an event plane and a liveness plane, so agents stop going stale mid-task. The board already carried state correctly, but nothing pushed a change to a running agent and nothing proved a run was still alive, which is why a cascade could look busy while everyone in it had gone quiet. Three things change. A post-commit board lifecycle bus now fires on every task create, release, status change and execution completion, and a durable per-agent mailbox delivers to a teammate exactly once across every channel it might arrive on: a digest at the start of the next run, a live signal into a native run already in flight, or a trailing block on the next MCP tool response, which is what finally reaches spawned runtimes like Codex and Claude Code mid-run. Liveness became a fact instead of a guess: every drain that claims a board task now heartbeats it every 30 seconds on a timer rather than on event traffic, so a working-but-silent run keeps proving itself, and the stale sweep that reclaims abandoned work dropped from an hour to three minutes without any risk of releasing live work. Orphan reaping on boot is liveness-aware, a drain that stops producing events is bounded by an idle timeout instead of hanging forever, waiting on a busy agent times out instead of wedging that agent's chat and schedules, and a user Stop is now durable so a restart cannot resurrect stopped work. A dispatch pump means delegation-derived work fires on its own instead of waiting for someone to type, bounded by a ledger fire policy so a permafailing task cannot loop. Orchestrator eviction is gated on quiescence, so walking away from a long cascade no longer aborts every delegate in it at the thirty-minute mark. The verification fix loop now runs outside the per-identity mutex, where it can actually acquire it, so a failed verification gets its retry instead of stalling.

  Two changes affect installs that already exist, so they are worth calling out separately. Native team agents now get the TeamChat MCP and a read-only Tasks MCP attached by default, where both were previously off: board writes stay engine-owned, because a model-issued create or claim races the orchestrator, but reads were never the risk and without them a leader could not see the board it presides over. And because nothing rewrites a stored agent's tools, agents created before this release are frozen with both switched off, which disables the coordination plane they are now expected to use. A one-shot repair therefore runs at first boot after upgrade and turns those two axes back on for existing native agents, leaving every other tool toggle exactly as the user set it. It runs once, records that it ran, and never reverses a later deliberate change.

- 70841f3: Reject task dependency links that would introduce a direct or transitive cycle.
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
