---
title: 'Run a content or research team'
sidebarTitle: 'Content team'
description: 'Deploy a marketing or research team from the marketplace, give it rules, steer its tasks, repeat the job weekly and copy out what it writes.'
icon: 'pen-line'
keywords:
  ['marketing team', 'research team', 'Marketing Squad', 'Research Lab', 'weekly report', 'no code']
---

This recipe sets up a small marketing team that writes for you: a blog post, social posts and search keywords from one request. You deploy a ready-made team, tell it who you are and how you like things done, follow its tasks, correct one while it runs, and have it repeat the job every week. Everything happens in the dashboard; you need no code.

The same steps work for a research team. Pick **Research Lab** instead of **Marketing Squad** in step 1.

**What you'll build**

- The **Marketing Squad** team (Content Writer Boo, SEO Analyst Boo and Social Media Manager Boo), led by Boo Zero, the leader who hands work to teammates.
- Team rules that every agent follows, and a separate room for social posts.
- A weekly routine that asks the team for next week's posts.

**Time:** about 20 minutes.

## Before you begin

- Clawboo is installed and onboarding is done, with one way to run agents connected: an API key, **Sign in with ChatGPT**, or a local Ollama model. See the [Quickstart](/getting-started/quickstart), or [Run Clawboo without an API key](/guides/no-api-key).
- If you only signed in with ChatGPT (no API key and no Ollama), you will set every member to **Codex** in step 1.

## What this team can and cannot do

Read this before you rely on the team. What an agent can do depends on its runtime, the engine it runs on:

- **Clawboo Native** runs a marketplace team when no OpenClaw Gateway is connected. Its agents plan, write and review using the model's own knowledge and whatever you give them. They read the team's board and share a team memory. In team chat they cannot browse the web, open your files, or send and post anything. [Connectors](/using/connectors) add those abilities.
- **OpenClaw** agents use the tools your OpenClaw Gateway gives them.
- **Claude Code, Codex and Hermes** agents bring their own tools for commands and files, and run with their own approval prompts turned off. Read [What agents can do](/concepts/permissions) before you put one on a team.

The skills a catalog agent lists, such as `web-search` or `email-draft`, describe its role. They do not give it a working tool.

Nobody checks writing work automatically. A task that finishes in team chat goes to **Done** without a verification step, so read what the team wrote before you publish it. See [How work is checked](/concepts/verification).

## Steps

<Steps>

<Step title="Deploy the Marketing Squad">

1. In the sidebar, click **Marketplace**, then the **Teams** tab.
2. Find **Marketing Squad**. Search for it, or pick the **Marketing** category. Click **Details** to see its three members, then **Deploy**.
3. **Customize team** opens. Each member's row has a runtime menu. Keep the suggestions, or pick a runtime per member (see [Mix runtimes on one team](/guides/multi-runtime-team)).
4. Click **Deploy team**.

You should see **Team deployed!**, and then the team's **General** chat opens.

With no OpenClaw Gateway connected, each row reads **OpenClaw unavailable · using Clawboo Native**. That is expected: the team runs on Clawboo Native. If you only signed in with ChatGPT, set every row to **Codex** before you click **Deploy team**, because Clawboo Native needs an API key or Ollama. A member's runtime cannot be changed after the deploy.

<Frame caption="The Teams tab of the Marketplace. Marketing Squad and Research Lab are built in, so they are there even offline.">
  ![The Marketplace Teams tab with team cards, each with Details and Deploy buttons](/images/team-gallery.png)
</Frame>

</Step>

<Step title="Meet your team and introduce yourself">

On the **Meet your team** card, click **Get Started**. Then write a few lines about you and the work: your company, your audience, the voice you want, and what you need help with. Click **Continue to Team Space**.

You should see the **General** chat, with the **Team graph** and **Tasks** cards beside it. Your introduction is saved with the team and goes into every turn its agents take.

</Step>

<Step title="Set the team's rules">

1. At the top of the chat, click the gear button. Its label is the team's name followed by "brief & rules".
2. Under **Rules**, write one rule per line, for example:

   ```text
   Write in British English.
   Our readers are owners of small cafes.
   Never invent statistics. Say when a number needs a source.
   ```

