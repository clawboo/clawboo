---
title: Review and resolve approvals
description: Use the Approvals panel to allow or deny pending exec approvals, native run_command requests, and the shared tool/delegation queue.
---

Use this page when an agent pauses for your decision: an OpenClaw exec command waiting on a gate, a native Boo asking to run one program, or a brokered tool call / risky delegation queued for a human. All three surface in the **Approvals** panel, where you resolve each with an allow or a **Deny**, plus **Always** on the cards that offer it.

The panel renders three kinds of request, and they are wired differently:

- **Exec Approvals**: OpenClaw's command-execution gate. One request reaches you two ways at once. It arrives live over your own tab's Gateway connection, and Clawboo's server separately mirrors it into the shared `tool_call_approvals` table as a `kind='exec'` row, which is what keeps the card alive when no tab is open. Either card resolves back through the Gateway, and, when the agent is known, the decision is also logged to Clawboo's history table.
- **Native `run_command` approvals**: a [Clawboo Native](/runtimes/native) Boo asking to run one program, on a Boo whose shell you switched on. These are Clawboo's own rows end to end, and none of them is ever remembered.
- **The shared tool-approval queue**: Clawboo's own database-mediated handshake for brokered tool calls and risky delegations. The same queue (and the same resolve buttons) is reused by the [Governance dashboard](/using/governance-dashboard), so there is one resolve path, not two.

Below those, the panel lists the broker's tools with their availability, so you can see at a glance which tools are reachable.

## Prerequisites

<Note>
There is **no standalone Approvals nav view**. Approvals surface where they were raised, so you resolve them in context rather than on a separate screen. Whether anything appears at all depends on whether an agent is configured to ask before acting.
</Note>

- Approvals appear in two places, both always available:
  - The **Needs approval** column on the [board](/using/board), the first column. It collapses to a thin rail when empty and auto-expands the moment a request arrives.
  - An **inline tray above the composer** in [group chat](/using/group-chat) and 1:1 [agent chat](/using/agents), scoped to that team or agent (capped at three cards, with a "view on the board" link for the rest).
- For **exec approvals** to appear, the agent's command-execution policy must be set to ask. Open an OpenClaw agent, go to the **Permissions** tab → **Execution Permissions**, and set **Command Execution** to **Always Ask** or **Ask for Unknown**. Then ask the agent to run a command. It pauses and the request appears here. See [command permissions](/using/command-permissions) for what each posture means.
- For **native `run_command` approvals** to appear, the Boo's shell must be switched on (**Permissions** tab → **Running commands**) and the run must have a working folder, which in practice means a board task. Every native Boo created through Clawboo's own screens starts with that switch off.
- For **tool / delegation approvals**, no extra setup is needed; the broker writes a pending row when a risky or availability-gated tool call needs sign-off, and the governance delegation gate writes one for a risky delegation.

## Steps

### 1. Find the pending items and read them

Every surface is scoped. On the board, when a team is selected, exec approvals are filtered to that team's agents (requests with no `agentId` always show); selecting **no team** shows all. The chat tray is scoped to the team or agent you have open. Exec approvals are sorted oldest-first.

Each **exec approval** card shows:

- An amber "Exec Approval" label with a pulsing alert dot.
- The owning agent's name and a live `expires Ns` countdown. It counts down to the deadline the Gateway sent with the request; when a request arrives without one, Clawboo holds the mirrored card for 30 minutes.
- The command in a code block, plus any of `cwd`, `host`, `path`, and `security` as detail rows, and an error line if the request carried one.

Each **tool / delegation approval** card (in the queue below) is written for the person deciding, not for the system asking. It shows:

- The **app's logo and name** when the call goes through a connector, otherwise the agent's name, and a live `expires Ns` countdown.
- A **one-sentence headline** in the second person naming the actor and the effect, plus a short factual chip. The chip states what the call does and never reassures: an action is classified from its verb as **reads**, **sends**, **changes** or **destroys**, and an unrecognised verb falls to `changes` rather than to `reads`, so a call can never resolve downward into looking safer than it is.
- The **decisive fields inline** (who it is addressed to, what it is about, which file or record), with the rest behind one disclosure. Credential-shaped values are masked before display.
- The **agent's own words**, quoted and attributed, when it supplied a reason. They are never used as the headline.

