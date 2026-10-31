---
title: 'Browse and manage team memory'
sidebarTitle: 'Memory'
description: 'See, search and add the facts your agents share, tell Clawboo which ones helped, and set up local embeddings for similarity search.'
icon: 'brain'
keywords:
  [
    'memory browser',
    'shared memory',
    'facts',
    'procedures',
    'embeddings',
    'Ollama',
    'nomic-embed-text',
    'memory graph',
  ]
---

**Memory** is the store of facts your agents share. Agents on every runtime save to it and search it through Clawboo's Memory tool. Use this page to browse it as a graph or a list, search it, add a fact yourself, and tell Clawboo which facts helped.

This shared memory is separate from each runtime's own private memory, such as a Hermes agent's `MEMORY.md` or Claude Code's own memory files, which Clawboo neither shows nor edits. [How memory works](/concepts/memory) explains both kinds and how they fit together.

![Memory in its List view: the search box with its fts, vector and hybrid modes, and the facts the teams have saved, each with its tags and scope](/images/shared-memory.png)

## Open Memory

- **Sidebar:** click **Memory**, or press **Cmd/Ctrl + 4**. Memory opens full screen with a **Graph** | **List** switch, and your browser remembers the choice.
- **Settings:** **Settings**, then **Memory** under **Workspace**, shows the list only. **Open full view** switches to the full-screen Memory.

The store holds two kinds of entry. A **fact** is a short note with a title, such as a decision or a customer's preference. A **procedure** is a named, versioned set of steps that agents build up; you can read procedures here but not change them.

## Search memory

<Steps>

<Step title="Type a query">

In the list, type into **Search the memory store…**.

</Step>

<Step title="Pick a mode">

The chips under the box choose how to match: `fts`, `vector` or `hybrid` (the default). Without an embedding provider the chips are replaced by a line that says why search matches keywords only, and offers the fix when there is one.

</Step>

<Step title="Run it">

Press **Enter** or **Search**. You get up to 25 results, each with the mode that matched it, a score and the first 240 characters. A query that matches nothing reads **No matches**.

</Step>

</Steps>

| Mode     | How it matches                                                   | Needs                                                        |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `fts`    | Keywords in the title and text                                   | Nothing                                                      |
| `vector` | Meaning, so a search for "pricing" can find "how much we charge" | An embedding provider                                        |
| `hybrid` | Both, ranked together                                            | An embedding provider; without one it runs as keyword search |

The list itself shows the 50 most recently updated facts and procedures; search to reach older ones.

## Add a fact

Agents write most of the store, but you can add what the whole team should know.

<Steps>

<Step title="Open the form">

Click **Add a fact** beside the **Facts** heading.

</Step>

<Step title="Fill it in">

Enter a **Title** and the fact itself under **What should the team remember?**. Both are required. Optionally add **Tags**, separated by commas.

</Step>

<Step title="Save it">

Click **Save fact**. The form closes and the fact appears at the top of **Facts**, marked **Global**.

</Step>

</Steps>

A fact you add is global: every agent, on every team, can find it. Before Clawboo stores any fact, from you or an agent, it removes anything that looks like a secret, such as an API key or a token.

## Rate a fact

Each fact has **Helpful** (thumbs up) and **Outdated** (thumbs down). Agents report the same way when a fact they used turned out right or wrong. Clawboo combines the reports into a status, shown as a pill on the fact:

| Pill                   | Meaning                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| **preferred**          | Two or more different agents or tasks found it useful                                    |
| **tentative**          | One report found it useful. Your own **Helpful** counts once, however often you press it |
| **contested · verify** | The reports disagree                                                                     |
| **dead end**           | Only negative reports                                                                    |
| **used N×**            | Agents have been handed it N times, with no rating yet                                   |

Newer reports count for more: a report loses half its weight every 30 days. Click a fact to see its recent reports; **Full history** shows the rest once agents have used it.

