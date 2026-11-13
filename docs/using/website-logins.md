---
title: 'Let agents sign in to websites'
sidebarTitle: 'Website logins'
description: 'Save a website login, or connect 1Password, and an agent can sign in with it in its own browser. Clawboo fills the login into the page, so the agent never sees it.'
icon: 'log-in'
keywords:
  [
    'website logins',
    'sign in',
    'password',
    'fill_login',
    '1Password',
    'service account',
    'one-time code',
    'CAPTCHA',
    'passkey',
  ]
---

An agent that works in a browser sometimes has to sign in to a site. Instead of pasting a password into the chat, save the login in Clawboo, or connect your 1Password. When the agent reaches the site's sign-in page, it calls the `fill_login` tool and Clawboo fills the username, password and any one-time code straight into that page. The agent gets told only whether it worked.

## Before you begin

- The agent needs a browser of its own, from the Playwright or Chrome DevTools connector (see [Every agent gets a browser](/using/connectors#every-agent-gets-a-browser)), open on the site's sign-in page. With neither connector connected, **Settings** > **Website logins** says so and agents are not offered the fill; you can still save logins.
- The tool is offered to Claude Code, Codex, Hermes and Clawboo Native agents. OpenClaw agents do not get it, because Clawboo cannot tell which OpenClaw agent is calling (see [OpenClaw agents and connectors](/using/connectors#openclaw-agents-and-connectors)).

## Save a login

<Steps>

<Step title="Open Website logins">

Go to **Settings** > **Website logins** and choose **Add login**.

</Step>

<Step title="Enter the site and the login">

- **Site address**: the address you sign in at, such as `example.com` or `https://accounts.example.com`. Clawboo keeps only its origin: `https`, the host and the port.
- **Username** and **Password**.
- **One-time code key (optional)**: the setup key a site shows next to its authenticator QR code. Clawboo then fills the current six-digit code too.
- **Label (optional)**, to tell your logins apart.

</Step>

<Step title="Choose Save login">

The login goes into Clawboo's encrypted vault. From then on the dashboard shows only the site, the label, and whether a username or one-time code is set. Nothing reads a username, password or key back to the page, so to change one, choose **Edit** and type the new value. Fields you leave empty keep their value.

</Step>

</Steps>

You can save one login per site. To sign in at two addresses (say `example.com` and `accounts.example.com`), save it for each.

## Connect 1Password

Clawboo can also look logins up in 1Password, through 1Password's official SDK and a [service account](https://developer.1password.com/docs/service-accounts/) you create for it.

1. In 1Password, create a service account with read access to the vault that holds the logins your agents may use. Give it only those vaults.
2. In **Settings** > **Website logins**, paste its token under **1Password** and choose **Connect**. Clawboo checks that the token can read at least one vault before it saves it, in the vault.

**The first Connect installs 1Password support, once.** Clawboo is not shipped with 1Password's SDK. The first time anyone connects 1Password, Clawboo downloads it (version 0.5.0, about 14 MB) into its [runtimes folder](/operating/data-and-state#the-runtimes-folder), the way it installs Claude Code and Codex, and loads it from there. That can take a minute, and the card says it is installing. If the download fails, for example offline or behind a proxy npm cannot use, the card says so, nothing is saved, and the next **Connect** tries again.

A fill tries your saved login for the site first, then a 1Password **Login** item that lists the page's exact address among its websites. Items set to **Never** fill are skipped. **Disconnect** forgets the token.

## How an agent signs in

1. The agent opens the site's sign-in page in its browser.
2. It calls `fill_login` with the site, for example `example.com`.
3. Clawboo checks the page's address in the browser itself. The page must be on exactly the login's origin: the same scheme, host and port. A subdomain, a look-alike name or plain `http` does not match.
4. Clawboo fills only the fields the page shows, and none whose form sends it to another site. A page that asks for the email first gets only the username; the password goes in on the next step, when the agent calls `fill_login` again.
5. The agent submits the form.

`fill_login` answers one of:

| Answer           | What it means                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filled`         | The fields were filled. The answer names which ones (username, password, one-time code), never their values.                                                                                |
| `no saved login` | There is no login for that site that this run may use.                                                                                                                                      |
| `needs you`      | Only a person can go on: a CAPTCHA, a passkey or a card check, or 1Password could not be read.                                                                                              |
| `refused`        | The agent's tab is not on that site, it has no browser open, the page shows no sign-in field, you have taken over its browser, or the run belongs to no person. It says what to do instead. |

Clawboo fills through the browser connector the agent already uses, in the tab it has open. It reads the page's address from the browser itself, never from the agent, and checks it again inside the page in the same step that fills, so a page that moved to another site in between gets nothing. While you have taken over the agent's browser, it fills nothing.

## What only a person can do

A CAPTCHA, a passkey and a card check (such as a bank's 3-D Secure step) are left to you. When the run is working on a board task, Clawboo hands the task back to the person who asked for it, with a note saying which site and what it asks for, and the card moves to **Needs you**. Open the agent's page, take over its browser to finish signing in, then press **Retry**. In a chat with no task, the agent tells you in its reply instead.

## Whose logins a run may use

Logins belong to the person who saved them, and a run uses only its own person's logins and 1Password. Clawboo decides whose run it is once, when the run starts:

1. The person who started it: who sent the chat message, or pressed **Retry** or **Assign** on a task the task runner works.
2. Otherwise, the person who asked for the run's task, or for the nearest task above it that names someone.

With no [sign-in proxy](/guides/sso-proxy), the dashboard acts as its one person, so the work you start or ask for there is yours. What nobody started belongs to no one and fills nothing: a request that failed the person check, a task an agent made on its own, and a routine.

**A routine's run belongs to no one, so it cannot sign in.** That includes the work a routine hands out. Routines do not yet record who made them, so Clawboo cannot tell whose logins a routine may use, and it uses none.

On a team task the team engine starts again after a **Retry**, the run belongs to whoever asked for the task, not whoever pressed **Retry**.

### Who may use an agent can use what it holds

An agent works for everyone who may use it, and what it holds comes with it, logins included. Two things follow, so decide who may use each agent, and who may ask each team for work, with that in mind:

- **A sign-in stays in the agent's browser.** Each agent has one browser. After a fill, the site keeps that browser signed in, as any browser stays signed in, so the agent's later runs are signed in there too, for anyone who uses that agent.
- **A team works for everyone who asks it for work.** An agent can hand out work under any task of its own team, and that work counts as asked for by whoever asked for the task above it. So work an agent hands out under your task signs in with your logins.

## What this protects, and what it does not

- **Clawboo never hands the model a login.** No username, password, one-time code or 1Password token is in what `fill_login` answers, in the event log, in the tool audit, in the server's log or in any REST answer. The vault lends the saved passwords to the scrub that cleans stored text, and Clawboo masks a password it filled out of that agent's later browser results.
- **A login reaches only its own site.** The origin check is on the live page, not the agent's word for it.
- **A filled password is in the page.** The agent drives that page, so it can still read a field it can see, or run a script that sends it elsewhere. The mask catches a password copied out as it was filled, not one an agent changed first. Give an agent only logins for accounts you would trust it to use.
- **A sign-in stays with the agent.** Whoever may use that agent uses its signed-in browser too (see [Who may use an agent can use what it holds](#who-may-use-an-agent-can-use-what-it-holds)).
- **With [`CLAWBOO_AGENT_USER`](/operating/agent-isolation) on**, agents run as their own operating-system user and cannot read the vault, its key or the 1Password token. **Without it**, agents run as your user: they still never get a login through Clawboo, but a misbehaving agent process could read the vault and its key from your Clawboo folder like any other program you run.

## Related

- [Connectors](/using/connectors): the browsers agents fill logins into.
- [Security](/operating/security#keys-and-secrets-on-disk): where the vault lives and what it protects.
- [Agents on their own user](/operating/agent-isolation): keeping the vault out of agents' reach.
- [Website logins API](/reference/rest-api/website-logins) and the [`fill_login` tool](/reference/mcp-tools#fill_login).
