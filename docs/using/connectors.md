---
title: 'Connect tools to your agents'
sidebarTitle: 'Connectors'
description: 'Connect MCP servers and apps in Connectors, then give each one to the agents that should use it. Connecting alone gives no agent access.'
icon: 'plug'
keywords:
  [
    'connectors',
    'MCP server',
    'Connect an MCP server',
    'Composio',
    'grant',
    'Stop sharing',
    'Playwright',
    'Chrome DevTools',
  ]
---

A connector gives your agents tools beyond chat: a browser, a database, Linear, Notion, Gmail. Each connector is an MCP server (Model Context Protocol, the common way to hand tools to an AI agent). Use this page to connect one, give it to the agents that need it, and take it back.

Connecting and giving access are two separate steps. **Connect** starts the connector, but no agent can see or call its tools until you give it to that agent on the graph.

## Before you begin

- Node.js on the machine that runs Clawboo. Most connectors start with `npx`, and the first start downloads the connector's pinned package.
- For a connector you sign in to (Linear, Sentry, Stripe, Composio), a browser on that same machine. The sign-in page sends you back to a temporary address on that machine.
- An account or key for the service, when the connector asks for one.

## Connect a connector

<Steps>

<Step title="Open Connectors">

Click **Connectors** in the sidebar, or press **Cmd/Ctrl + 3**.

</Step>

<Step title="Find the connector">

Search by name, or pick a category. Connected ones come first, then the ones that need the least setup.

</Step>

<Step title="Press Connect">

What happens next depends on what the connector needs:

| The connector needs                                                                          | What **Connect** does                                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Nothing (Playwright, Chrome DevTools, Context7, Knowledge Graph Memory, Sequential Thinking) | Starts it right away                                                                     |
| A sign-in (Linear, Sentry, Stripe, Composio)                                                 | Opens the provider's sign-in page in a new tab, then connects                            |
| A key (GitHub, Notion, Figma, Supabase, Airtable and others)                                 | Opens a field in the row. Paste the key and press **Save and connect**                   |
| A folder or a database file (Filesystem, SQLite)                                             | Opens a field with suggestions. Pick one or type a path, then press **Save and connect** |
| Nothing Clawboo has reviewed (a community entry)                                             | Shows the exact command it will run and asks you to confirm                              |

</Step>

<Step title="Check that it connected">

The row shows a green tick, and a message confirms it with the connector's tool count and the reminder "Connect it to an agent to use it."

</Step>

</Steps>