The status changes what agents get. Facts marked **dead end** are left out of the facts Clawboo hands to agents automatically (see [What agents remember on their own](#what-agents-remember-on-their-own)), though an agent can still find them by searching. **preferred** facts rank higher, and **contested** ones arrive with a note to check them.

## Fix or remove a fact

You cannot edit or delete a fact, in the dashboard or through the API. To retire a wrong one, mark it **Outdated** so it stops reaching agents, then add the correct version with **Add a fact**. Facts live in Clawboo's database on this machine; see [Data and state](/operating/data-and-state) for where.

## Explore the memory graph

The **Graph** view draws each fact as a node, and each procedure as one node however many versions it has. Links show how entries relate; the legend at the bottom left names them:

| Link           | Drawn as    | Means                                                                                                        |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| **similar**    | Solid line  | The two facts are close in meaning. Needs an embedding provider                                              |
| **shared tag** | Dashed line | The facts carry the same tag. A tag on a large share of the store is skipped, so it does not link everything |
| **version**    | Dotted line | Procedures with the same name in different places, such as a team's copy and the global one                  |

Connected nodes form clusters, named after their most common tag. The legend lists each cluster with its size; untick one to hide it.

- **Search** (top left) dims everything that does not match as you type. **Enter** runs a full search, highlights the hits and their neighbors, and opens the top hit.
- **The inspector** (right) shows the selected entry's text, kind, scope and neighbors. For a fact it also has **Helpful**, **Outdated** and **Full history**.
- **Filters** (top right): scope (**All**, **Global**, **Team**, **Agent**), age (**All**, **24h**, **7d**, **30d**; older nodes fade rather than vanish), and **Community hulls**, which draws or hides the cluster outlines.

The graph shows the newest 500 facts and 200 procedure rows. When the store holds more, a pill says so (**Showing newest N of M facts**, or the same for procedures). If new similarity links arrive while you are looking at something, the graph offers **Show new similarity links** instead of rearranging itself.

## Who can see a fact

| Scope label      | Who can read it     | How a fact gets it                                                                                                                                 |
| ---------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Team-shared**  | Agents on that team | An agent saved it while working for the team                                                                                                       |
| **Global**       | Every agent         | You added it here, or an agent saved it outside a team: in a 1:1 chat with a Clawboo Native agent, as an agent on no team, or as an OpenClaw agent |
| **Agent-scoped** | That one agent      | Saved with an agent scope through the API                                                                                                          |

An agent on a team reads its team's facts, its own and the global ones, never another team's. OpenClaw agents read and save global facts only, because Clawboo cannot tell which OpenClaw agent is asking.

## What agents remember on their own

Nothing is saved automatically: an agent saves a fact when it decides to, with the Memory tool. What Clawboo hands an agent without being asked depends on how the agent is working:

| How the agent is working                                                                                          | What it gets from Memory automatically                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A routine runs it (Clawboo Native, Claude Code, Codex or Hermes agent), or a script starts it through the run API | At the start of the run, up to five facts most relevant to the task plus up to two closely related ones, 1,500 characters at most, with a note on saving and rating facts |
| A 1:1 chat with a Clawboo Native agent                                                                            | Up to eight of its most recent notes (its own and global ones) on the first turn of a conversation, and again after `/reset`                                              |
| Team chat, delegated work, and board tasks you start                                                              | Nothing: agents search memory with the tool when they choose to                                                                                                           |
| An OpenClaw agent                                                                                                 | Nothing: it can search the global facts with the tool                                                                                                                     |

Routine runs and team chat run work in two different ways; [How a team works](/intro/how-it-works) explains both.

## Turn on similarity search

An embedding is a numeric fingerprint of a fact's text. Embeddings power **similar** links, `vector` and `hybrid` search, and better matching for the facts handed to a run. Everything else in Memory works without them, using keyword search.

Clawboo picks an embedding provider in this order:

1. **Ollama on this machine**, at `http://localhost:11434`, with the `nomic-embed-text` model installed. Fact text stays on this machine.
2. **An OpenAI key**, exported as `OPENAI_API_KEY` or added under **Providers**. Fact text and every memory search, including the recall at the start of a run, are then sent to OpenAI.
3. **None**: keyword search only.

To set up the local option:

<Steps>

<Step title="Install and start Ollama">

Install [Ollama](https://ollama.com) on the machine that runs Clawboo and start it.

</Step>

<Step title="Install the model">

In Memory, press **Install model** in the note that says the model is missing. It downloads a few hundred megabytes through Ollama and shows progress; **Cancel** stops it. Running `ollama pull nomic-embed-text` in a terminal does the same.

</Step>

<Step title="Wait for indexing">

Within about a minute, Clawboo notices the model and indexes your facts in the background (**Indexing N facts**). When it finishes, **similar** links appear in the graph.

</Step>

</Steps>

Memory always looks for Ollama at `http://localhost:11434`; the `OLLAMA_BASE_URL` setting that Clawboo Native chat uses does not apply here. To keep memory on keyword search, set `CLAWBOO_DISABLE_EMBEDDINGS=1` before you start Clawboo.

<Note>

Two rules keep your facts from leaving the machine by surprise. Once any fact has been indexed by Ollama, Clawboo never switches to OpenAI on its own, even while Ollama is down: if an OpenAI key is connected, **Use OpenAI instead** switches for that outage only, and says how many facts it sends. And with OpenAI as the provider, only facts that have no fingerprint yet are sent automatically. When Ollama serves again, facts move back to local indexing.

</Note>

Clawboo re-checks the provider on its own: every 10 minutes while Ollama serves, every 30 seconds otherwise, and at once when a call fails or you connect or remove a key. A very long fact is fingerprinted from its first 8,000 characters (2,000 if the provider turns that down); keyword search still covers all of it.

### What the embedding note says

The legend (in the graph) and the line under the search box (in the list) say which state memory is in:

| You see                                                         | Why                                                               | What to do                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| **Similarity links unavailable: embedding model not installed** | Ollama runs, but `nomic-embed-text` is missing                    | Press **Install model**, or run `ollama pull nomic-embed-text` |
| **Similarity links unavailable: Ollama is not reachable**       | Facts were indexed locally, and Ollama is not answering           | Start Ollama; indexing resumes on its own                      |
| **Similarity links unavailable: no embedding provider**         | No Ollama, and no OpenAI key Clawboo can use                      | Set up Ollama, or add an OpenAI key under **Providers**        |
| The same, with "Embeddings are turned off on this server."      | `CLAWBOO_DISABLE_EMBEDDINGS=1` is set                             | Unset it and restart Clawboo                                   |
| **Indexing N facts**                                            | Indexing is under way                                             | Nothing                                                        |
| **Indexing stopped** or **Embedding calls are failing**         | The provider failed, for example a revoked key or a used-up quota | Fix the reason shown, then press **Retry**                     |
| **Using OpenAI until Ollama is back**                           | You chose OpenAI during an Ollama outage                          | Start Ollama; memory moves back on its own                     |
| **Similarity uses OpenAI**                                      | OpenAI is the provider while Ollama lacks the model               | Press **Install model** to move indexing to this machine       |
| **N facts could not be indexed**                                | The provider turned those facts down                              | Nothing: keyword search still finds them                       |
| **New facts are not being indexed**                             | Older facts still have links, but nothing can index new ones      | Apply the fix from the first three rows                        |

## Troubleshooting

<AccordionGroup>

<Accordion title="The list says it could not load the memory store">

The Clawboo server did not answer. Press **Retry**. An empty store reads **No facts yet** and **No procedures yet** instead.

</Accordion>

<Accordion title="Saving a fact says: Could not save the fact. Please try again.">

The server did not accept the save, or could not be reached. Check that Clawboo is still running, then save again.

</Accordion>

<Accordion title="Search only matches keywords">

No embedding provider is working. Read the line under the search box, which names the reason, and use the table above.

</Accordion>

<Accordion title="The model installed but no similar links appeared">

Clawboo notices a model installed outside the app within about a minute. Similar links need at least two indexed facts. To check straight away, ask the server to re-check and index what is missing:

```bash
curl -X POST http://127.0.0.1:18790/api/memory/embedding/reindex
```

It answers at once, and the legend shows the progress. `18790` is the default port; see the [CLI reference](/reference/cli) to find yours.

</Accordion>

</AccordionGroup>

## Next steps

- [How memory works](/concepts/memory): shared and private memory, and how agents use them.
- [Connectors](/using/connectors): the Knowledge Graph Memory connector is a separate tool, not this store.
- [Routines](/using/routines): runs that start with the most relevant facts.
- [Memory API](/reference/rest-api/memory): search, save and rate facts from scripts.
- [MCP servers](/operating/mcp-servers): attach the Memory tool to an agent outside Clawboo.
