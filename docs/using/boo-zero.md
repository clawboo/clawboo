---
title: 'Boo Zero, your team leader'
sidebarTitle: 'Boo Zero'
description: 'How Boo Zero leads every team, how Clawboo picks it, what it reads, and how to use its own chat, its display name and the briefs.'
icon: 'compass'
keywords:
  [
    'Boo Zero',
    'universal leader',
    'team leader',
    'global brief',
    'team brief',
    'display name',
    '@TeamName',
    'leader',
  ]
---

Boo Zero is your team leader, and it leads every team. When you send a message in a team's chat without @mentioning anyone, Boo Zero answers it or hands the work to the right teammate. Each hand-off becomes a task on the board. Boo Zero belongs to no team, so you never add it to a team or a room. It still leads **General** and every room of every team that has at least one member.

Use this page to see how Clawboo picks Boo Zero, what Boo Zero reads, and how to use its own chat, its display name and the briefs.

You can spot Boo Zero by its red Boo, which never wears an accessory. It sits at the top of the team rail, and every team on the Org chart branches off it.

![The Org chart: Boo Zero at the top, leading the Growth, Support and Platform teams](/images/ghost-graph.png)

## How Clawboo picks Boo Zero

Your install has one Boo Zero. Clawboo picks it in this order:

1. **An agent designated as Boo Zero.** The dashboard does this in one case: if you set up Clawboo with **Sign in with ChatGPT**, the lead agent of the team you deploy during setup becomes Boo Zero. It does not replace a Boo Zero you designated or a Clawboo Native one. You can also designate any agent through the API (see **Under the hood** at the end of this page).
2. **A Boo Zero on Clawboo Native that Clawboo creates for you.** It appears once you have a Clawboo Native agent on a team and a connected provider (an API key or a local Ollama). It is named **Boo Zero** and starts on your default Clawboo Native model.
3. **Your OpenClaw Gateway's default agent**, when there is no Clawboo Native Boo Zero. This is the case in an install that uses only OpenClaw.

With none of these, there is no Boo Zero. Each team's chats are then led by the team's own [Leader](/using/teams), or by its first member.

Boo Zero can change as your install grows. Say you use OpenClaw, then put a Clawboo Native agent on a team with a provider connected. Clawboo creates a Clawboo Native Boo Zero, which takes over from the Gateway's default agent.

## Boo Zero's own chat

Click the mascot at the top of the team rail. Boo Zero's page opens and works like any [agent's page](/using/agents); the agent column hides while you are there. The message box reads **Ask me anything… use @ to tag a team**.

Use this chat to ask Boo Zero about your teams. Every message you send here carries a fixed set of rules that names Boo Zero and tells it how to lead. You cannot edit them.

To give a team work, send the request in that team's chat instead. Boo Zero leads there, and its hand-offs become tasks on the board. A Clawboo Native Boo Zero cannot hand out work from its own chat.

### Ask about one team with @TeamName

Start your message with @ and the team's name, or click the team in the **Teams** row above the message box:

```text
@Growth What is still open for Friday's review?
```

Clawboo then adds a snapshot of that team to this one message: its brief (the first 900 characters), a summary of its board, a few facts from its memory, and its recent chat. Only a mention at the very start of the message counts.

## What Boo Zero reads

| Text                | Where you edit it                                     | When Boo Zero reads it                                                                                                                                 |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Team rules**      | The team's brief and rules, or `/rule` in a team chat | Every turn in that team's chats. Every teammate reads them too.                                                                                        |
| **A team's brief**  | The team's brief and rules                            | Only when you start a message in Boo Zero's own chat with @ and the team's name, and then only its first 900 characters. Team chats do not include it. |
| **Its fixed rules** | Nowhere: they are built in                            | Every message in Boo Zero's own chat.                                                                                                                  |
| **Global brief**    | **Details > Brief** on Boo Zero's page                | Never. Clawboo does not use the Global Brief yet.                                                                                                      |