When a request cannot be read confidently, the card says so and shows the raw detail rather than inventing a friendly summary.

### 2. Resolve each item

Every card carries an allow and a deny, and, where the decision can be remembered at all, a way to say so. The live exec card in your own tab has three buttons (**Allow Once**, **Always**, **Deny**). A card from Clawboo's own queue has two buttons plus an **Always** checkbox you tick before pressing allow, and on a command card the allow button reads **Run it** rather than "Allow".

| Action         | Exec approval                                                                                                                                                                                        | Native `run_command`                                               | Tool / delegation approval                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Allow Once** | Permits this single run                                                                                                                                                                              | Runs this one command; the next one asks again                     | Permits this single call (`allow_once`)                                                                                 |
| **Always**     | Asks the Gateway to remember this command in this folder, so it stops prompting. What it remembered then appears on the Boo's [Permissions tab](/using/command-permissions), where you can revoke it | Never offered                                                      | Mints a durable rule in `approval_rules`, bound to the grant, covering any arguments for that tool, expiring in 30 days |
| **Deny**       | Rejects the run                                                                                                                                                                                      | Rejects the command, and latches the tool for the rest of that run | Rejects the call (`deny`)                                                                                               |

What happens under the hood differs by surface:

- **Exec approval.** The decision goes to the Gateway via `exec.approval.resolve`, then (when the agent is known) is persisted to Clawboo's history through `POST /api/approvals`. The card buttons disable while the decision is in flight. After an allow, Clawboo runs a deterministic followup to recover the command's output in webchat-only setups where the Gateway's own delivery would otherwise drop it. One caveat: a decision made from a tab that has no Gateway socket of its own still reaches the Gateway, but writes no `approval_history` record and runs no output-recovery followup. The decision lands; the history entry does not.
- **Tool / delegation approval.** The decision is written to the `tool_call_approvals` row via `POST /api/tools/approvals/:id/resolve`. The broker (or the delegation gate) is long-polling that row in another process, so it unblocks the moment you resolve. The queue re-polls every 3 seconds, so the card clears on its own.

<Note>
Resolving the same tool/delegation row twice is a no-op; the resolve is guarded on `status='pending'`, so a stale double-click can't flip an already-decided approval. Answering the same exec card twice is safe as well: the second answer comes back as `alreadyResolved` rather than an error, and an exec approval that has already expired Gateway-side resolves silently (the card just disappears) rather than showing a confusing error.
</Note>

### 3. Watch the per-Boo indicator

While a Boo has an exec approval pending, its node in the [Ghost Graph](/using/ghost-graph) shows a pulsing **amber ring** around the circle. The ring is matched by `agentId`, so it points at exactly the Boo waiting on you. It clears the instant you resolve.

## An exec approval outlives your browser tab

Clawboo's server keeps its own long-lived connection to the Gateway and declares, as a browser tab does, that it can answer exec approvals. When a request arrives it mirrors it into the shared queue as a `kind='exec'` row, keyed by the Gateway's own request id, which is what makes a redelivered request land on the card that is already there instead of a duplicate.

What that buys you:

- **Close the tab** while a command is waiting and the card is still there when you come back.
- **Refresh** mid-decision and you get the same card, not a second one.
- **Open a tab halfway through the window** and the waiting command is already in the queue.
- Before this, a browser tab was the only connection that could answer, so a command raised with no tab open was not queued for later. It was refused outright, reported as `exec denied: Headless runs cannot wait for interactive exec approval`.

What the window actually is:

- The countdown is the deadline the Gateway sent with the request. When a request arrives without one, Clawboo holds the mirrored card for **30 minutes**, the window it expects the Gateway to be using.
- Once that passes, a sweep running every 30 seconds retires the row to `expired`. Deliberately not to `deny`: nobody answered, and recording an expiry as a denial would claim a human refused something nobody was asked about.

## Native run_command approvals

A [Clawboo Native](/runtimes/native) Boo can ask to run a program, but only when you have switched that on for it (**Permissions** tab → **Running commands**) and only on a run that has a working folder, which in practice means a board task. On 1:1 chat, team-room turns, dispatch turns, and on Windows, the tool is absent rather than gated, so nothing asks.

It raises the same command card a mirrored exec request does. The headline names the Boo and says it wants to run a command on this computer, the chip reads **Runs a command**, the **Command** and the **Folder** sit inline rather than behind the disclosure, and the allow button reads **Run it**.

