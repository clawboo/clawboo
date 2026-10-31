---
title: 'Update and maintain Clawboo'
sidebarTitle: 'System'
description: 'Update Clawboo from the Update available chip, update OpenClaw and restart its Gateway, set the default command approval, and find backups and logs.'
icon: 'settings'
keywords:
  [
    'system maintenance',
    'System panel',
    'update',
    'upgrade',
    'Update available',
    'Check for Updates',
    'openclaw doctor',
    'Command Approval',
    'version',
    'logs',
  ]
---

Use this page to update Clawboo, update OpenClaw and restart its Gateway, and find your backups and logs. It also covers the **System** panel in Settings, which shows your OpenClaw and Node.js versions, updates OpenClaw, and sets the default command approval for OpenClaw agents.

## Where things are

| You want to                                          | Go to                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Update Clawboo                                       | The **Update available** chip at the bottom left of the dashboard                                  |
| Update OpenClaw                                      | **Settings** > **System** > **Check for Updates**                                                  |
| Restart the OpenClaw Gateway                         | **Settings** > **Runtimes** > **OpenClaw** > **Manage**                                            |
| Set the default command approval for OpenClaw agents | **Settings** > **System** > **Command Approval**                                                   |
| Change one agent's command approval                  | The agent's page, **Details** > **Permissions**                                                    |
| Change the default model for OpenClaw agents         | **Settings** > **Runtimes** > **OpenClaw** > **Manage** > **Default model**                        |
| Add or remove a provider key                         | **Settings** > **Providers** (see [Connect providers and runtimes](/using/providers-and-runtimes)) |
| Check that Clawboo's own parts work                  | **Settings** > **System Health** (see [System Health](/using/system-health))                       |
| Back up your data, or read a log                     | The terminal (see [Backups and logs](#backups-and-logs))                                           |

**Check for Updates** in the **System** panel updates OpenClaw, not Clawboo. Clawboo updates from the chip.

## Update Clawboo

When a newer Clawboo is on npm, an **Update available** chip appears at the bottom left of the dashboard, with the new version number. Clawboo asks npm's registry for the newest version number, then reuses the answer for six hours. What the chip does depends on how you run Clawboo:

<Tabs>

<Tab title="Global install">

<Steps>

<Step title="Click the chip">

The chip reads **Click to update**. Click it. It shows **Installing update…** while npm installs `clawboo@latest`, then **Restarting…**.

</Step>

<Step title="Wait for the reload">

The server restarts on the same port, and the page reloads into the new version. You should see the dashboard as you left it. This browser remembers the last update check for up to an hour, so the chip can show again in that time even though you are up to date: dismiss it with its **×**. `clawboo --version` in a terminal prints the version you now have.

</Step>

</Steps>

If the page has not come back after about 90 seconds, the chip reads "Update installed. Restart Clawboo to finish." Run `clawboo restart`.

</Tab>

<Tab title="npx">

The chip reads **Copy command**. Click it to copy `npx clawboo@latest`, then run that in a terminal. It finds the older server still running and offers to restart it.

</Tab>

</Tabs>

The **×** on the chip hides it until a newer version comes out. To update a global install from a terminal instead:

```bash
npm install -g clawboo@latest
clawboo restart
```

Your data stays where it is: when a newer version opens your database, it adds what it needs. [Install, update and remove Clawboo](/getting-started/installation) covers installs in full.

If the update fails, see [Troubleshooting](#troubleshooting).

## The System panel

Open **Settings** > **System**, in the **System** group. The panel has two cards:

- **Command Approval**: the default command approval for OpenClaw agents. It appears only while the dashboard is connected to an OpenClaw Gateway. See [Set the default command approval](#set-the-default-command-approval).
- **System Info**: the installed **OpenClaw** version (or **Not installed**), the **Node.js** version Clawboo runs on, OpenClaw's **State Dir** (its folder, usually `~/.openclaw`), and **Config** (`openclaw.json`, or **Not found**). **Check for Updates** sits below them.

**System Info** is read once when you open the panel, and again after an update.

## Update OpenClaw

<Steps>

<Step title="Update the OpenClaw program">

Open **Settings** > **System** and click **Check for Updates**. It starts at once, with no confirmation: it runs `npm install -g openclaw@~2026.9` and shows npm's output below the button. You should see "Updated to" and the version, and the **OpenClaw** row shows the new version.

</Step>

<Step title="Restart the Gateway">

The Gateway that is already running keeps the old version until it restarts. Open **Settings** > **Runtimes**, click **Manage** on the **OpenClaw** row, and click **Restart** in its **Gateway** block. You should see "Gateway restarted".

</Step>

</Steps>

**Check for Updates** installs the newest release in the OpenClaw line this Clawboo is tested with (2026.9), which may not be OpenClaw's newest. If OpenClaw is not installed, the same button installs it; to set OpenClaw up and start its Gateway, use **Settings** > **Runtimes** > **OpenClaw** instead (see [OpenClaw](/runtimes/openclaw)). npm can refuse the install when your Node.js is outside the range OpenClaw supports, which is narrower than Clawboo's; the OpenClaw page lists it.

### If OpenClaw needs its data updated

A newer OpenClaw can refuse to start until `openclaw doctor --fix` updates data that an older version wrote. When Clawboo starts the Gateway and OpenClaw asks for this, Clawboo runs `openclaw doctor --fix --non-interactive` once, then starts the Gateway again. It does this whenever Clawboo starts the Gateway: **Restart**, **Reconnect OpenClaw**, or the OpenClaw setup. It leaves a Gateway you run as a launchd or systemd service alone. The repair usually takes seconds.

If the repair fails, the error says so and includes the reason ("OpenClaw needs `openclaw doctor --fix`, and running it failed"). Run `openclaw doctor --fix` in a terminal to see what it needs, then start the Gateway again. Do the same if OpenClaw still asks for it after Clawboo ran it. When the Gateway fails to start for another reason, the error reads "Gateway did not start:" followed by OpenClaw's own reason. The Gateway's log is `~/.clawboo/gateway.log`.

## Set the default command approval

The **Command Approval** card sets what OpenClaw agents do before they run a shell command, when they have no setting of their own. It writes `tools.exec.ask` in OpenClaw's `openclaw.json`.

| Option              | What it means                                        |
| ------------------- | ---------------------------------------------------- |
| **Run Freely**      | Agents run commands without asking                   |
| **Ask for Unknown** | Agents ask you about commands not on their allowlist |
| **Always Ask**      | Agents ask you about every command                   |

Pick an option from the **Default:** list. You should see "Default command approval set to" and the option's name. If the write fails, the list goes back to its old value and you see "Failed to update Gateway config".

This is a fallback, not an override. Every OpenClaw agent Clawboo creates gets its own setting, **Ask for Unknown**, and follows that instead. So the default mostly affects OpenClaw agents created outside Clawboo. When `openclaw.json` sets no default, the list shows **Run Freely**, which is also what OpenClaw does for an agent with no setting.

To change one agent, open its page and go to **Details** > **Permissions**; the hint under the list mentions a Personality tab, but the setting is on **Permissions**. [Command permissions](/using/command-permissions) covers per-agent settings and the commands an agent may run without asking. The default does not affect Clawboo Native, Claude Code, Codex or Hermes agents; [What agents can do](/concepts/permissions) explains what they may run.

## Backups and logs

- **Back up the database**: run `clawboo backup`. It writes a one-file copy of `~/.clawboo/clawboo.db` to the current folder, even while Clawboo runs. Your saved keys, and the key that decrypts them, are in `~/.clawboo/secrets/` and not in the copy. A good moment is right before you update.
- **Restore or reset**: [Data and state](/operating/data-and-state) has the steps, and lists what a full backup needs.
- **Server log**: `~/.clawboo/server.log`, for a server started with `clawboo`. It rolls over to `server.log.1` past 5 MB. After an update from the chip, the restarted server writes nothing to it until you run `clawboo restart`.
- **Gateway log**: `~/.clawboo/gateway.log`, for an OpenClaw Gateway that Clawboo started.

The [CLI reference](/reference/cli) covers `clawboo stop`, `clawboo restart` and `clawboo backup` in full.

<Accordion title="Under the hood">

- The chip reads `GET /api/system/self-version`, and **Click to update** calls `POST /api/system/self-update`, which runs `npm install -g clawboo@latest` and restarts the server on the same port. It works only for a global install; an npx run gets the command to copy instead.
- **Check for Updates** calls `POST /api/system/install-openclaw`. **Restart** calls `POST /api/system/gateway` with `{"action": "restart"}`, which waits up to 60 seconds for the Gateway's port.
- **Command Approval** reads `GET /api/system/openclaw-config` and writes `PATCH /api/system/openclaw-config` with `{"exec": {"ask": "on-miss"}}` (or `off`, `always`).
- See the [System API](/reference/rest-api/system) for every route.

</Accordion>

## Troubleshooting

<AccordionGroup>

<Accordion title="The chip says the update failed">

The chip shows npm's own reason, such as no matching version, a network failure, a permission problem or a package install script that failed, with a button that copies the command.

"Permission denied. A global install needs elevated permissions." means npm cannot write to its global folder, which is common with a system-wide Node.js. Run the copied command in a terminal, or install Node.js with a version manager such as nvm or fnm, which keeps global packages in your home folder and needs no `sudo`.

</Accordion>

<Accordion title="Check for Updates shows Permission denied">

The log reads "Permission denied. Your Node.js installation may require sudo for global installs." and suggests a `sudo npm install -g` command. npm cannot write to its global folder. Installing Node.js with a version manager such as nvm or fnm, or with Homebrew, keeps global packages where you can write them, so no `sudo` is needed. Then click **Check for Updates** again.

</Accordion>

<Accordion title="OpenClaw still runs the old version after an update">

**Check for Updates** replaces the OpenClaw program but leaves the running Gateway alone. Restart the Gateway: **Settings** > **Runtimes** > **OpenClaw** > **Manage** > **Restart**.

</Accordion>

<Accordion title="The Command Approval card is missing">

The card appears only while the dashboard is connected to an OpenClaw Gateway. Connect or reconnect OpenClaw in **Settings** > **Runtimes**. If you don't use OpenClaw, there is nothing to set here.

</Accordion>

<Accordion title="I can't find how to start or stop the Gateway">

The OpenClaw row in **Settings** > **Runtimes** holds those controls, not the **System** panel. While the Gateway runs, **Manage** shows **Restart**, and **Disconnect** stops it. While it is stopped, the row offers **Reconnect**, which starts it again. See [OpenClaw](/runtimes/openclaw).

</Accordion>

</AccordionGroup>

## Next steps

- [Install, update and remove Clawboo](/getting-started/installation): install methods, updating from a terminal, and uninstalling.
- [OpenClaw](/runtimes/openclaw): set up OpenClaw, manage its Gateway, and fix Gateway errors.
- [Command permissions](/using/command-permissions): review and revoke what each agent may run.
- [System Health](/using/system-health): check Clawboo's folder, database, vault and connections.
- [Data and state](/operating/data-and-state): every file Clawboo keeps, and how to back up, restore and reset.
