---
title: 'Reference'
sidebarTitle: 'Overview'
description: 'Exact facts about Clawboo, checked against the code: commands, configuration, environment variables, limits, shortcuts, MCP tools, events, the database and the REST API.'
icon: 'book-open'
keywords: ['reference', 'cli', 'env vars', 'limits', 'shortcuts', 'rest api', 'mcp', 'schema']
---

Reference pages state exact facts: names, defaults, limits and formats, checked against the code. Come here to look something up. For step-by-step help, start at [Use Clawboo](/using/index); for how the pieces fit together, see [Key concepts](/concepts/index).

## Pages in this section

| Page                                                      | Look here for                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [CLI](/reference/cli)                                     | Every `clawboo` command and flag, how it finds and stops the server, the server log, exit codes, and the MCP stdio bins                    |
| [Configuration](/reference/configuration)                 | Where each setting lives: `settings.json`, the database, your browser, the files in `~/.clawboo`, and what Clawboo writes in `~/.openclaw` |
| [Environment variables](/reference/environment-variables) | Every variable Clawboo reads or sets, with its type, default, effect and an example                                                        |
| [Limits and defaults](/reference/limits-and-defaults)     | Every built-in number: delegation caps, watchdogs, breakers, approval windows, rate limits, ports and timeouts                             |
| [Keyboard shortcuts](/reference/keyboard-shortcuts)       | Every dashboard shortcut, the chat slash commands, and Settings search                                                                     |
| [MCP tools](/reference/mcp-tools)                         | The four MCP servers (Tasks, Memory, Tools, TeamChat) and every tool's inputs                                                              |
| [Events and errors](/reference/events-and-errors)         | The 25 kinds of event in the event log and the error classes a run can end with                                                            |
| [Database schema](/reference/database-schema)             | The 35 tables in `clawboo.db` and their columns                                                                                            |
| [Marketplace catalog](/reference/marketplace-catalog)     | The 19 packs behind the marketplace's 436 agents and 85 teams, and how Clawboo fetches and checks them                                     |

## REST API and MCP

The REST API has its own group in this section. Start at the [REST overview](/reference/rest-api/index) for the address, authentication, rate limits and errors, and an index of all 199 routes; each resource has its own page from there.

MCP has two pages: [MCP tools](/reference/mcp-tools) lists every tool and its inputs, and [MCP servers](/operating/mcp-servers), under self-hosting, shows how to attach an agent you run yourself.

## Packages

Clawboo's code is split into 33 workspace packages under `packages/`: 27 at the top level and 6 runtime adapters, one of which is a test runtime. They are documented for contributors in the Contribute tab, starting at the [Packages overview](/reference/packages/index).

## Related

- [Use Clawboo](/using/index): how-to guides for every part of the dashboard
- [Self-hosting](/operating/index): deployment, security, and data and state
- [Help](/help/troubleshooting): fixes for errors you may see
- [Glossary](/appendices/glossary): what each term means, including old names