What is different about it:

- **Run it or Don't allow, and nothing else.** There is no allowlist at this tier, so **Always** is never offered. A command you allow today asks again the next time, because an "Always" that behaved as an allow-once would be a control that lies.
- **The card does not tell you why.** The Boo supplies a one-sentence reason with the call and Clawboo stores it on the row, but the command card does not display it. What you see is the command and the folder.
- **The card is held for 10 minutes**, and the run makes no other progress while it waits. A card nobody answers blocks the task for the full window.
- **Ten commands per run.** After ten asks in one driver run the tool refuses to ask again. That ceiling is per driver run, not per task, so a task that is re-driven starts again at zero.
- **Declining can end the task, not just the command.** A refusal latches the tool for the rest of that run, and a second attempt trips the host circuit breaker, which aborts the board task.
- **It leaves no tool-audit row.** A `run_command` execution is not written to the tool audit, so it does not appear in `GET /api/tools/audit`.

<Warning>
The command on the card is the program Clawboo resolved and the program it will spawn, so what you approve is what runs, and it runs as one program with no pipes, redirects, or shell operators. Clawboo does refuse a list of 59 program names before it raises the card, and that list is a speed bump rather than a boundary: several ordinary programs reach a shell without appearing on it, and the repo carries a test asserting they are accepted so no future reader mistakes the list for a sandbox. **The person answering the card is the boundary.** An approved command runs in the Boo's working folder, as you, with access to the network.
</Warning>

## What the cards report

### Exec approval card

| Field                                | Source                                                         | Notes                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent name                           | Resolved from `agentId` (or the session key) against the fleet | Falls back to the raw `agentId` or "Unknown Agent"                                                            |
| `command`                            | The request payload                                            | Shown in a code block                                                                                         |
| `cwd` / `host` / `path` / `security` | The request payload                                            | Rendered as detail rows only when present                                                                     |
| `expires Ns`                         | `expiresAtMs − now`                                            | Counts down to the deadline the Gateway sent. A mirrored card that arrived without one is held for 30 minutes |
| error                                | The request payload                                            | Red line, shown only if set                                                                                   |

A card restored from Clawboo's own queue deliberately carries less than the live one. `host`, `security`, the resolved path and the session key are null rather than invented, so what you get back is the command and the folder.

### Tool / delegation card

| Field         | Source                        | Notes                                                                                                                         |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `toolName`    | The `tool_call_approvals` row | Input to `humanizeApproval`, not rendered raw. The card shows the app or agent and a plain-language effect instead            |
| `reason`      | The row                       | The agent's own words. Quoted, attributed, and marked unverified; never used as the headline                                  |
| `argsSummary` | The row (scrubbed JSON)       | Re-masked at display time. Decisive fields are lifted inline; the rest sits behind one disclosure rather than being truncated |
| `expires Ns`  | `expiresAt − now`             | The approval's own TTL                                                                                                        |

<Info>
**The two surfaces overlap now.** They still speak different decision strings: an exec decision is `allow-once` / `allow-always` / `deny` (with hyphens) and is logged to `approval_history`, while a tool or delegation decision is `allow_once` / `allow_always` / `deny` (with underscores) and is written to the `tool_call_approvals` row. What is no longer true is that they write different tables. A mirrored exec request is itself a `tool_call_approvals` row, carrying `kind='exec'`, and a native `run_command` request is a row in that same table under the ordinary `kind='tool'`. The buttons read the same in the UI; the wire values differ.
</Info>

## When Always is offered

**Always** is not on every card, and the card you are looking at decides it.

| Card                             | Where it comes from                                                    | Is **Always** offered?                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The live exec card               | An OpenClaw exec request arriving on this tab's own Gateway connection | Yes. All three buttons, every time, with no gate                                                                                          |
| A queue card, `kind='exec'`      | The same request, mirrored into Clawboo's queue by the server          | Only when the Gateway said it would accept an Always for this request                                                                     |
| A queue card, `run_command`      | A native Boo's shell                                                   | Never                                                                                                                                     |
| A queue card, tool or delegation | The broker or the delegation gate                                      | Only when the request was not raised as unrememberable, Clawboo read it confidently, and it was made under a grant a rule can be bound to |

