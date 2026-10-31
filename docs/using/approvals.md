---
title: 'Answer approval requests'
sidebarTitle: 'Approvals'
description: 'What waits for your yes, where approval cards appear, what each button does, what Always remembers, and how long a request waits.'
keywords:
  [
    'approvals',
    'exec approval',
    'Allow Once',
    'Always',
    'Deny',
    "Don't allow",
    'run_command',
    'risky delegation',
    'risky hand-off',
    'Needs you',
    'approval queue',
  ]
---

Some actions wait for a person before they happen. Each one appears as an approval card, and nothing happens until you answer it or it runs out of time. Use this page when an agent is waiting on you, or when you want to decide what it may do without asking next time.

## What asks for your approval

| Request                                     | When it asks                                                                                                          | How long it waits                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A shell command from an OpenClaw agent      | When the agent's **Command Execution** setting says to ask. Agents you create in Clawboo start on **Ask for Unknown** | Until the OpenClaw Gateway's deadline, or 30 minutes when it sets none |
| A shell command from a Clawboo Native agent | Before every command, once you let the agent ask to run commands                                                      | 10 minutes                                                             |
| A connector call                            | When Clawboo rates the call as risky, for example one that changes or deletes something in an app                     | 5 minutes                                                              |
| A risky hand-off                            | When a leader in team chat hands off a task whose text contains a risky word                                          | 5 minutes                                                              |

