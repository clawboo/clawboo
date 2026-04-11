# Third-Party Notices

This file contains attribution notices for third-party content used in Clawboo.

---

## agency-agents

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

---

## awesome-openclaw-usecases

**Source**: https://github.com/hesamsheikh/awesome-openclaw-usecases  
**Ingested commit**: `659895e58e2105c6db8fbef39f446c8a786a480c`  
**Content location**: `apps/web/src/features/marketplace/agents/awesome-openclaw/`  
**Files ingested**: 42 usecase `.md` files → 110 agent catalog entries (42 per-usecase operators + 68 named role/phase agents)

Each generated `AgentCatalogEntry` stores the full, verbatim usecase body in its
`identityTemplate` field (zero-loss ingestion). Source URL on each entry points
back to the exact file at the pinned commit.

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

---

## Clawboo builtin agents

**Source**: `apps/web/src/features/marketplace/templates/builtin/{dev,marketing,research,student,youtube}.ts`  
**Content location**: `apps/web/src/features/marketplace/agents/clawboo/builtin.ts`  
**Entries**: 15 (5 hand-authored TeamTemplates × 3 agents each)

These are first-party Clawboo content — no external attribution required. The
`clawboo/builtin.ts` file is hand-written (not codegen'd by the ingest script)
because the source is local TypeScript with path-alias imports. Legacy template
files remain in place until Session 3 migrates consumers and deletes them
atomically.

---
