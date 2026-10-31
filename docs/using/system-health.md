---
title: 'Check System Health'
sidebarTitle: 'System Health'
description: 'Read the checks Clawboo runs on its own folder, database, key vault and connections, and fix the one that fails.'
icon: 'heart-pulse'
keywords:
  [
    'boot probe',
    'diagnostics',
    'health check',
    'degraded',
    'fatal',
    'master key',
    'secrets vault',
    'Re-run probe',
  ]
---

**System Health** shows whether Clawboo's own parts work: its folder, its database, the vault that holds your keys, the tool servers your agents use, and its connections to the OpenClaw Gateway and an OpenTelemetry collector. Use this page when something in Clawboo is not working, or to check an install after an upgrade or a move. For your agents' own work and errors, see [Check on your agents](/using/observability).

## Open System Health

Open **Settings** (the **Settings** row at the bottom of the left sidebar, or Cmd+, on macOS and Ctrl+, on Windows and Linux), then **System Health** in the **System** group. It works on a fresh install before you connect anything, and while the OpenClaw Gateway is down.

Clawboo runs its checks each time its server starts. The panel shows the results of the last run and reads them again every 30 seconds while its tab is visible, but reading does not run the checks again. Click **Re-run probe** to run them now, for example after you fix something.

A failed check never stops Clawboo. The server keeps running, so you can read the details here.

## Read the panel