On a mirrored exec card the answer is worked out on the server when the request arrives, not guessed at render time. **Always** is offered only when both of these hold, and withheld when either fails:

1. The request's `ask` is not `always`. A Boo set to **Always Ask** is a Boo that can never remember a command, so offering the button would be a control that lies.
2. The request's `unavailableDecisions` list does not contain `allow-always`. That is the Gateway's own statement about this particular request.

For a tool or delegation approval, a prompt is marked unrememberable when it is raised. That covers a call whose run has accumulated the [lethal trifecta](/appendices/glossary) and a call made after the run ingested untrusted content. Both are properties of _this run_ rather than of the tool, so a standing allow would authorize a future run that looks nothing like it. Clawboo also withholds it when it could not read the request confidently, and when the call was made through a brokered app rather than under a grant it could bind a rule to.

When the checkbox is there, its label tells you the scope of what you are about to remember: **Always allow this command in this folder** on an exec card, **Do not ask again for this for 30 days** on a tool or delegation card.

## Tool availability (read-only)

Under the queue, the panel lists every broker tool with an **Available** / **Unavailable** pill, sourced from `GET /api/tools`. A tool is unavailable when an availability requirement (auth, config, env, or plugin) is unmet; the card greys out and its tooltip shows the diagnostics. A non-`safe` risk tool also shows an amber warning icon. This is informational; there are no actions here; it tells you which brokered tools an agent can actually reach.

## Verify it worked

- The resolved card disappears from the board's **Needs approval** column (its amber count drops by one, and the column collapses back to a thin rail once the queue empties) and from any in-chat tray. For an exec approval, the Boo's amber ring also clears in the Ghost Graph.
- For an exec **allow**, the agent resumes and (after the followup) reports the command's output back into the chat transcript.
- For a tool/delegation approval, the waiting tool call / delegation proceeds (on allow) or is rejected (on deny) within a few seconds.
- The decision history is queryable: `GET /api/approvals?agentId=<id>` returns the persisted exec-approval decisions for that agent (most recent first).

## Troubleshooting

<Warning>
**A card vanished before you resolved it.** An exec card is retired when the deadline the Gateway sent with the request passes, and a mirrored card that arrived with no deadline is held for 30 minutes. An expiry is a non-decision, not a deny: the row is retired to `expired`, and nothing is recorded as a human refusing anything. Resolve promptly, or set the agent's policy to **Ask for Unknown** so only unfamiliar commands prompt. Note that retiring an expired exec card writes no audit row and emits no observability event, so exec timeouts are absent from the audit trail where other expiries appear.
</Warning>

<Warning>
**The agent allowed a command but produced no output.** In webchat-only setups the Gateway's internal `deliver:true` followup can drop the output. Clawboo runs a best-effort recovery that re-sends the command with `deliver:false`; if it still does not land, ask the agent to run the command again.
</Warning>

<Danger>
**Always outlives the run.** For a tool approval it mints a standing rule bound to the grant the call was made under, covering any arguments for that tool, and it expires after 30 days: a rule with no expiry would be a permission nobody revisits. Revoking the grant deletes its rules, so a later re-grant cannot silently inherit approvals you gave under different circumstances. Use **Allow Once** when you want to keep the gate for next time.

**For an exec approval, Always is no longer a one-way door.** The Gateway remembers the command, and what it remembered is listed under **Commands this Boo can run without asking** on the Boo's **Permissions** tab, where you can revoke it. See [command permissions](/using/command-permissions) for what each entry means, what revoking warns you about, and what it cannot reach. There is still no undo for the command that already ran.

**Sometimes there is no Always at all.** Which card you are looking at decides it, and a native `run_command` card never offers it. The cases are listed in _When Always is offered_ above.
</Danger>

## Related

- [Governance](/concepts/governance), how budgets, circuit breakers, caps, and approvals form the guardrail layer
- [Command permissions](/using/command-permissions), the standing grants an exec **Always** creates, and how to take one back
- [Governance dashboard](/using/governance-dashboard), reuses the same tool-approval queue
- [The Ghost Graph](/using/ghost-graph), where the per-Boo pending-approval ring renders
- [`/api/governance` reference](/reference/rest-api/governance), the `/api/approvals`, `/api/tools/approvals`, and delegation-approval shapes
