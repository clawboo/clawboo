# Third-Party Notices

Clawboo is MIT licensed (see [LICENSE](./LICENSE)). It bundles and builds on open-source
software. This file lists the notable third-party code and content it uses, and the
licenses verified for each.

---

## Bundled dependencies

Code from these packages ships inside the published `clawboo` npm package (the bundled
server and the dashboard). Full license texts are distributed with each package in
`node_modules`.

| Package                     | License    |
| --------------------------- | ---------- |
| `@anthropic-ai/sdk`         | MIT        |
| `openai`                    | Apache-2.0 |
| `@modelcontextprotocol/sdk` | MIT        |
| `croner`                    | MIT        |
| `better-sqlite3`            | MIT        |
| `drizzle-orm`               | Apache-2.0 |
| `zod`                       | MIT        |
| `react`, `react-dom`        | MIT        |
| `@xyflow/react`             | MIT        |
| `elkjs`                     | EPL-2.0    |
| `framer-motion`             | MIT        |
| `zustand`                   | MIT        |
| `@tanstack/react-query`     | MIT        |
| `codemirror`                | MIT        |
| `lucide-react`              | ISC        |
| `simple-icons`              | CC0-1.0    |
| `tailwindcss`               | MIT        |
| `pino`, `ws`                | MIT        |

The Apache-2.0 components (`openai`, `drizzle-orm`) are used under the terms of the
Apache License, Version 2.0. `elkjs` (the graph-layout backend for the Atlas / Ghost
Graph, imported by `@xyflow/react`) is used under the terms of the Eclipse Public
License, Version 2.0 (EPL-2.0); it is bundled unmodified, and its source is available
on npm and at https://github.com/kieler/elkjs. `simple-icons` brand marks are used
under CC0-1.0; brand logos themselves remain the property of their respective owners.

## Development dependencies

These are used to build and test Clawboo and are not shipped in the npm package:
`@playwright/test` (Apache-2.0), `msw` (MIT), `jest-axe` (MIT), `axe-core` (MPL-2.0),
`vitest` (MIT), `turbo` (MIT), `tsup` (MIT), `eslint` (MIT).

---

## Bundled content

### agency-agents

**Source**: https://github.com/msitarzewski/agency-agents
**Ingested commit**: `64eee9f8e04f69b04e78e150d771a443c64720be`
**Content location**: `apps/web/src/features/marketplace/agents/agency/`
**Files ingested**: 179 agent `.md` files across 13 domain folders

MIT License

Copyright (c) 2024 msitarzewski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### awesome-openclaw-usecases

**Source**: https://github.com/hesamsheikh/awesome-openclaw-usecases
**Ingested commit**: `659895e58e2105c6db8fbef39f446c8a786a480c`
**Content location**: `apps/web/src/features/marketplace/agents/awesome-openclaw/`
**Files ingested**: 42 usecase `.md` files transformed into 110 agent catalog entries

Each generated catalog entry stores the full, verbatim usecase body in its
`identityTemplate` field (zero-loss ingestion), with a source URL pointing back to the
exact file at the pinned commit.

MIT License

Copyright (c) 2024 Hesam Sheikh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Clawboo built-in agents

The 15 built-in agent catalog entries (5 hand-authored team templates of 3 agents each)
are first-party Clawboo content. No external attribution required.

---

## Acknowledgements

Clawboo integrates with these open-source AI agent runtimes as peer teammates. Each runs
on its own terms and keeps its own native capabilities; Clawboo coordinates them over MCP.

- **OpenClaw**: https://github.com/openclaw/openclaw
- **Hermes** (`hermes-agent`)
- **Claude Code** (Anthropic Claude Agent SDK)
- **Codex** (OpenAI Codex CLI)

Clawboo's architecture and design were also informed by studying prior art in the
open-source agent-orchestration space, among them Paperclip
(https://github.com/paperclipai/paperclip) and vibe-kanban. The design of Clawboo's
Hermes runtime integration was additionally informed by studying Nous Research's
hermes-paperclip-adapter (https://github.com/NousResearch/hermes-paperclip-adapter,
MIT), the reference for running Hermes Agent as a managed worker. No code or content
from these projects is included in Clawboo: each adapter implements its own host's
interface (Clawboo's `RuntimeAdapter` trait over `@clawboo/executor`, versus Paperclip's
`@paperclipai/adapter-utils` API), and the only overlap is the `hermes chat` CLI flags
both drive, which are Hermes Agent's own documented contract, not shared code. These
projects are credited here as design inspiration.
