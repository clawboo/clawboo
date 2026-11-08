---
title: 'Boo Zero, your team leader'
sidebarTitle: 'Boo Zero'
description: 'How Boo Zero leads every team, how Clawboo picks it, what it reads, and how to use its own chat, its display name and the team briefs.'
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

Use this page to see how Clawboo picks Boo Zero, what Boo Zero reads, and how to use its own chat, its display name and the team briefs.

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

Use this chat to ask Boo Zero about your teams, and to give a team work. Every message you send here carries a fixed set of rules that names Boo Zero. You cannot edit them.

### Give a team work from this chat

Start your message with @ and the team's name, or name the team in plain words:

```text
@Growth Write the launch post and have someone check the numbers.
```

Boo Zero hands the work to someone on that team, and it runs the way a hand-off in that team's chat does. Each hand-off becomes a task on that team's board, in **General**. Its card appears in this chat under **Handed to** and the team's name, and in the team's chat too. The card moves as the work does. When the task ends, the result comes back to Boo Zero in this chat, and Boo Zero tells you what came of it. If Clawboo restarts first, the result still arrives, once the server is back.

Your message is a request, as it is in a team's chat. What it hands out to one team goes under one [main task](/concepts/the-board#your-request-is-one-main-task) on that team's board, holding your words, and a message to two teams makes one on each. Boo Zero looks after it from this chat: when the last of its work is in, Boo Zero's reply here is the summary, the reply goes on the main task, and the main task closes. Each request gets its own reply. A result Boo Zero reads while answering something else closes its request too, with a note saying the reply is in the chat.

