---
title: 'Browse and deploy from the Marketplace'
sidebarTitle: 'Marketplace'
description: 'Browse ready-made teams, agents and skills, see what each agent runs on, and deploy it onto the runtime you choose.'
icon: 'shopping-cart'
keywords: ['catalog', 'templates', 'packs', 'skills', 'deploy agent', 'deploy team', 'community']
---

The Marketplace is a catalog of ready-made teams, single agents and skills. Use it to start a team without writing any instructions, or to add one specialist agent. Open it from **Marketplace** in the sidebar. The dashed **+** in the team rail opens it on the **Teams** tab.

<Note>

Most of the catalog is community work, adapted from open-source projects by their original authors. Clawboo checks each pack's license, pins every import to a commit, verifies a content digest, and scans for known prompt-injection patterns. It does not audit what an agent will do once you deploy it, so review anything you deploy.

</Note>

![The Marketplace on its Teams tab: category and pack filters above the Curated teams banner, the Start from scratch card, and team cards with Details and Deploy buttons](/images/team-gallery.png)

## What is in the catalog

The Marketplace has three tabs, each with a count.

| Tab        | What it lists                                                                          |
| ---------- | -------------------------------------------------------------------------------------- |
| **Teams**  | Ready-made teams: a roster of agents and who hands work to whom. This tab opens first. |
| **Agents** | Single agents, one specialist each.                                                    |
| **Skills** | Skills you can note on an agent you already have.                                      |

The **Teams** and **Agents** counts come from the catalog that Clawboo downloads. The full catalog holds 85 teams and 436 agents in 19 packs, and it grows as packs are added. Offline, or until the download lands, you see only the built-in pack: 5 teams and 15 agents. The 44 skills are built in.

Clawboo's server downloads the catalog from the Clawboo repository on GitHub when it first needs it, then refreshes it at most every 6 hours. It checks every pack against its SHA-256 digest before reading it, skips any pack that does not match, and keeps the packs it downloaded in Clawboo's data folder. If the download fails, the Marketplace shows the built-in pack.

Looking for connectors? They have their own row in the sidebar. See [Connectors](/using/connectors).

## Find a team, agent or skill

- **Search.** Each tab has its own search box. It matches names, descriptions and tags, and roles on the **Agents** tab.
- **Category.** Pills for the busiest categories, with the rest under **+N more**.
- **Pack.** On **Teams** and **Agents**, one pill per pack, such as **Clawboo**, **Agency Agents** or **Engineering Agents**.
- **Skills.** Category pills (Code, File, Web, Comm, Data, Other) and a menu that sorts by name or by category.

Each tab keeps its own search and filters when you switch tabs. When nothing matches, **Clear filters** resets that tab.

## Read the details

Click **Details** on any card.

- **A team's details** show where it came from (**Where this came from**: author, license and pinned commit), its description, an optional **Workflow**, and its **Agents**: each agent's role, its skills, and who it hands work to (**Routes to:**).
- **An agent's details** show where it came from, its description, its **Skills**, the teams it appears in, and its **Identity**: the agent's full instructions. Click a skill or a team to jump to it on its own tab.

Both have a **Deploy** button.

## What each runtime runs

A catalog agent comes with three texts: its full instructions (the **Identity** you read in its details), a shorter persona, and tool notes. Clawboo saves all three on the new agent, as IDENTITY.md, SOUL.md and TOOLS.md, and adds the default personality to SOUL.md. Which text the agent follows depends on its runtime.

| Runtime                    | What the agent follows                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw                   | IDENTITY.md (the full instructions), SOUL.md, and AGENTS.md (the team and how to hand off work). OpenClaw 2026.9 and later does not load TOOLS.md. |
| Clawboo Native             | SOUL.md (the persona and personality) plus Clawboo's team-lead or specialist instructions. IDENTITY.md is kept for reference only.                 |
| Claude Code, Codex, Hermes | SOUL.md, which Clawboo adds to each turn as the agent's persona. IDENTITY.md is kept for reference only.                                           |