3. Click **Save rules**.

You should see "Team rules saved." The rules go into every turn of every agent and of Boo Zero in this team.

To add one rule without opening the sheet, type `/rule` and the rule in the chat box, for example `/rule Keep posts under 150 words`, and press Enter. You should see "Team rule saved."

The **Brief** in the same sheet describes the team. Boo Zero reads it only when you start a message in Boo Zero's own chat with `@` and the team's name. Team chat turns use your rules and your introduction instead, so put anything the team must follow in the rules.

<Frame caption="The brief and rules sheet. Save rules applies them from the team's next turn.">
  ![The team settings sheet with a Brief text box and a Rules text box](/images/team-brief-rules.png)
</Frame>

</Step>

<Step title="Ask for the work in General">

Type the request in the chat box and press Enter. Say exactly what you want back:

```text
Write a 600-word blog post announcing our new weekend brunch menu, three LinkedIn posts that link to it, and five search keywords to target.
```

Boo Zero answers simple questions itself. For work like this it hands parts to teammates. Each hand-off appears as a task card in the chat and in the **Tasks** card, where it moves from **To do** to **In progress** to **Done**. While the team works, the **Send** button turns into **Stop**. When the tasks are done, Boo Zero posts one short summary.

You should see one or more task cards, each naming the teammate doing it.

<Frame caption="A team's General chat with its Team graph and Tasks cards.">
  ![A team chat with agent messages and task cards on the left, and the Team graph and Tasks cards on the right](/images/team-space.png)
</Frame>

</Step>

<Step title="Open a room for focused work (optional)">

1. In the sidebar, at the top of the team's chats, click **New room**.
2. Name it, for example "Social posts". Under **Members**, tick **Social Media Manager Boo**. Click **Create room**.

The room opens as its own chat. Boo Zero leads it and hands work only to the members you picked. The team's rules, brief and memory are shared with **General**, and the room's tasks still appear on the team's board.

</Step>

<Step title="Follow a task and steer it while it runs">

1. In the **Tasks** card, click a task under **In progress**. If the card is closed, click **Show tasks** at the top of the chat.
2. Read **Latest report** and **Progress** to see where it is.
3. In the **Comment or steer this task…** box, type a correction, for example "Keep it under 500 words and leave out prices". Click **Send**.

The line beside **Send** says when the agent sees your comment. On most runtimes it reads "… gets this now, before its next step"; a Hermes agent pauses to read it, then carries on. You should see a note under your comment such as "Sent to Content Writer Boo’s run".

For a task that failed or was stopped, sending a comment starts its agent on it again, and the agent reads your comment as the run begins. To see every task the team has, click **Board** in the sidebar. Its columns are **Needs you**, **Backlog**, **To do**, **In progress**, **Done** and **Cancelled**. See [Board](/using/board).

</Step>

<Step title="Repeat the job every week">

1. Open **Settings** (`Cmd/Ctrl + ,`). Under **Workspace**, click **Routines**, then **New routine**.
2. Choose **A team task**, and pick **Marketing Squad** under **Team**.
3. Under **What should happen**, write the request, for example "Draft next week's three LinkedIn posts from this week's blog post, and suggest one topic for the next post."
4. Give it a **Name**, such as "Weekly posts", and pick **Weekly · Mon 9am** under **Runs**. Click **Create routine**.

You should see the routine under **Team routines**. Every Monday at 9:00, in the time zone of the computer running Clawboo, it posts your instructions in **General** as "Routine · Weekly posts", and Boo Zero takes it from there. To try it now, open the routine and click **Run now**.

Clawboo must be running for a routine to fire. A run that was due while Clawboo was not running fires once when it starts again. A run that fails stops the routine until you resume it. See [Routines](/using/routines).

</Step>

<Step title="Find and copy the results">

- **Boo Zero's summary** is in the chat where you asked.
- **Each teammate's full write-up** is on its task. In the **Tasks** card, click the task and read **Output**. On the **Board**, click the card and read the agent's report.
- **Facts the team saved** are under **Memory** in the sidebar.