Now give it to an agent: see [Give a connector to an agent](#give-a-connector-to-an-agent).

A connector that cannot run on this install shows **Why not** instead of **Connect**. It says what is missing and offers a config block you can paste into another app that can run it.

Keys and sign-in tokens go to Clawboo's encrypted vault on this machine, and no API sends them back to the browser. A key you exported in your shell (for example `NOTION_TOKEN`) is not picked up: enter it in Connectors.

<AccordionGroup>

<Accordion title="Suggestions for Filesystem and SQLite">

Filesystem suggests the folder you started Clawboo from, plus your Documents, Desktop and Downloads folders, each only if it exists. SQLite suggests up to five `.db`, `.sqlite` or `.sqlite3` files within two folder levels of where you started Clawboo. You can always type a path instead.

</Accordion>

<Accordion title="GitHub needs a token, not a sign-in">

GitHub offers no sign-in that Clawboo can use, so its connector takes a personal access token. Create a fine-grained token, choose only the repositories your agents should work in, and give it Read and write on Contents, Issues and Pull requests. Paste it into the GitHub row.

</Accordion>

</AccordionGroup>

## What the list holds

The list reads top to bottom in four bands:

| Band                         | What it is                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| **Popular**                  | Well-known connectors Clawboo has run and reviewed                                         |
| **More connectors**          | The rest of the reviewed set, plus any server you added yourself                           |
| **Reached through Composio** | Apps such as Gmail, Slack, Google Calendar and Jira, which you sign in to through Composio |
| **From the community**       | Servers from the public MCP registry that Clawboo has not reviewed                         |

The reviewed set holds 20 connectors. The community band holds a snapshot of 400 registry servers, shipped with Clawboo, so the list works offline. It stays hidden until you press **Show 400 more** at the foot of the list or search for something; then it shows 60 at a time (**Show 60 more**, then **Show the last N**).

### Apps reached through Composio

Clawboo cannot sign in to Google, Slack or Atlassian directly, so those apps go through [Composio](https://composio.dev), a separate service that signs you in to each app.

<Steps>

<Step title="Add your Composio key">

In the **Reached through Composio** band, press **Get a key** to open Composio's API keys page. Copy the project key (it starts with `ak_`), paste it into the **Composio key** field and press **Save**. You do this once.

</Step>

<Step title="Connect an app">

Press **Connect** on the app and approve it in the tab that opens. Back in Clawboo, the app's row reads **Connected**.

</Step>

<Step title="Connect the Composio connector">

Your agents reach every Composio app through the **Composio** connector in the **Popular** band. Press **Connect** on it once and sign in to Composio.

</Step>

<Step title="Give the app to an agent">

Give the app to an agent the same way as any connector (next section): the graph's picker lists connected apps with the connectors. Each app an agent holds shows as its own tile, so you can see which agents can reach your email.

</Step>

</Steps>

Composio keeps each app's sign-in tokens on its own servers, and Clawboo holds only its own key and sign-in for Composio. Anything you connect there is reachable by Composio, not only by your agents.

## Give a connector to an agent

You give access on a graph: the **Org chart**, a team's **Team graph** card, or the **Graph** card on an agent's page. Click a Boo to open its ring of tiles; each connector tile on the ring is one the agent can use.

<Tabs>

<Tab title="Pull a thread off the Boo">

<Steps>

<Step title="Start from the Boo">

Hover the Boo: a small **+** port appears with **Drag to connect** beside it. Drag from the port and let go on an empty spot.

</Step>

<Step title="Pick the connector">

In the menu that opens, choose **Connectors** and pick one. A connected connector reads **Give access**. One that is not connected yet shows what it needs (for example **Turn on** or **Connect**), and Clawboo connects it first. Connectors that need a key or a folder say to set them up in Connectors first.

</Step>

<Step title="Check the ring">

The Boo's ring opens and the new tile joins it. The agent has write access, and risky calls ask you first.

</Step>

</Steps>

</Tab>

<Tab title="Place a tile, then drop it on a Boo">

<Steps>

<Step title="Add the tile">

Press **+** on the graph, choose **Connectors**, and pick one. A loose tile marked **Not attached** appears.

</Step>

<Step title="Drop it on the Boo">

Point at the tile: a port appears with **Drag onto an agent** beside it. Drag from the port and let go on the Boo that should have it. The tile joins the Boo's ring, with write access and risky calls asking first.

</Step>

</Steps>

</Tab>

<Tab title="Share it from another agent">

<Steps>

<Step title="Drag an existing tile">

On the ring of an agent that has the connector, drag from the small handle on the right edge of its tile and let go on another Boo.

</Step>

<Step title="Choose the access">

The **Share** dialog asks for **Read**, **Write** or **Admin** access (see the table below) and starts on **Read**. Press **Grant read access** (the label follows your choice). The first agent keeps its own access.

</Step>

</Steps>

</Tab>

</Tabs>

| Access    | What the agent may do                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------- |
| **Read**  | Look things up. Only tools that a reviewed connector marks as read-only; the agent does not see the rest |
| **Write** | Create and update. Risky calls ask you first                                                             |
| **Admin** | Also the tools a reviewed connector marks as destructive, such as deleting. Use sparingly                |

Pick **Write** for most connectors. Many tools do not say whether they only read, so a **Read** grant hides them.

### Who can use a connector

- **Right after you connect it:** no agent. Its tools are hidden from every agent, and a call to them is refused.
- **After you give it to an agent on the graph:** that agent only, with the access you chose. Every other agent still has no access until you give it to them too.
- **The exception:** the two browser connectors, which every agent gets automatically (next section).

### Every agent gets a browser

The two browser connectors, **Playwright** and **Chrome DevTools**, are connected for you the first time Clawboo starts, and every agent gets both with write access. In Chrome DevTools, actions that change something, such as opening a page or clicking, ask you first. Playwright marks each of those actions as destructive, so with write access an agent sees only Playwright's reading tools, such as a snapshot of the page. To let an agent act through Playwright, **Stop sharing** Playwright with it, then share it again from another agent's tile with **Admin** access. Each action still asks first. Each agent has its own browser profile, so two agents can be signed in to different accounts on the same site. The browser tiles sit on the agent's ring like any other connector, so you can take them away (next section), and a removed browser stays removed after a restart.

## See and take back access

The graph is the list of who can use what: every tile on a Boo's ring is something that agent can reach. A tile that several agents share shows a small count, such as **x3**; hover it to highlight the others.

Click a connector tile to see its toolbar:

| Button                   | What it does                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Stop sharing**         | Takes the connector away from this agent only. The message that confirms it offers **Undo** for a few seconds |
| **Turn off**             | Stops the connector for every agent. It stays off after a restart until you connect it again                  |
| **Sign in**              | Shown when the connector's sign-in has expired                                                                |
| **Retry**                | Shown when the connector reports an error. Reads its state again                                              |
| **Enable** / **Disable** | Shown on capabilities that a runtime lets Clawboo switch                                                      |

In Connectors, **Turn off** appears when you hover a connected row. A connector you signed in to also has **Sign out** in its detail pane (click the row): it deletes the stored tokens and stops the connection. A server you added yourself has **Remove**.

## When a connector call asks you first

Every call an agent makes through a connector passes Clawboo's checks first. When a call needs your answer, an approval card appears in **Needs you** on the board, in the chat where the agent is working, and in the **Governance** and **Capabilities** panels. If nobody answers within five minutes, the call is refused. See [Approvals](/using/approvals) for the cards themselves.

Which calls ask depends on the connector:

- **GitHub, Linear, Sentry, Airtable and Notion, and any server you added yourself, ask before every call.** They can read your private data, take in content from outside and send data out. That combination is how data gets leaked, so you cannot turn these questions off.
- **Actions in apps reached through Composio ask every time too.**
- **On the other connectors**, a call that only reads runs without asking when Clawboo reviewed the connector and the tool says it only reads. A call that changes something asks first when the connector can reach the internet. A tool the connector marks as destructive needs **Admin** access and asks first.

Some cards offer **Do not ask again for this for 30 days**. Ticking it saves your answer for that tool on that agent, but a call that changes or deletes something still asks every time: a second check asks about those calls whatever you ticked.

## When an agent asks for a connector

Agents are told which connectors are connected and which ones you could add. An agent that needs one it does not have says so and stops, and a card in the chat offers a button for each connector it named, such as **Connect Linear** or **Add key Notion**. The button opens that connector in Connectors.

The card only takes you to the connector: connecting it there does not give the agent access. Give it to the agent on the graph, then press **Continue** on the card (in a team chat) so the agent picks the work back up.

## Add your own MCP server

At the foot of the list, **Add your own MCP server** adds a server that speaks MCP over stdio, which means a program Clawboo starts on this machine.

<Steps>

<Step title="Fill in the form">

Enter a **Name**, the **Command** (an absolute path, or a program name found on your `PATH`) and its **Arguments**, separated by spaces. Arguments go straight to the program, never through a shell.

</Step>

<Step title="Add it">

Press **Add**. The server joins **More connectors** as one of your own entries.

</Step>

<Step title="Connect it and give it to an agent">

Press **Connect** on its row, then give it to an agent on the graph.

</Step>

</Steps>

The form has no URL field, so a remote MCP server cannot be added here. A community entry works the same way once added: **Connect** on it shows the exact command, package and version, and **I trust it, add it** makes it one of your own entries. Clawboo has reviewed neither kind, so it treats them as able to read private data, take in outside content and send data out, and every call they make asks you first.

## OpenClaw agents and connectors

OpenClaw agents reach Clawboo's tools through one setting in the OpenClaw Gateway that all of them share, so Clawboo cannot tell which OpenClaw agent is calling. As a result, connectors you give an OpenClaw agent on the graph do not reach it, the browser connectors included. It can use apps reached through Composio, and each action in those apps asks you first. The Gateway's own MCP servers and plugins are separate: they are listed in the [Capabilities](/using/capabilities) panel.

## Keep connectors safe

<Warning>

A local connector is a program running under your user account. Clawboo starts it with a short list of ordinary environment variables plus the keys you entered for it, never your AI provider keys, and passes its arguments without a shell. That is not a sandbox: the connector can still read any file your account can, including your SSH keys and Clawboo's database. Connect only servers you would be willing to run yourself.

</Warning>

## Troubleshooting

<AccordionGroup>

<Accordion title="An agent says a connector is connected but cannot use it">

Connecting makes a connector available; it gives no agent access. Agents are told which connectors are connected whether or not they hold one. Give the connector to that agent on the graph, then ask again.

</Accordion>

<Accordion title="Connect fails with: needs npx, which comes with Node.js">

The machine running Clawboo has no `npx` on its `PATH`. Install Node.js from [nodejs.org](https://nodejs.org), restart Clawboo, and press **Connect** again.

</Accordion>

<Accordion title="The first connect fails with: did not respond in time">

The first start of a connector downloads its package, which can take a minute on a slow network. The button reads **Working…** meanwhile. Press **Connect** again; the second start is faster.

</Accordion>

<Accordion title="Connect fails with: did not accept that key">

The service refused the key or token. Copy it again in full, and check that it has not expired. Then open the connector's detail pane (click its row) and paste it under **What you gave it**.

</Accordion>

<Accordion title="Connect fails with: accepted the key but refused the request">

The key works but lacks a permission. Check the scopes or permissions on the token you created at the service, for example Read and write on Contents, Issues and Pull requests for GitHub.

</Accordion>

<Accordion title="Sign-in says: Your browser blocked the sign-in window">

Allow pop-ups for the Clawboo address in your browser, then press **Connect** (or **Sign in**) again.

</Accordion>

<Accordion title="Saving the Composio key says: That is a Composio login key">

You pasted the key the Composio command line uses. The key this field needs starts with `ak_` and is on your Composio project's API keys page (**Get a key** opens it).

</Accordion>

<Accordion title="A tile shows: Changed since you approved it">

Clawboo refuses that connector's calls because its command or its list of tools changed after you gave access. If you changed its key, folder or command yourself, turn it off and connect it again in Connectors: that approves the new setup. A changed tool list is not approved again automatically, and there is no dashboard control that approves one, so read what changed in the connector's detail pane before you rely on it.

</Accordion>

</AccordionGroup>

More fixes for error messages are in [Troubleshooting](/help/troubleshooting).

## Next steps

- [Approvals](/using/approvals): answer the cards that connector calls raise.
- [Capabilities](/using/capabilities): every skill, tool and connector your agents have, in one list.
- [Org chart](/using/org-chart): the graph where you give and take back access.
- [What agents can do](/concepts/permissions): what an agent can reach on each runtime, beyond connectors.
- [Connectors API](/reference/rest-api/connectors): connect connectors and manage access from scripts.