So on any runtime other than OpenClaw, the long text you read in **Details** is not what the agent follows. To give the agent more of it, copy what you need into its SOUL.md (see [Agents](/using/agents#edit-the-agent-files)). On Claude Code, Codex and Hermes, Clawboo passes on only the first 4,000 characters of SOUL.md.

If Clawboo numbered the agent to avoid a name clash, the agent's name inside these texts is updated to match.

## Deploy a team

You need at least one connected runtime to deploy agents: Clawboo Native with an API key or a local Ollama, the OpenClaw Gateway, Claude Code, Codex or Hermes. See [Providers and runtimes](/using/providers-and-runtimes).

<Steps>

<Step title="Click Deploy">

Click **Deploy** on a team card, or in the team's details. The team dialog opens on its customize step, filled in with the template's name, icon and color.

</Step>

<Step title="Customize the team">

Rename the team, change its badge and colors, and choose each member's runtime and model. See [Customize the team](/using/teams#customize-the-team).

</Step>

<Step title="Deploy the team">

Click **Deploy team**. You land in the new team's **General** chat, and the team gets an icon in the team rail.

</Step>

</Steps>

## Deploy one agent

Click **Deploy** on an agent card, or in the agent's details. Clawboo puts the agent in a new team of its own, named after the agent's role (for example **Research Analyst**). The dialog reads **Deploy agent**: choose the agent's runtime and model, rename the team if you like, then click **Create agent**. You land in the new team's **General** chat.

To add a blank agent to a team you already have, use **Create Boo** instead (see [Agents](/using/agents)).

## Add a skill to an agent

<Steps>

<Step title="Find the skill">

Open the **Skills** tab and find the skill. **Used by N agents** under a skill opens the **Agents** tab, searched for that skill.

</Step>

<Step title="Add it">

Click **Add**, then pick one of your agents. You should see a message such as **Added "Web Search" to Ada's tool profile**.

</Step>

</Steps>

Adding a skill notes it on the agent: the skill shows in [Capabilities](/using/capabilities) and on the agent's graph. It does not install a tool or change the agent's instructions. To give an agent new tools, connect a [connector](/using/connectors) and attach it to the agent.

## Check that it worked

- After a deploy, you are in the new team's **General** chat and the team has an icon in the team rail.
- On an OpenClaw agent, the IDENTITY tab under **Details > Agent Files** shows the text you read in the Marketplace. On other runtimes, open the SOUL tab: that is what the agent follows.
- After you add a skill, it shows on the agent in **Capabilities** and on the agent's graph.

## Troubleshooting

<AccordionGroup>

<Accordion title="The Marketplace shows only 5 teams and 15 agents">

**What it means:** Clawboo is showing its built-in pack because the catalog download did not land. When the server cannot reach GitHub, it keeps showing the built-in pack for up to 6 hours. When your browser cannot reach the server, you also see **Showing the built-in teams only.** with a **Try again** button.

**Fix:** check your network connection, then click **Try again** if it is shown. To make the server download the catalog again sooner, restart Clawboo (see the [CLI reference](/reference/cli)).

</Accordion>

<Accordion title="Some agents are missing after a deploy">

One agent that fails to create does not stop the others, and a message lists the ones that failed. See [What happens when you deploy](/using/teams#what-happens-when-you-deploy).

</Accordion>

<Accordion title="Failed to install a skill: skill blocked">

The full message reads `Failed to install "<skill>": skill blocked: injection / supply-chain finding`. The skill's text matched a known prompt-injection or supply-chain pattern, so Clawboo refused it and recorded the refusal in the Governance audit log (see [Budgets and spend](/using/budgets-and-spend)).

</Accordion>

</AccordionGroup>

<Accordion title="Under the hood">

- The server downloads the index from `https://raw.githubusercontent.com/clawboo/clawboo/refs/heads/main/catalog/dist/v1/index.json`, waits up to 5 seconds, and keeps the result for 6 hours. Set `CLAWBOO_CATALOG_INDEX_URL` to use a mirror instead.
- A source checkout that contains a built `catalog/dist` folder reads the catalog from disk and downloads nothing.
- Verified pack files are cached, keyed by their digest, in the `catalog` folder of Clawboo's data directory (`~/.clawboo/catalog/` by default).
- The pack format, all 19 packs, their licenses and pinned commits are in the [Marketplace catalog reference](/reference/marketplace-catalog).

</Accordion>

## Next steps

- [Teams](/using/teams): customize and manage the team you deployed.
- [Agents](/using/agents): edit a deployed agent's SOUL.md and its other files.
- [Capabilities](/using/capabilities): where the skills you add show up.
- [Marketplace catalog reference](/reference/marketplace-catalog): every pack, with its license and pinned commit.