To copy a result, select the text and copy it (`Cmd/Ctrl + C`). There is no export button.

</Step>

</Steps>

## Check that it worked

- **General** shows your request, the teammates' task cards and Boo Zero's summary.
- The **Tasks** card lists the tasks under **Done**.
- A task's detail names the runtime that ran it and its cost. A cost Clawboo estimated rather than received from the provider is marked "est.".
- **Settings** > **Routines** lists your routine under **Team routines**.

## Variations

| You want                                | Do this                                                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A research team                         | Deploy **Research Lab** (Paper Reader Boo, Data Analyst Boo, Summarizer Boo). Paste the text you want read: on Clawboo Native the team cannot open links or files.                                              |
| A bigger catalog                        | Online, the marketplace adds teams such as **SEO Content Studio**, **Writing Room** and **Market Intelligence Unit**. Offline it shows only the five built-in teams.                                            |
| Web search or your own apps             | On the **Connectors** page, connect a tool such as **Exa Search** (web search, needs an Exa API key) or **Composio** (Gmail, Slack and more), and give your agents access. See [Connectors](/using/connectors). |
| No API key                              | Run the team on a local Ollama model or on your ChatGPT plan. See [Run Clawboo without an API key](/guides/no-api-key).                                                                                         |
| Different engines for different members | Put a member on Claude Code, Codex, Hermes or OpenClaw. See [Mix runtimes on one team](/guides/multi-runtime-team).                                                                                             |
| A spending limit                        | Set a budget for the team. See [Budgets and spend](/using/budgets-and-spend).                                                                                                                                   |

## Troubleshooting

<AccordionGroup>

<Accordion title="Every member reads OpenClaw unavailable · using Clawboo Native">

**What it means:** a marketplace team suggests OpenClaw, and no OpenClaw Gateway is connected, so each member falls back to Clawboo Native.

**Fix:** nothing, if Clawboo Native is what you want. To run the members on OpenClaw, set up OpenClaw first (see [OpenClaw](/runtimes/openclaw)), then deploy the team.

</Accordion>

<Accordion title="Every reply or task fails as soon as it starts">

**What it means:** the members run on a runtime that is not connected, for example Clawboo Native with no API key and no Ollama.

**Fix:**

1. Open **Settings** > **Runtimes** and connect the runtime. See [Providers and runtimes](/using/providers-and-runtimes).
2. On the **Board**, click **Retry** on each failed task in **Needs you**.

If that runtime cannot be connected, delete the team with **Delete with agents** (see [Teams](/using/teams)) and deploy it again with each member on a connected runtime. A member's runtime cannot be changed after the deploy.

</Accordion>

<Accordion title="The team makes up facts, or says it cannot browse">

**What it means:** on Clawboo Native the agents have no web access, so they answer from the model's own knowledge.

**Fix:** paste the source material into your request, or connect a search connector such as **Exa Search** and give your agents access.

</Accordion>

<Accordion title="I can't type in General, and the Send button says Stop">

**What it means:** the team is still working on your last request.

**Fix:** to change a task while it runs, comment on it in the **Tasks** card. To end every run in this chat, click **Stop**. Stopped tasks wait in **Needs you** on the **Board**.

</Accordion>

<Accordion title="The weekly routine did not run">

**What it means:** Clawboo has not been running since the routine was due (it runs once when Clawboo starts again), or an earlier run failed and stopped the routine.

**Fix:** open **Settings** > **Routines** and look at the routine's status. If it failed, read the error, then click **Resume**. Click **Run now** to test it.

</Accordion>

<Accordion title="A team from the catalog is missing">

**What it means:** the marketplace could not load the online catalog and shows "Showing the built-in teams only."

**Fix:** check your network connection and click **Try again**.

</Accordion>

</AccordionGroup>

## Next steps

- [Team chat](/using/team-chat): rooms, clearing a chat, and who answers a message.
- [Board](/using/board): every task, the Needs you column, and steering.
- [Routines](/using/routines): schedules, pausing, and what happens when a run fails.
- [Connectors](/using/connectors): give your agents apps and web search.
- [What agents can do](/concepts/permissions): read this before you add coding agents to a team.