Claude Code, Codex and Hermes never ask before using their own tools, such as their shell and file editing: Clawboo runs them with their own approval prompts turned off. Their connector calls and hand-offs still follow the rules above. [What agents can do](/concepts/permissions) explains what they can reach. [Command permissions](/using/command-permissions) sets when the two shell checks ask, and [Connectors](/using/connectors#when-a-connector-call-asks-you-first) lists which connector calls ask.

The risky-word check matches whole words, in any letter case:

- delete, destroy, deploy, publish, release, secret, credential, prod, production
- the phrases drop table and rm -rf
- api_key, api-key or apikey, and force-push, force_push or forcepush

Other forms do not trigger it: "deleted", "deployment" and "secrets" pass, and so do "API key" and "force push" written with a space. [Budgets and guardrails](/concepts/governance#approval-for-risky-delegations) has the full rules.

## Where approvals appear

- **Needs you** on the [Board](/using/board), the first column. It shows requests for the teams in the board's filter, plus Boo Zero's requests and any request Clawboo cannot tie to an agent.
- **The chat**, in a tray above the message box. A team chat shows that team's requests, and a one-to-one chat shows that agent's. The tray holds three cards, then a **+N more, view on the board** link.
- **The Tasks card** beside a team chat and the **Tasks & Routines** card on an agent's page, under **Needs you**.
- **Settings > Insights > Governance**, in the **Approval queue**. It lists every pending request from every team, or "No pending approvals".
- **Settings > Workspace > Capabilities**, at the top of the panel, while something is waiting.

Answer a request in any of these places and it clears from the others within a few seconds. A request that Clawboo cannot tie to an agent shows in every chat and under every board filter. Connector calls from OpenClaw agents arrive this way, because OpenClaw agents reach connectors without an agent identity.

## Read a card

Requests appear on two kinds of card.

### Command cards on the Board and in chat

On the Board, in the Tasks cards and in the chat tray, an OpenClaw agent's command appears on a command card:

- **Wants to run a command** with the agent's Boo and name, or in the chat tray an **Exec Approval** label (with the agent's name in a team chat).
- **expires Ns**: roughly how long is left.
- The command, cut off after about two lines.
- An error line, when your last answer did not go through.
- Three buttons: **Allow Once**, **Always** and **Deny**.

### Request cards

Every other request uses a request card, and so does every request in the Governance and Capabilities queues, OpenClaw commands included. A request card shows:

- For a call to an app reached through Composio, the app's logo and name. Otherwise the agent's name, or **Waiting on you** when Clawboo cannot tell which agent asked.
- A short label for the kind of action, such as **Runs a command**, **Reads only** or **Acts on your Gmail**, and the seconds left.
- One sentence naming the agent and what it wants, such as "Ada wants to run a command on this computer."
- The details that decide the answer, such as the recipient, the file or the command: two on the Board and in chat, three in the queues. A **Show N more details** link opens the rest, including any note the agent gave, which Clawboo marks as not verified.
- On some cards, a checkbox that remembers your answer (see [Answer a request](#answer-a-request)).
- An allow button named for the action, such as **Run it**, **Allow read**, **Send it** or **Delete it** (otherwise **Allow**), and **Don't allow**.

A request card shows a command in full unless it is very long, and adds the **Folder** it runs in when Clawboo knows it. A risky hand-off card names the leader, and the task text and the teammate it is for sit under **Show N more details**.

## Answer a request

| Request                                                   | Allow it         | Remember the answer                                                                                                                       | Refuse it                                                                            |
| --------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| OpenClaw command, on the Board or in chat                 | **Allow Once**   | **Always**                                                                                                                                | **Deny**                                                                             |
| OpenClaw command, in the Governance or Capabilities queue | **Run it**       | Tick **Always allow this command in this folder**, then **Run it**. The box appears only when the Gateway accepts Always for that command | **Don't allow**                                                                      |
| Clawboo Native command                                    | **Run it**       | Not offered: every command asks                                                                                                           | **Don't allow**. The agent cannot ask about another command for the rest of that run |
| Connector call                                            | The allow button | Tick **Do not ask again for this for 30 days**, then allow. Only some cards offer it                                                      | **Don't allow**. The call is refused                                                 |
| Risky hand-off                                            | **Allow**        | Not offered in the dashboard                                                                                                              | **Don't allow**. The hand-off is skipped and the leader is told                      |

A few details decide what you see:

- **Always on the Board and in chat.** The command card offers **Always** every time. When the Gateway does not accept it for that command, for example because the agent is set to **Always Ask**, the card shows an error. Choose **Allow Once** or **Deny** instead.
- **The 30-day box on connector cards.** It appears only when the call was made under access you shared with the agent, Clawboo could read the request, and the call is not one that must ask every time. A run that has read private data and also taken in outside content asks before any call that could send data out, and those cards never offer the box.
- **Hand-offs in a row.** A leader's hand-offs in one turn start one after another, so the hand-offs after a risky one wait for your answer too.

## What Always remembers

- **An OpenClaw command.** The Gateway lets that agent run the command in that folder without asking, with no end date. To take it back, open the agent's page, then **Details** > **Permissions**, and revoke it under **Commands this Boo can run without asking** (see [Command permissions](/using/command-permissions)). Revoking does not undo a command that already ran.
- **A connector tool.** Clawboo stops asking about that tool, with any arguments, for 30 days, for the access you shared with that agent. Calls that change or delete something still ask every time, because a second check asks about them whatever you ticked, and so do calls that must always ask. To end it early, stop sharing the connector with the agent on the graph ([Connectors](/using/connectors)). Sharing it again starts with nothing remembered.
- **A risky hand-off.** The dashboard never remembers one. An answer of `allow_always` sent through the API is different: that leader is never asked about a risky hand-off again, with no end date, and the dashboard has no control to undo it. Boo Zero leads its teams when it is available, so for Boo Zero one such answer covers every team.

<Warning>

Approve a command only when you understand it. An approved command runs on this computer as your user account, with network access. Clawboo cannot undo what it did.

</Warning>

## If nobody answers in time

- **OpenClaw command.** The card goes away and Clawboo records the request as expired, not as a refusal. Clawboo's server keeps a copy of each request, so the card waits for you even while no browser tab is open. If an open tab received the request live, the agent's one-to-one chat in that tab also notes that the approval timed out.
- **Clawboo Native command.** The command does not run, and the agent cannot ask about another one for the rest of that run. The run waits while the card is open.
- **Connector call.** The call is refused.
- **Risky hand-off.** The hand-off is skipped and the leader is told. When the hand-off came from a task, that task gets the comment `Delegation to <name> not approved (<reason>); skipped.`

## What a card does not show

- **The folder, on the Board and in chat.** A command card there shows only the command, and cuts a long one off. Open the **Approval queue** in **Governance** to see the full command and its folder.
- **Why the agent wants it.** No card shows an agent's reason for a command, even when it gave one.
- **Every field at once.** A request card shows the deciding fields first. The rest, and any note from the agent, are behind **Show N more details**.
- **Secrets.** Values that look like passwords or keys are masked.
- **An exact countdown.** The seconds left are worked out when the card is drawn, so treat them as approximate.
- **Past answers.** The dashboard keeps no list of requests you already answered. The audit log in **Governance** records risky hand-off decisions.

## Check that it worked

- The card leaves **Needs you**, the chat tray and the queues. When nothing is left, **Needs you** reads "Nothing needs you right now".
- An allowed command runs and the agent carries on. After **Always**, if the command's output does not reach the chat, Clawboo asks the agent to run it again so you see the result. The command is on the agent's list by then, so no new card appears. After **Allow Once** Clawboo does not do this; if no output appears, ask the agent to run the command again.
- A refused or expired hand-off leaves the "not approved" comment on the task it came from.
- On the [Org chart](/using/org-chart) and team graphs, an OpenClaw agent with a command waiting shows a pulsing amber ring. The ring appears only for requests this browser tab received while it was open.

## Troubleshooting

<AccordionGroup>

<Accordion title="A card disappeared before I answered">

It ran out of time. The waits are in [What asks for your approval](#what-asks-for-your-approval). For OpenClaw agents that ask too often, set **Command Execution** to **Ask for Unknown**, so only commands the agent is not already allowed to run ask. See [Command permissions](/using/command-permissions).

</Accordion>

<Accordion title="I pressed Always and the card shows an error">

The Gateway did not accept **Always** for that command. An agent set to **Always Ask** never remembers a command, and the Gateway can refuse it for other commands too. Press **Allow Once** or **Deny**, or change the agent's **Command Execution** setting first.

</Accordion>

<Accordion title="I allowed a command but its output never appeared">

After **Allow Once**, Clawboo does not ask the agent to repeat the command, and the Gateway may not send the output to the chat. Ask the agent to run the command again.

</Accordion>

<Accordion title="clawboo could not reach the Gateway to send that decision.">

Your tab has no connection to the OpenClaw Gateway, and Clawboo's server could not pass your answer on either. Check that OpenClaw is connected under **Settings** > **Workspace** > **Runtimes**, then answer again before the card expires.

</Accordion>

<Accordion title="An agent ran a command without asking me">

Claude Code, Codex and Hermes never ask before a command. An OpenClaw agent runs without asking when it is set to **Run Freely**, or when the command is already on its list under **Commands this Boo can run without asking**. A Clawboo Native agent asks before every command.

</Accordion>

<Accordion title="clawboo could not tell which agent asked for this.">

The request arrived with no agent identity, which is how connector calls from OpenClaw agents arrive. Decide from the details on the card. The card appears in every chat and under every board filter.

</Accordion>

<Accordion title="A leader is waiting, but I see no card">

Set the board's team filter to **All teams**, or open the **Approval queue** in **Governance**, which lists every pending request. A risky hand-off waits only 5 minutes, so it may have expired already.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- **OpenClaw requests.** Clawboo's server keeps its own connection to the Gateway and copies each command request into Clawboo's tool-call approvals table as a row of kind `exec`, keyed by the Gateway's id. Every 30 seconds it marks rows past their deadline `expired`, never `deny`, and writes no audit row for them.
- **Answers.** A tab with its own Gateway connection sends the answer straight to the Gateway (`exec.approval.resolve`). Every other answer goes through `POST /api/tools/approvals/:id/resolve`, which answers the Gateway first for an `exec` row. Answering twice is safe: the second answer changes nothing.
- **Clawboo's own requests.** Connector calls, Clawboo Native commands and risky hand-offs are rows in the same table, and the dashboard checks for new ones every 3 seconds. Clawboo records answers as `allow_once`, `allow_always` and `deny`; OpenClaw's words are `allow-once`, `allow-always` and `deny`.
- **Remembered answers.** A connector **Always** writes a standing rule bound to the access you shared, expiring after 30 days, and stopping the share deletes its rules. A risky hand-off is stored per leader under the scope `delegate:code`, and an earlier `allow_always` row for that leader and scope skips the card.
- **Cleanup.** Once an hour, Clawboo expires any request still pending after `CLAWBOO_APPROVAL_TTL_MS` (24 hours by default). That cleanup does not lengthen the waits on this page.
- **History.** `GET /api/approvals?agentId=<id>` lists the OpenClaw command decisions made from tabs with a Gateway connection, newest first.
- Shapes and codes: [Governance API](/reference/rest-api/governance) and [Tools and MCP API](/reference/rest-api/tools-and-mcp). Every waiting time is in [Limits and defaults](/reference/limits-and-defaults).

</Accordion>

## Next steps

- [Command permissions](/using/command-permissions): choose when OpenClaw and Clawboo Native agents ask, and revoke what **Always** allowed.
- [Connectors](/using/connectors): share connectors with agents and see which calls ask.
- [What agents can do](/concepts/permissions): what each runtime can reach without asking.
- [Budgets and guardrails](/concepts/governance): the risky hand-off check and the other limits on agents.
- [Board](/using/board): everything else that waits in **Needs you**.
