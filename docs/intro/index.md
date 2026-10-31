---
title: 'Welcome to Clawboo'
sidebarTitle: 'Welcome'
description: 'Clawboo puts a team of AI agents on your work. Ask once, and Boo Zero splits the job, hands it out, and brings the results back.'
icon: 'house'
keywords: ['overview', 'introduction', 'home', 'what is clawboo']
---

Clawboo puts a whole team of AI agents on your work. You ask once in a team chat, and Boo Zero, your team leader, splits the request into jobs, hands each one to a teammate, and answers you with the results.

Clawboo is free and open source. It runs on your computer and opens in your browser. Teammates can run on Claude Code, Codex, Hermes, OpenClaw or Clawboo's own built-in agents, and one team can mix them.

![A team chat in Clawboo: teammates' updates and two task cards marked Working on the left, and on the right the Team graph card, with Boo Zero above the team lead and four specialists, and the Tasks card, with one task that needs you and five in progress](/images/team-space.png)

## How it works

| Step                                | What happens                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Ask once**                     | Tell your team what you need in its team chat, for example "Plan a launch for our new budgeting app: write a short announcement, draft three social posts and list five questions customers will ask first." |
| **2. Boo Zero splits it into jobs** | Each job becomes a task on the board, handed to the teammate Boo Zero picks for it, whichever AI tool that teammate runs on. You don't route anything.                                                       |
| **3. Watch the team work**          | Follow the tasks live in the chat and on the board, and see what each agent is doing on the team graph. Want a second look? Add a reviewer agent to the team and ask Boo Zero to have it check the work.     |
| **4. Get it back, done**            | Results come back to Boo Zero, which pulls them together and answers you in the chat.                                                                                                                        |

A quick question gets a direct answer; only work with several parts is split into tasks. [How a team works](/intro/how-it-works) follows one request from start to finish.

## Who it's for

- **Founders and small teams** who want a launch plan, a pricing page, a research brief or a weekly report worked on by several agents at once.
- **Agencies and freelancers** with repeatable work, such as content, research or reports, that a ready-made team can take on.
- **Developers** who want coding agents (Claude Code, Codex, Hermes) on one board next to the rest of the team.
- **Anyone with a busy week.** The marketplace also has teams for life outside work, such as Morning Brief, Family Calendar and Trip Desk.

You don't need to code. You start Clawboo with one terminal command; everything after that happens in the browser.

## What it costs

Clawboo is free and open source under the MIT license. Your agents use the AI you connect, and model usage is billed by that provider. Two ways to start without an API key: a free local model through Ollama, or your ChatGPT subscription (**Sign in with ChatGPT** runs your team on Codex).

## Your data and privacy

Clawboo keeps your teams, tasks, chats and memory in a database on your computer. Prompts go only to the providers and apps you connect. There is no Clawboo account, and Clawboo itself sends no telemetry.

Clawboo also makes a few requests of its own. None of them includes your prompts:

- **GitHub**, for the marketplace catalog and the star count shown in the dashboard
- **The npm registry**, to check for updates
- **OpenRouter**, for its public list of models in the model pickers
- **Google Fonts**, for the dashboard's typeface

Some runtimes can read and change files on your computer. [What agents can do](/concepts/permissions) explains what each one may touch.

## Find your way

| I want to                                            | Go to                                                |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Get a team running                                   | [Quickstart](/getting-started/quickstart)            |
| Install, update or remove Clawboo                    | [Install](/getting-started/installation)             |
| Use Clawboo without an API key                       | [Run Clawboo without an API key](/guides/no-api-key) |
| Understand what happens after I send a message       | [How a team works](/intro/how-it-works)              |
| Add Claude Code, Codex, Hermes or OpenClaw teammates | [Choose a runtime](/runtimes/index)                  |
| Let agents use Gmail, Slack, GitHub and other apps   | [Connectors](/using/connectors)                      |
| Run work every day or every week                     | [Routines](/using/routines)                          |
| Keep spend in check                                  | [Budgets and spend](/using/budgets-and-spend)        |
| Know what agents can touch on my computer            | [What agents can do](/concepts/permissions)          |
| Fix a problem                                        | [Troubleshooting](/help/troubleshooting)             |
| Build on Clawboo with the REST API or MCP            | [Reference](/reference/index)                        |

## Next steps

<Columns cols={2}>

<Card title="Quickstart" icon="play" href="/getting-started/quickstart">

Start Clawboo, connect an AI provider, deploy a ready-made team and give it its first job.

</Card>

<Card title="How a team works" icon="workflow" href="/intro/how-it-works">

What happens between your message and Boo Zero's answer, and what you control along the way.

</Card>

<Card title="Runtimes" icon="cpu" href="/runtimes/index">

Compare Clawboo Native, Claude Code, Codex, Hermes and OpenClaw, and pick what each teammate runs on.

</Card>

<Card title="Use Clawboo" icon="layout-dashboard" href="/using/index">

How-to guides for teams, the board, connectors, routines, budgets and the rest of the dashboard.

</Card>

</Columns>
