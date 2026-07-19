---
title: License & third-party notices
description: Clawboo is MIT-licensed. Summary of the bundled runtime stack, their licenses, and the MIT-licensed upstream marketplace content.
---

Clawboo is open-source software under the **MIT License**. This page summarizes that license, the notable third-party code that ships inside the published package, and the upstream content the [marketplace catalog](/reference/marketplace-catalog) is adapted from. The repository's two canonical files are the source of truth:

- [`LICENSE`](https://github.com/clawboo/clawboo/blob/main/LICENSE): the MIT license text and copyright holder.
- [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md): the full per-dependency license table and the verbatim upstream license texts.

This page is a reading guide to those files, not a replacement for them. When in doubt, the two files above govern.

## At a glance

| Item                      | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Project license           | MIT                                                                                                          |
| Copyright holder          | Sanreds (2026)                                                                                               |
| Published npm package     | `clawboo` (the CLI): license field `MIT`                                                                     |
| Repo workspace packages   | All `@clawboo/*` are `private: true` and do not publish; they inline into the CLI's bundle                   |
| Notable bundled licenses  | MIT, Apache-2.0 (`openai`, `drizzle-orm`), EPL-2.0 (`elkjs`), ISC (`lucide-react`), CC0-1.0 (`simple-icons`) |
| Marketplace agent content | Adapted from two MIT-licensed upstream repos, pinned by commit SHA                                           |

## Clawboo's own license: MIT

The repository's [`LICENSE`](https://github.com/clawboo/clawboo/blob/main/LICENSE) is the standard MIT License, `Copyright (c) 2026 Sanreds`. It grants permission to use, copy, modify, merge, publish, distribute, sublicense, and sell copies, with the usual "AS IS", no-warranty disclaimer, on the condition that the copyright notice and permission notice are retained in copies or substantial portions.

The only npm-published artifact is the **`clawboo` CLI package** ([`apps/cli/package.json`](https://github.com/clawboo/clawboo/blob/main/apps/cli/package.json)), whose `license` field is `MIT`. Everything you install with `npm install -g clawboo` (or `npx clawboo` to try it without installing) ships under that license. See [The CLI](/reference/cli) for what the package contains and [Deployment](/operating/deployment) for how it boots.

<Note>
Every workspace library under `packages/` is named `@clawboo/*` and marked `private: true`. None of them publish to npm independently; they are bundled into the CLI's `dist/server.js` and `dist/ui/` at assembly time. So "the published software" is exactly the one `clawboo` package, under MIT. See the [package overview](/reference/packages/index).
</Note>

## Bundled third-party dependencies

The code listed below ships inside the published `clawboo` package (the bundled server and the dashboard UI). Full license texts are distributed with each package in `node_modules`. The authoritative table lives in [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md); the summary here highlights the licenses you most need to know about.

| Package                     | License    | Role                                                                       |
| --------------------------- | ---------- | -------------------------------------------------------------------------- |
| `@anthropic-ai/sdk`         | MIT        | Provider SDK for the [native runtime](/runtimes/native)                    |
| `openai`                    | Apache-2.0 | Provider SDK (also OpenRouter / Ollama via base URL)                       |
| `@modelcontextprotocol/sdk` | MIT        | The [MCP](/operating/mcp-servers) server/client transport                  |
| `croner`                    | MIT        | Cron parsing for [Routines](/concepts/scheduling)                          |
| `better-sqlite3`            | MIT        | The SQLite driver behind [the registry of record](/internals/agent-source) |
| `drizzle-orm`               | Apache-2.0 | Typed schema/query layer over SQLite                                       |
| `zod`                       | MIT        | Runtime validation across packages                                         |
| `react`, `react-dom`        | MIT        | Dashboard UI                                                               |
| `@xyflow/react`             | MIT        | React Flow canvas for the [Ghost Graph / Atlas](/using/ghost-graph)        |
| `elkjs`                     | EPL-2.0    | Graph layout backend for the Ghost Graph                                   |
| `framer-motion`             | MIT        | UI animation                                                               |
| `zustand`                   | MIT        | Client state                                                               |
| `@tanstack/react-query`     | MIT        | Server-state caching                                                       |
| `codemirror`                | MIT        | The agent-file editor                                                      |
| `lucide-react`              | ISC        | Icons                                                                      |
| `simple-icons`              | CC0-1.0    | Brand marks (provider/runtime logos)                                       |
| `tailwindcss`               | MIT        | Styling                                                                    |
| `pino`, `ws`                | MIT        | Logging and WebSocket transport                                            |

A few notes on the non-MIT licenses, restated from [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md):

- **Apache-2.0** (`openai`, `drizzle-orm`): used under the terms of the Apache License, Version 2.0.
- **EPL-2.0** (`elkjs`): the graph-layout backend is used under the Eclipse Public License, Version 2.0. It is bundled unmodified; its source is available on npm and at the upstream repository linked in the notices file.
- **CC0-1.0** (`simple-icons`): the brand-mark _paths_ are CC0-1.0, but the brand logos themselves remain the property of their respective owners. Clawboo renders provider and runtime marks from `simple-icons` where one exists, and uses original lettermark tiles otherwise (it never reproduces a logo `simple-icons` does not carry).

Development-only dependencies (Playwright, MSW, Vitest, Turbo, tsup, ESLint, jest-axe, axe-core) are used to build and test Clawboo and are **not** shipped in the npm package. Their licenses are listed in the notices file.

## Bundled content: the marketplace catalog

The marketplace ships **304 agents** and **82 teams** (see the [marketplace catalog reference](/reference/marketplace-catalog) for the full breakdown). The agent content is not invented; most of it is **adapted from two MIT-licensed upstream repositories**, ingested verbatim and pinned by commit SHA so the provenance is reproducible. The ingestion mechanism is codegen'd and gated; see [Codegen & ingestion](/internals/codegen-and-ingestion) for how it works.

| Upstream                                                                                            | License                      | Pinned commit                              | Ingested into                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ | --------------------------------------------------- |
| [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)                       | MIT                          | `64eee9f8e04f69b04e78e150d771a443c64720be` | 179 agency agents                                   |
| [`hesamsheikh/awesome-openclaw-usecases`](https://github.com/hesamsheikh/awesome-openclaw-usecases) | MIT                          | `659895e58e2105c6db8fbef39f446c8a786a480c` | 110 awesome-openclaw agents (from 42 usecase files) |
| Clawboo built-in                                                                                    | first-party (MIT, this repo) | n/a (local, no upstream SHA)               | 15 built-in agents (5 hand-authored 3-agent teams)  |

The two pinned commit SHAs are constants in the ingestion source (`AGENCY_AGENTS_SHA` and `AWESOME_OPENCLAW_SHA`), and every generated catalog entry carries a `sourceUrl` that links back to the exact upstream file at that commit, for example:

```text
https://github.com/msitarzewski/agency-agents/blob/64eee9f8e.../engineering/engineering-ai-data-remediation-engineer.md
https://github.com/hesamsheikh/awesome-openclaw-usecases/blob/659895e58.../usecases/ai-video-editing.md
```

Ingestion is **zero-loss**: each generated entry stores the full, verbatim upstream body in its `identityTemplate` field. The full upstream MIT license texts (copyright holders `msitarzewski` and `Hesam Sheikh`) are reproduced in [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md).

<Info>
The 15 Clawboo built-in agents are first-party content authored in this repo (5 team templates of 3 agents each, synthesized at import time rather than written as literal catalog rows). They carry no external attribution and an empty `sourceUrl`.
</Info>

## Runtime acknowledgements

Clawboo coordinates other open-source AI agent [runtimes](/runtimes/index) as peer teammates. Each runs on its own terms under its own license; Clawboo does not vendor their code; the adapters drive each runtime's own CLI/SDK contract over [MCP](/operating/mcp-servers). The acknowledgements section of [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md) credits:

- **OpenClaw**: the Gateway-driven [connected substrate](/runtimes/openclaw).
- **Hermes** (`hermes-agent`), **Claude Code** (Anthropic Claude Agent SDK), and **Codex** (OpenAI Codex CLI): the wrapped-one-shot runtimes.

It also credits prior art in the agent-orchestration space (Paperclip, vibe-kanban, and Nous Research's `hermes-paperclip-adapter`) as design inspiration.

## See also

- [`LICENSE`](https://github.com/clawboo/clawboo/blob/main/LICENSE) and [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md): the governing files in the repo
- [Marketplace catalog reference](/reference/marketplace-catalog): agent/team schemas, sources, and counts
- [Codegen & ingestion](/internals/codegen-and-ingestion): how the catalog is generated and the `verify:ingest` gate
- [The CLI](/reference/cli): the single published npm package
- [Runtimes overview](/runtimes/index): the peer runtimes Clawboo coordinates
- [Contributing](/appendices/contributing): how to contribute to the project
- [Glossary](/appendices/glossary): canonical term definitions