- **No team named.** Boo Zero asks which team. If a hand-off in a reply still names no team, nothing starts and the chat asks you. Pick a team above the message box, or say which in your next message.
- **A team you did not name waits for your yes.** Work starts straight away only on a team your message named, with @ or in the words you typed. Boo Zero may still pick a team itself, when the right one seems clear from the conversation, but a hand-off to a team your message did not name starts nothing. It waits on a card in this chat, headed **Waiting for your answer** and the team's name, and in the board's **Needs you** column. **Accept** starts it, with you recorded as the one who asked, and **Turn down** starts nothing. Several hand-offs to that team in one reply share one card, and each card stands on its own: a later one does not take its place.
- **It never guesses a name.** A name two teams or two teammates could share asks you which one. With a team named, a whole team name still means that team, not a teammate whose name starts the same.
- **It refuses plainly.** Whatever a reply asked for that did not start, the chat says so: a team or teammate that is not there, work that has failed too often, a paused team or teammate, or a hand-off while Clawboo is stopping or updating. Boo Zero hears the same on its next turn.
- **Showing is not starting.** A hand-off inside code or a quote starts nothing and stays on screen as written, so Boo Zero can show you a draft. That covers a line straight after a quote's words with no blank line between, and a hand-off partway through a sentence in double or curly quotes. A quoted sentence counts only on one line: its quote must open on the line where the hand-off starts and close on the line where it ends, so if the opening quote is on an earlier line, a hand-off in it can start. A quote mark right after a number, as in `5"`, opens no quote but may end one, so it is read both ways, and a hand-off either reading puts in quotes stays shown. The apostrophe in `It’s` closes no quote. For a draft, a code block is the sure way.
- **Some turns are held to one team.** While Boo Zero reads a result, it can hand work only to the team that result came from. The same holds for a message of yours that carries a result kept since a Stop, or what a team has been doing (`@Team`), except that a team you picked above the box or named in the words you typed is open too. A message Clawboo cannot tell came from you starts nothing.
- **What Boo Zero recalled or read cannot start work by itself.** Its saved notes reach it quoted and scanned for injection, as information. What its own tools return, such as `get_task` and `memory_search`, reaches it as plain tool output. And its session still holds what it read on earlier turns. Any of these can lead it to pick a team, so on a team your message did not name, nothing starts without your yes on the card. On a team you named, the hand-off starts and its card in this chat shows what it is doing: you can stop the work on that card or in the team's chat.
- **The same fences as a team's chat.** A hand-off whose words look risky asks you first, in the tray above the message box. The caps on hand-offs apply, and one reply starts at most 8.
- **A team that asks first asks here too.** On a team [that asks before a plan starts](/concepts/the-board#plans), several hand-offs in one reply wait for your answer on one card, in this chat and on the board, and nothing starts until then. Your answer reaches Boo Zero in this chat, and the results of what you accepted come back here. One hand-off to a team you named goes straight out, as in the team's chat.
- **A plan does not run here.** Boo Zero hands off each piece on its own. A `<plan>` in a reply starts nothing, and the chat says so. For a plan, ask in the team's chat.
- **A pause holds results.** While a pause covers Boo Zero, or the team or request a result is on, the result waits and uses up no try. It goes out when the pause lifts.
- **Stop stops Boo Zero's reply, not the team.** A reply you stop starts nothing, and one that ends early says its hand-offs did not start. Work already handed off keeps going: stop it in the team's chat or on its card. A card still waiting for your yes stays until you answer it, or until a Stop in that team's chat closes it. A result that arrives after you press Stop starts no reply until your next message, which carries it. Its card still moves in the meantime.

This works when the Clawboo server runs Boo Zero: Clawboo Native, Claude Code, Codex or Hermes.

<Note>

**An OpenClaw Boo Zero cannot hand off from this chat.** Its chat runs in the OpenClaw Gateway, over your browser's connection. The Clawboo server only forwards that connection, adding the Gateway's token, and does not read the replies, so that chat is outside the run limit and outside a hold while Clawboo stops or updates. Starting team work from a reply the server does not read would bypass all of that, so nothing starts. Its rules tell Boo Zero to say so, and any hand-off in a reply shows as a **Not handed off** note, while one in code or a quote stays as written. Ask in the team's chat instead.

</Note>

The chat with any other agent is a plain conversation too. A hand-off in its reply shows as a **Not handed off** note, and one in code or a quote stays as written.

### Ask about one team with @TeamName

Start your message with @ and the team's name, or click the team in the **Teams** row above the message box:

```text
@Growth What is still open for Friday's review?
```

Clawboo then adds a snapshot of that team to this one message: its brief (the first 900 characters), a summary of its board, a few facts from its memory, and its recent chat. Only a mention at the very start of the message counts. The mention also tells Boo Zero which team you mean if it hands anything off.

## What Boo Zero reads

| Text                | Where you edit it                                     | When Boo Zero reads it                                                                                                                                 |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Team rules**      | The team's brief and rules, or `/rule` in a team chat | Every turn in that team's chats. Every teammate reads them too.                                                                                        |
| **A team's brief**  | The team's brief and rules                            | Only when you start a message in Boo Zero's own chat with @ and the team's name, and then only its first 900 characters. Team chats do not include it. |
| **Its fixed rules** | Nowhere: they are built in                            | Every message in Boo Zero's own chat.                                                                                                                  |

In a team's chats, Boo Zero follows its own instructions. Each turn also gives it the team's rules, what you told the team about yourself, and who is on the team. See [What an agent sees](/concepts/agent-context) for the full list. Team rules and the brief are explained on [Teams](/using/teams#team-rules).

On Clawboo Native, Boo Zero's own instructions are its SOUL.md, under **Details > Agent Files** on its page. You can read and change them there, but they tell Boo Zero how to hand out work, so change them with care.

## Set the display name

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

</Steps>

The display name is the name the dashboard shows for Boo Zero, and the name its fixed rules use in its own chat. It starts as **Boo Zero**. While the OpenClaw Gateway is connected, saving also puts the new name at the top of Boo Zero's SOUL.md.

<Note>

**Brief** holds only the display name. For guidance Boo Zero must follow in a team, add a [team rule](/using/teams#team-rules): rules are read on every turn in that team's chats.

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

<Accordion title="The Global Brief is gone">

Clawboo never sent the Global Brief to Boo Zero, so it was removed. A Global Brief you saved in an earlier version stays in Clawboo's database, unread. Put the guidance in a [team rule](/using/teams#team-rules) instead.

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- `GET /api/boo-zero/override` returns `overrideAgentId`, the `effective` Boo Zero, and the `tier` it came from: `override`, `native`, `openclaw`, or `null` when there is none.
- `POST /api/boo-zero/override` with `{ "agentId": "<agent id>" }` makes any agent Boo Zero, on any runtime. `{ "agentId": null }` clears the choice. A missing or archived agent returns 404.
- Display name: `GET` and `PUT /api/boo-zero/display-name/:agentId`. Team briefs: `GET`, `PUT` and `DELETE /api/boo-zero/team-briefs/:teamId`. The Global Brief routes, `GET` and `PUT /api/boo-zero/global-brief`, were removed.
- See the [Boo Zero API reference](/reference/rest-api/boo-zero) for every field.

</Accordion>

## Next steps

- [Teams](/using/teams): team rules, the team brief and the team's Leader.
- [Team chat](/using/team-chat): how messages reach Boo Zero and the team.
- [Agents](/using/agents): the agent page that Boo Zero's page is built on.
- [What an agent sees](/concepts/agent-context): everything in a turn, for Boo Zero and every teammate.
- [Agent model](/concepts/agent-model): agents, runtimes and Boo Zero in one picture.
