---
title: 'What Clawboo is'
sidebarTitle: 'What is Clawboo'
description: 'What Clawboo does and does not do, how it compares with running one AI tool on its own, and the limits to know before you start.'
icon: 'info'
keywords: ['why clawboo', 'comparison', 'limits', 'positioning', 'orchestrator', 'multi-agent']
---

Clawboo is a free, open-source app that runs a team of AI agents on your computer. You give the team a job in a chat. Boo Zero, the team leader, hands parts of it to teammates. Each part becomes a task on a board, and Boo Zero answers you when the results are back.

Use this page to decide whether Clawboo fits what you want to do, and what to expect from it.

## What Clawboo is

- **A team around your AI tools.** Each agent runs on a runtime, the engine that does its thinking and acting. Clawboo has its own built-in runtime, Clawboo Native, and can also run agents on Claude Code, Codex, Hermes and an OpenClaw Gateway. One team can mix them.
- **One board and one chat.** Every hand-off becomes a task on a board that survives restarts, and the team talks the work through in its team chat: **General**, plus any rooms you add.
- **Shared team memory.** A fact one agent saves for the team can be found by its teammates. OpenClaw agents are the exception: they read and save only the facts every agent shares, not a team's.
- **A marketplace of ready-made teams.** 400+ agents and 80+ teams load from the online catalog, from launch plans and pricing pages to a morning brief and a trip desk. Offline you still get 15 built-in agents in 5 teams.
- **Controls for spend and risk.** Spend tracking, budgets, approvals for some risky actions, and limits on how far work can fan out.

## What Clawboo is not

- **Not an AI model.** Your agents use the providers you connect (an API key, a local Ollama model or a ChatGPT subscription), and the provider bills the usage.
- **Not a sandbox.** Agents act with your user account's permissions. See [What agents can do](/concepts/permissions).
- **Not a shared workspace.** One person runs Clawboo on one computer, and there are no Clawboo accounts.

## When Clawboo fits

Clawboo fits work with several parts that benefits from more than one specialist: a launch plan, a pricing page, a research brief, a weekly report. Founders, small teams and agencies deploy ready-made teams for this kind of work, and developers add coding agents (Claude Code, Codex, Hermes) to the same board. The marketplace also has teams for life outside work, such as Morning Brief, Family Calendar and Trip Desk.

You don't need to code. You start Clawboo with one terminal command, and everything after that happens in the browser.

## Clawboo or one AI tool on its own

| You want to                       | With one AI tool on its own                        | With Clawboo                                                                   |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Get a job with several parts done | You split the work and carry results between tools | Boo Zero splits it and hands each part to a teammate                           |
| Use more than one AI tool         | One tool per window                                | Agents on different runtimes share one team, one chat and one board            |
| Keep track of the work            | A chat history                                     | A task for every hand-off, on a board that survives restarts                   |
| Share what agents learn           | Each tool keeps its own memory                     | A shared memory that agents search and add to                                  |
| Keep spend in check               | Your provider's limits                             | Spend tracking, budgets that warn as spend nears the limit, an opt-in hard cap |
| See what is happening             | Each tool's own output                             | A live team graph, activity feeds, the board, and an Org chart of all teams    |
| Check the work                    | You review it                                      | You still review most of it (see Limits below)                                 |

A team is not always the better choice. It spends more tokens than one agent, because the leader, each teammate and the final summary are separate model runs. For a quick question or a one-step task, one agent on its own is faster and cheaper. Clawboo earns its keep when a job has several parts, or when you want the work tracked on a board instead of lost in a chat scroll.

## Limits

- **Agents act with your permissions.** Claude Code, Codex and Hermes run with their own permission prompts and sandboxes turned off, so they can read and change any file your user account can. A git worktree keeps a task's file changes apart; it is not a sandbox. For work you don't trust, use a separate user account or a virtual machine. [What agents can do](/concepts/permissions) has the details for each runtime.
- **Most work is not checked automatically.** Clawboo checks a task automatically only when it runs in its own git worktree of a repo you point it at and changes files. Team chat work is never checked automatically: review it yourself, or add a reviewer agent and ask Boo Zero to have it check the work. See [How work is checked](/concepts/verification).
- **Spend numbers are partly estimates.** Some runtimes report their real cost, and for others Clawboo estimates it. Your provider's bill is the real number. A budget warns by default; a hard cap is opt-in and cannot stop every runtime in the middle of a run. See [Budgets and spend](/using/budgets-and-spend).
- **Features differ by runtime.** OpenClaw needs its own Gateway, and agent files, steering and cost reporting work differently on each runtime. See [Choose a runtime](/runtimes/index).
- **One person, one computer.** Clawboo listens only to your own computer unless you set it up otherwise. To reach it from another machine, see [Remote access](/guides/self-host-securely).

## What we do not claim

- That Clawboo makes agents safe to run on anything.
- That every finished task was checked.
- That Clawboo's spend numbers match your provider's bill.
- That nothing leaves your computer: prompts go to the providers and apps you connect.
- That a team beats one good agent at every job.

## Related

- [Quickstart](/getting-started/quickstart): get a team running and give it a first job.
- [How a team works](/intro/how-it-works): what happens between your message and the answer.
- [What agents can do](/concepts/permissions): permissions and safety on each runtime.
- [Choose a runtime](/runtimes/index): compare the five runtimes.
- [FAQ](/appendices/faq): short answers to common questions.
