---
title: 'License & third-party notices'
description: 'Clawboo is MIT-licensed. What ships in the npm package and under which licenses, and where the marketplace content comes from.'
---

Clawboo is open-source software under the **MIT License**. This page summarizes that license, the notable third-party code that ships inside the published package, and the upstream content the [marketplace catalog](/reference/marketplace-catalog) is adapted from. The repository's two canonical files are the source of truth:

- [`LICENSE`](https://github.com/clawboo/clawboo/blob/main/LICENSE): the MIT license text and copyright holder.
- [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md): the full per-dependency license table and the verbatim upstream license texts.

This page is a reading guide to those files, not a replacement for them. When in doubt, the two files above govern.

## At a glance

| Item                      | Value                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Project license           | MIT                                                                                                                              |
| Copyright holder          | Sanreds (2026)                                                                                                                   |
| Published npm package     | `clawboo` (the CLI): license field `MIT`                                                                                         |
| Repo workspace packages   | All `@clawboo/*` are `private: true` and do not publish; they inline into the CLI's bundle                                       |
| Notable licenses          | MIT, Apache-2.0 (`openai`, `drizzle-orm`, `@composio/client`), EPL-2.0 (`elkjs`), ISC (`lucide-react`), CC0-1.0 (`simple-icons`) |
| Marketplace agent content | Mostly adapted from seventeen upstream repositories (sixteen MIT, one Apache-2.0), each pinned by commit SHA                     |

## Clawboo's own license: MIT

The repository's [`LICENSE`](https://github.com/clawboo/clawboo/blob/main/LICENSE) is the standard MIT License, `Copyright (c) 2026 Sanreds`. It grants permission to use, copy, modify, merge, publish, distribute, sublicense, and sell copies, with the usual "AS IS", no-warranty disclaimer, on the condition that the copyright notice and permission notice are retained in copies or substantial portions.

The only npm-published artifact is the **`clawboo` CLI package** ([`apps/cli/package.json`](https://github.com/clawboo/clawboo/blob/main/apps/cli/package.json)), whose `license` field is `MIT`. Everything you install with `npm install -g clawboo` (or `npx clawboo@latest` to try it without installing) ships under that license. See [CLI reference](/reference/cli) for what the package contains and [Run the Clawboo server](/operating/deployment) for how it starts.

<Note>

Every workspace library under `packages/` is named `@clawboo/*` and marked `private: true`. None of them publish to npm independently; they are bundled into the CLI's `dist/server.js` and `dist/ui/` at assembly time. So "the published software" is exactly the one `clawboo` package, under MIT. See the [package overview](/reference/packages/index).

</Note>

## Bundled third-party dependencies

The code listed below ships inside the published `clawboo` package. Most of it is bundled (inlined) at build time into the server bundle (`dist/server.js`) and the dashboard UI (`dist/ui/`), so it does **not** appear as separate entries in the installed package's `node_modules`. The package also declares nine runtime dependencies that npm installs normally, each with its own license file in `node_modules`: `@clack/prompts`, `@composio/client`, `better-sqlite3`, `chalk`, `commander`, `ora`, `pino`, `pino-pretty` and `ws`. For the inlined packages, the aggregated notices ship in [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md) (included in the package as `dist/THIRD_PARTY_NOTICES.md`), which is also the authoritative table; the summary here highlights the licenses you most need to know about.

| Package                     | License    | Role                                                                    |
| --------------------------- | ---------- | ----------------------------------------------------------------------- |
| `@anthropic-ai/sdk`         | MIT        | Provider SDK for [Clawboo Native](/runtimes/native)                     |
| `openai`                    | Apache-2.0 | Provider SDK (also OpenRouter / Ollama via base URL)                    |
| `@modelcontextprotocol/sdk` | MIT        | The [MCP](/operating/mcp-servers) server/client transport               |
| `croner`                    | MIT        | Cron parsing for [Routines](/concepts/scheduling)                       |
| `better-sqlite3`            | MIT        | The SQLite driver for [Clawboo's database](/operating/data-and-state)   |
| `drizzle-orm`               | Apache-2.0 | Typed schema/query layer over SQLite                                    |
| `zod`                       | MIT        | Runtime validation across packages                                      |
| `react`, `react-dom`        | MIT        | Dashboard UI                                                            |
| `@xyflow/react`             | MIT        | React Flow canvas for the [Org chart and team graphs](/using/org-chart) |
| `elkjs`                     | EPL-2.0    | Graph layout backend for the Org chart and team graphs                  |
| `framer-motion`             | MIT        | UI animation                                                            |
| `zustand`                   | MIT        | Client state                                                            |
| `codemirror`                | MIT        | The agent-file editor                                                   |
| `lucide-react`              | ISC        | Icons                                                                   |
| `simple-icons`              | CC0-1.0    | Brand marks (provider/runtime logos)                                    |
| `tailwindcss`               | MIT        | Styling                                                                 |
| `pino`, `ws`                | MIT        | Logging and WebSocket transport                                         |

A few notes on the non-MIT licenses, restated from [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md):

- **Apache-2.0** (`openai`, `drizzle-orm`, `@composio/client`): used under the terms of the Apache License, Version 2.0.
- **EPL-2.0** (`elkjs`): the graph-layout backend is used under the Eclipse Public License, Version 2.0. It is bundled unmodified; its source is available on npm and at the upstream repository linked in the notices file.
- **CC0-1.0** (`simple-icons`): the brand-mark _paths_ are CC0-1.0, but the brand logos themselves remain the property of their respective owners. Clawboo renders provider and runtime marks from `simple-icons` where it carries one.

Development-only dependencies (Playwright, MSW, Vitest, Turbo, tsup, ESLint, jest-axe, axe-core) are used to build and test Clawboo and are **not** shipped in the npm package. Their licenses are listed in the notices file.

## Marketplace content

The marketplace catalog holds **436 agents** and **85 teams** in **nineteen packs** (see the [marketplace catalog reference](/reference/marketplace-catalog) for the full breakdown). The npm package includes only the built-in pack; the dashboard downloads the rest. Most of the agent content is **adapted from seventeen upstream repositories**, sixteen MIT-licensed and one Apache-2.0, each pinned by commit SHA so the provenance is reproducible. The pack files under the repository's `catalog/packs/` folder are written by hand and reviewed like any other file, and `pnpm catalog:build` turns them into the index the dashboard downloads. Each pack carries its own `NOTICE.md` alongside the summary here.

| Upstream                                                                                                | License                      | Pinned commit                              | Adapted into                                                                              |
| ------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)                           | MIT                          | `64eee9f8e04f69b04e78e150d771a443c64720be` | 116 agency agents and 5 workflow teams                                                    |
| [`wshobson/agents`](https://github.com/wshobson/agents)                                                 | MIT                          | `d82998e7df393c671ede2387a8435075f0b633f5` | 97 engineering agents and 24 teams                                                        |
| [`VoltAgent/awesome-claude-code-subagents`](https://github.com/VoltAgent/awesome-claude-code-subagents) | MIT                          | `c9e51ec0b3d43f5dcdd0b558a6cd28ba6ada97c1` | 24 research and orchestration agents (teams are original)                                 |
| [`coreyhaines31/marketingskills`](https://github.com/coreyhaines31/marketingskills)                     | MIT                          | `b1aaa3619e747f4a836c61e03084c4a531de1262` | 26 growth-marketing agents, 5 teams, 9 pack skills                                        |
| [`garrytan/gstack`](https://github.com/garrytan/gstack)                                                 | MIT                          | `394db326f2d3aaccd4804fe846b82aaa7d189dee` | 14 founder-sprint agents and 4 teams (role structure only, every word written by Clawboo) |
| [`mattpocock/skills`](https://github.com/mattpocock/skills)                                             | MIT                          | `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76` | 12 engineering-craft agents, 3 teams, 7 pack skills                                       |
| [`alirezarezvani/claude-skills`](https://github.com/alirezarezvani/claude-skills)                       | MIT                          | `19392f7a08264ed00486a251f5b2098321771f94` | 18 business and compliance agents and 4 teams                                             |
| [`phuryn/pm-skills`](https://github.com/phuryn/pm-skills)                                               | MIT                          | `18468a95b427e70e258b51389796367c6f684e7d` | 12 product-craft agents and 3 teams                                                       |
| [`google/skills`](https://github.com/google/skills)                                                     | Apache-2.0                   | `0dad3f947e45a736060e524bbefa3eab692809f9` | 7 ads and analytics agents and 1 team                                                     |
| [`TheCraigHewitt/skills`](https://github.com/TheCraigHewitt/skills)                                     | MIT                          | `fdbf39b61fbc8cb7cea67949bfb5e8fc567bbc51` | 14 creator and founder operations agents and 4 teams                                      |
| [`calesthio/generative-media-skills`](https://github.com/calesthio/generative-media-skills)             | MIT                          | `8c85352d5d75d4dcbe58480bd138e37b9742bab1` | 12 generative-media agents, 4 teams, 9 pack skills                                        |
| [`AgriciDaniel/claude-repurpose`](https://github.com/AgriciDaniel/claude-repurpose)                     | MIT                          | `669187e2b69ef3c854d149657b7fb2483263dab4` | 8 content-repurposing agents and 2 teams                                                  |
| [`charlie947/social-media-skills`](https://github.com/charlie947/social-media-skills)                   | MIT                          | `d2e948719eafc8ed9e2436357ad18489bb371a81` | 12 creator-studio agents and 3 teams                                                      |
| [`thatrebeccarae/claude-marketing`](https://github.com/thatrebeccarae/claude-marketing)                 | MIT                          | `a8a63ec1341f05ec9c1e9cb52b4edeb14e3bdcba` | 6 lifecycle-commerce agents, 2 teams, 7 pack skills                                       |
| [`kgelster/awesome-ecom-skills`](https://github.com/kgelster/awesome-ecom-skills)                       | MIT                          | `0b6f9e51b4a14b030ab52a2f1ff8a320bdc50070` | 5 storefront-catalog agents, 1 team, 6 pack skills                                        |
| [`black-forest-labs/skills`](https://github.com/black-forest-labs/skills)                               | MIT                          | `8907d515b0ac270a988ec7a239add81ee13d6cba` | 2 image and shot direction agents and 4 pack skills (no teams)                            |
| [`heygen-com/skills`](https://github.com/heygen-com/skills)                                             | MIT                          | `1bd5e4d33a028dfed3abf504c5e3dd644fb9ea8a` | 1 presenter-video agent and 3 pack skills (no teams)                                      |
| Clawboo built-in                                                                                        | first-party (MIT, this repo) | n/a (local, no upstream SHA)               | 15 built-in agents (5 hand-authored 3-agent teams)                                        |
| Clawboo life and home                                                                                   | first-party (MIT, this repo) | n/a (local, no upstream SHA)               | 35 agents and 10 teams                                                                    |

Every pack records its upstream repository and pinned commit in its manifest's `provenance` block. Entries from two packs (agency-agents and VoltAgent) also carry an `origin.url` linking back to the exact upstream file at that commit, for example:

```text
https://github.com/msitarzewski/agency-agents/blob/64eee9f8e.../engineering/engineering-backend-architect.md
```

Entries are **adapted, not verbatim**: they were pruned, renamed, re-described, and re-formatted by the Clawboo maintainers, and each stores the whole edited instruction body (never a summary) in its `IDENTITY.md` document. The upstream license texts are reproduced in [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md), each alongside a note recording those modifications.

<Info>

The two first-party packs, the 15 built-in agents and the 35 life-and-home agents, are content authored in this repo. They carry no external attribution and no `origin.url`. The founder-sprint pack also ships under the `clawboo` publisher folder, but it is adapted rather than first-party: it carries the `garrytan/gstack` provenance and its own `NOTICE.md`.

</Info>

The 44 curated skills in the marketplace's **Skills** tab are first-party annotations, except that the process taught by 14 of them is adapted from [`obra/superpowers`](https://github.com/obra/superpowers) (MIT, pinned at `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`). Seven packs also declare skills of their own, 45 in total; those declarations are covered by the same pack notices as the agents that use them.

## Runtime acknowledgements

Clawboo coordinates other open-source AI agent [runtimes](/runtimes/index) as peer teammates. Each runs on its own terms under its own license. Clawboo drives each runtime through its own CLI, SDK or Gateway, and the runtimes reach Clawboo's board, memory and tools over [MCP](/operating/mcp-servers). The acknowledgements section of [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md) credits:

- **OpenClaw**: runs its agents through its own Gateway. See [OpenClaw](/runtimes/openclaw).
- **Hermes** (`hermes-agent`), **Claude Code** (Anthropic Claude Agent SDK), and **Codex** (OpenAI Codex CLI): the runtimes Clawboo starts for each run.

It also credits prior art in the agent-orchestration space (Paperclip, vibe-kanban, Nous Research's `hermes-paperclip-adapter`, and Graphify) as design inspiration.

## Related

- [`LICENSE`](https://github.com/clawboo/clawboo/blob/main/LICENSE) and [`THIRD_PARTY_NOTICES.md`](https://github.com/clawboo/clawboo/blob/main/THIRD_PARTY_NOTICES.md): the governing files in the repository.
- [Marketplace catalog reference](/reference/marketplace-catalog): the pack format, the sources and counts, and the checks that keep them accurate.
- [CLI reference](/reference/cli): the one published npm package.
- [Choose a runtime](/runtimes/index): the runtimes Clawboo coordinates.
- [Contributing](/appendices/contributing): how to contribute to the project.