In a team's chats, Boo Zero follows its own instructions. Each turn also gives it the team's rules, what you told the team about yourself, and who is on the team. See [What an agent sees](/concepts/agent-context) for the full list. Team rules and the brief are explained on [Teams](/using/teams#team-rules).

On Clawboo Native, Boo Zero's own instructions are its SOUL.md, under **Details > Agent Files** on its page. You can read and change them there, but they tell Boo Zero how to hand out work, so change them with care.

## Set the display name and Global Brief

<Steps>

<Step title="Open Boo Zero's page">

Click Boo Zero's mascot at the top of the team rail.

</Step>

<Step title="Open the Brief section">

In the **Details** card, click **Brief**. If **Details** is closed, open it with the folder icon in the page header.

</Step>

<Step title="Change the display name">

Under **Display name**, type a name of up to 80 characters, then click **Save**. Reload the page to see the new name everywhere.

</Step>

<Step title="Edit the Global Brief (optional)">

Edit the text, then click **Save**. **Regenerate from teams** rebuilds a draft that lists your teams; nothing changes until you click **Save**.

</Step>

</Steps>

The display name is the name the dashboard shows for Boo Zero, and the name its fixed rules use in its own chat. It starts as **Boo Zero**. While the OpenClaw Gateway is connected, saving also puts the new name at the top of Boo Zero's SOUL.md.

<Note>

Clawboo does not use the Global Brief yet. It saves what you write, but no chat or task sends it to Boo Zero, whatever the description above the box says. The default text includes a copy of Boo Zero's fixed rules; editing that copy changes nothing. For guidance Boo Zero must follow in a team, add a [team rule](/using/teams#team-rules).

</Note>

## The team's own Leader

Besides Boo Zero, a team can have its own Leader: a member whose name or role reads as a lead, marked with a **Leader** badge when you deploy the team. Boo Zero still leads. The Leader sits under Boo Zero on the team graph, and leads the team's chats only when your install has no Boo Zero. See [Teams](/using/teams).

## Troubleshooting

<AccordionGroup>

<Accordion title="A team is led by one of its members, not Boo Zero">

There is no Boo Zero yet. On Clawboo Native, Clawboo creates one once a Clawboo Native agent is on a team and a provider is connected. Connect an API key or a local Ollama in **Settings > Runtimes**.

</Accordion>

<Accordion title="The Brief section is missing">

**Brief** appears only on Boo Zero's own page. Open the page from the mascot at the top of the team rail. If the dashboard has not identified Boo Zero yet, for example right after it connects, reload the page.

</Accordion>

<Accordion title="Boo Zero still shows its old name">

The dashboard applies the display name when it loads. Reload the page.

</Accordion>

<Accordion title="Boo Zero ignores what I wrote in the Global Brief">

This is expected: Clawboo does not use the Global Brief yet. Put the guidance in a [team rule](/using/teams#team-rules) instead.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- `GET /api/boo-zero/override` returns `overrideAgentId`, the `effective` Boo Zero, and the `tier` it came from: `override`, `native`, `openclaw`, or `null` when there is none.
- `POST /api/boo-zero/override` with `{ "agentId": "<agent id>" }` makes any agent Boo Zero, on any runtime. `{ "agentId": null }` clears the choice. A missing or archived agent returns 404.
- Display name: `GET` and `PUT /api/boo-zero/display-name/:agentId`. Global Brief: `GET` and `PUT /api/boo-zero/global-brief`. Team briefs: `GET`, `PUT` and `DELETE /api/boo-zero/team-briefs/:teamId`.
- See the [Boo Zero API reference](/reference/rest-api/boo-zero) for every field.

</Accordion>

## Next steps

- [Teams](/using/teams): team rules, the team brief and the team's Leader.
- [Team chat](/using/team-chat): how messages reach Boo Zero and the team.
- [Agents](/using/agents): the agent page that Boo Zero's page is built on.
- [What an agent sees](/concepts/agent-context): everything in a turn, for Boo Zero and every teammate.
- [Agent model](/concepts/agent-model): agents, runtimes and Boo Zero in one picture.