- **The header pill** sums up the checks: **All systems go**, **N degraded** or **N fatal**. If you don't use OpenClaw, expect **1 degraded** from the **OpenClaw Gateway** check (see [Fix a failing check](#fix-a-failing-check)).
- **A banner** appears when a check fails. "Running degraded." means some optional parts are unavailable and the rest of Clawboo works normally. "The install has a fatal problem." means Clawboo cannot work properly until you fix it. The banner points you to the failing check, and to resetting `~/.clawboo` only as the last resort.
- **Checks** lists each check with an **OK**, **Degraded** or **Fatal** pill, how long it took, and a one-line result. A failed check also shows its details: what went wrong, often with the file or setting involved.
- **Runtime state** and **Production defaults** show what this server is using (see [Runtime state and defaults](#runtime-state-and-defaults)).

## The checks

The checks run in this order. Three of them are fatal when they fail, because nothing works without them; the rest are degraded.

| Check                         | What it checks                                                                                                                                                | When it fails |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Clawboo home writable**     | Clawboo can create and write its folder, `~/.clawboo` (or the folder `CLAWBOO_HOME` names)                                                                    | Fatal         |
| **Secrets vault permissions** | Only your user account can read the key vault's folder, its master key, and the key Clawboo uses to identify itself to the OpenClaw Gateway (macOS and Linux) | Degraded      |
| **Master key**                | The vault's master key can still decrypt what it encrypted                                                                                                    | Degraded      |
| **Database integrity**        | The database opens and passes SQLite's integrity check                                                                                                        | Fatal         |
| **Database schema**           | Every table and column Clawboo needs is in the database                                                                                                       | Fatal         |
| **API port file**             | The port file names the port this server listens on                                                                                                           | Degraded      |
| **MCP servers**               | Clawboo's four tool servers start and answer: tasks (the board), memory, tools (connected apps) and teamchat (messages between agents)                        | Degraded      |
| **OpenClaw Gateway**          | Clawboo's server is connected to the OpenClaw Gateway. Without a running Gateway it always reads **Degraded**, even if you don't use OpenClaw                 | Degraded      |
| **OTel exporter**             | The OpenTelemetry exporter loaded. Passes as disabled when no endpoint is set                                                                                 | Degraded      |

## Fix a failing check

Fix the fatal checks first: a database that cannot open also stops the **MCP servers** check. After a fix, click **Re-run probe**. Where a fix says to restart Clawboo, run `clawboo restart` (on an install protected by an access token, see the [CLI reference](/reference/cli) instead).

<AccordionGroup>

<Accordion title="Clawboo home writable is Fatal">

**What it means:** Clawboo cannot create or write its folder. The details give the system's reason, such as a permission error.

**Fix:** make sure your user account owns `~/.clawboo` and can write to it, or set `CLAWBOO_HOME` to a folder you can write. Then restart Clawboo.

</Accordion>

<Accordion title="Secrets vault permissions is Degraded">

**What it means:** other users on this computer could read the files that protect your keys. The details name each file and its current mode, such as `secrets/ is 755`.

**Fix:** make those files private to your account, then click **Re-run probe**. Run the line for each file the details name:

```bash
chmod 700 ~/.clawboo/secrets
chmod 600 ~/.clawboo/secrets/master.key
chmod 600 ~/.clawboo/proxy-device-identity.json
```

If you set `CLAWBOO_HOME`, use that folder instead of `~/.clawboo`.

</Accordion>

<Accordion title="Master key is Degraded">

**What it means:** the key that encrypts the vault is not the one that encrypted it, so Clawboo cannot read your saved provider keys or connector sign-ins. The **master key** row under **Runtime state** reads **unreadable** and asks you to re-enter runtime keys.

The key is `~/.clawboo/secrets/master.key`, or the value of `CLAWBOO_SECRETS_MASTER_KEY` when that is set. It usually changes when that variable is set, changed or removed, when `master.key` is deleted or replaced, or when `~/.clawboo` is restored without its `secrets` folder.

**Fix:**

1. If you can, put the original key back: set `CLAWBOO_SECRETS_MASTER_KEY` to its old value, or restore the original `master.key`. Restart Clawboo, then click **Re-run probe**. Your saved keys work again.
2. If the original key is gone, the saved keys cannot be recovered. Delete `~/.clawboo/secrets/runtime-keys.json`, the vault file that holds them, and click **Re-run probe**. Then re-enter your keys under **Settings** > **Providers** (or on a runtime's card under **Settings** > **Runtimes**, wherever you first entered them) and reconnect your connectors.

If the result says the vault is unreadable instead, the details give the reason, such as a `CLAWBOO_SECRETS_MASTER_KEY` that is not a 32-byte key.

</Accordion>

<Accordion title="Database integrity is Fatal">

**What it means:** the database could not be opened, or SQLite found damage in it. The details give SQLite's own words.

**Fix:** stop Clawboo with `clawboo stop` and restore `~/.clawboo/clawboo.db` from a backup. With no backup, keep a copy of the damaged file, then reset the data: Clawboo starts with an empty database, and you lose everything that was in it, such as your teams, board, chats and memory. [Data and state](/operating/data-and-state) has the steps for both.

</Accordion>

<Accordion title="Database schema is Fatal">

**What it means:** a table or column Clawboo needs is missing from the database. The details name it.

**Fix:** restart Clawboo first. Each time it opens the database it adds any missing columns, so this usually clears. If the result says the schema "cannot be upgraded in place", this version of Clawboo cannot run on that database: the details name the file and the choices. Either run the Clawboo version that created the database, or move the file aside to start clean, which loses everything stored in it, such as your teams, board, chats and memory.

</Accordion>

<Accordion title="API port file is Degraded">

**What it means:** `~/.clawboo/api-port.txt` names a different port from the one this server listens on, or is missing. The `clawboo` command reads this file to find the server, so `clawboo stop` and `clawboo restart` can miss this one. A common cause is a second Clawboo server that started later and wrote its own port.

**Fix:** if you run more than one Clawboo server, stop the one you don't need with `CLAWBOO_API_PORT=<port> clawboo stop`. Then run `clawboo restart`, and the running server writes its port again. This server's port is the **API port** row under **Runtime state**.

</Accordion>

<Accordion title="MCP servers is Degraded">

**What it means:** one of Clawboo's tool servers did not start or answer, so agents may lose its tools: board tasks, memory, connected apps or messages between agents. The details name the server and its error. "MCP servers not probed (database unavailable)" means the database failed first; fix that.

**Fix:** restart Clawboo. If the check still fails, look for the error in the server log, `~/.clawboo/server.log`, and [open an issue](https://github.com/clawboo/clawboo/issues) with the details.

</Accordion>

<Accordion title="OpenClaw Gateway is Degraded">

**What it means:** Clawboo's server was not connected to the OpenClaw Gateway when the checks ran. The result reads "OpenClaw Gateway not reachable", followed by the connection state, and the details give the Gateway's address. If you don't use OpenClaw, this is expected and harmless: Clawboo checks for a Gateway at its default address on every start, so the check reads **Degraded** and the panel says "Running degraded." even though nothing is wrong. If you do use OpenClaw, your OpenClaw agents still show as they were at the last sync but cannot take work. Your other runtimes are not affected.

**Fix:** if you use OpenClaw, start or reconnect the Gateway in **Settings** > **Runtimes** > **OpenClaw** (**Reconnect**, or **Manage** > **Restart**), then click **Re-run probe**. The check reflects the moment the checks ran, so a Gateway that started afterwards reads **Degraded** until you run them again. [OpenClaw](/runtimes/openclaw) covers the Gateway's own errors.

</Accordion>

<Accordion title="OTel exporter is Degraded">

**What it means:** an OpenTelemetry endpoint is set (`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), but the exporter failed to load. Traces stay in Clawboo's own log. On an install from npm this is expected: the package does not include the OpenTelemetry SDK.

**Fix:** to clear the warning, unset both variables and restart Clawboo. To export traces, run Clawboo where the SDK is installed, such as a source checkout. See [Export traces with OpenTelemetry](/using/observability#export-traces-with-opentelemetry).

</Accordion>

</AccordionGroup>

## Runtime state and defaults

**Runtime state** shows what this server is using. It helps when you have moved Clawboo's folder, or run more than one copy.

| Row                    | What it shows                                                              |
| ---------------------- | -------------------------------------------------------------------------- |
| **clawboo home**       | Clawboo's folder: `~/.clawboo`, or the folder `CLAWBOO_HOME` names         |
| **database**           | The database file this server uses                                         |
| **API port**           | The port this server listens on                                            |
| **OpenClaw state dir** | OpenClaw's folder, usually `~/.openclaw`                                   |
| **secrets vault**      | Whether the encrypted key vault exists: **present** or **not yet created** |
| **master key**         | **verified**, or **unreadable** when the **Master key** check failed       |

**Production defaults** shows how this version is set up out of the box. Its **log level** and **budget posture** rows always show the shipped default, not your own settings:

| Row                | What it shows                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **log level**      | Always `info`, the shipped level. Setting `LOG_LEVEL` changes what the server logs, but not this row                                                                                                      |
| **budget posture** | Always "track-and-warn (no global hard cap; warns at 80%)". It does not reflect your budgets: a hard cap you set in **Governance** does not show here (see [Budgets and spend](/using/budgets-and-spend)) |
| **observability**  | "local event log (OTel opt-in)", or "OTel exporter active" whenever an OpenTelemetry endpoint is set, even if the exporter failed to load. The **OTel exporter** check is the one to trust                |

<Accordion title="Under the hood">

- `GET /api/health` returns the report from the last run of the checks, and `POST /api/health/recheck` runs them again (the **Re-run probe** button). Both carry a top-level `ok`, which is `true` when no check is fatal, plus `fatal` and `degraded` lists of check ids. A monitor can read that one field.
- With an access token set (`STUDIO_ACCESS_TOKEN`), these routes need the access cookie like every other `/api` route.
- Check ids, in order: `clawbooHomeWritable`, `vaultPerms`, `masterKeyBootSentinel`, `databaseIntegrity`, `databaseSchema`, `apiPortFileMatches`, `mcpServersHealthy`, `openclawGatewayReachable`, `otelExporterReachable`.
- Credential-shaped text in a check's details is masked before it is sent.
- See the [Settings, health and layout API](/reference/rest-api/settings) for the full report shape.

```bash
curl -s http://localhost:18790/api/health
```

Use the port your Clawboo prints when it starts, if it is not 18790.

</Accordion>

## Next steps

- [Data and state](/operating/data-and-state): every file in `~/.clawboo`, and how to back up, restore and reset.
- [CLI reference](/reference/cli): restart Clawboo and find its log.
- [OpenClaw](/runtimes/openclaw): start, restart and repair the OpenClaw Gateway.
- [Connect providers and runtimes](/using/providers-and-runtimes): re-enter a provider key.
- [Check on your agents](/using/observability): your agents' work, errors and traces.
- [Troubleshooting](/help/troubleshooting): fixes for other problems.
