# Third-Party Notices

Clawboo is MIT licensed (see [LICENSE](./LICENSE)). It bundles and builds on open-source
software. This file lists the notable third-party code and content it uses, and the
licenses verified for each.

---

## Bundled dependencies

Code from these packages ships inside the published `clawboo` npm package. Most are
bundled (inlined) at build time into the server bundle (`dist/server.js`) and the
dashboard UI (`dist/ui/`), so they do **not** appear as separate entries in the
installed package's `node_modules`. A few (`better-sqlite3`, `ws`, `pino`) are declared
runtime dependencies and are installed normally, carrying their own license texts in
`node_modules`. For the inlined packages, the copyright and license notices are
aggregated in this file, which ships in the package (`dist/THIRD_PARTY_NOTICES.md`).

| Package                     | License    |
| --------------------------- | ---------- |
| `@anthropic-ai/sdk`         | MIT        |
| `openai`                    | Apache-2.0 |
| `@modelcontextprotocol/sdk` | MIT        |
| `croner`                    | MIT        |
| `express`, `cors`           | MIT        |
| `@noble/ed25519`            | MIT        |
| `better-sqlite3`            | MIT        |
| `drizzle-orm`               | Apache-2.0 |
| `zod`                       | MIT        |
| `react`, `react-dom`        | MIT        |
| `@xyflow/react`             | MIT        |
| `elkjs`                     | EPL-2.0    |
| `framer-motion`             | MIT        |
| `zustand`                   | MIT        |
| `codemirror`                | MIT        |
| `@dnd-kit/core`             | MIT        |
| `@radix-ui/react-slider`    | MIT        |
| `react-resizable-panels`    | MIT        |
| `recharts`                  | MIT        |
| `react-markdown`            | MIT        |
| `remark-gfm`                | MIT        |
| `culori`                    | MIT        |
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
**Pinned commit**: `64eee9f8e04f69b04e78e150d771a443c64720be`
**Content location**: `catalog/packs/agency/agents/` (see that pack's own `NOTICE.md`)
**Files adapted**: 116 agent entries across 13 domain folders, plus 5 workflow team templates
**License verified**: MIT, confirmed at the pinned commit on 2026-07-28 (GitHub license API, `spdx_id: MIT`). Because the import was commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: entries were pruned, renamed, re-described, and re-formatted by the Clawboo maintainers. Bodies are adapted, not verbatim.

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

### obra/superpowers

**Source**: https://github.com/obra/superpowers
**Pinned commit**: `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`
**Content location**: the 14 playbook entries in `BUILTIN_SKILLS`
(`apps/web/src/features/marketplace/catalog.ts`)
**Files adapted**: 14 `SKILL.md` process documents
**License verified**: MIT, confirmed at the pinned commit (the repository's own `LICENSE` file). Because the import was commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: only the process each document teaches was carried across, as a
one-line skill annotation with a Clawboo id, name, category and tags. No upstream
prose, structure, or example ships in Clawboo.

MIT License

Copyright (c) 2025 Jesse Vincent

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

### VoltAgent subagent collection

**Source**: https://github.com/VoltAgent/awesome-claude-code-subagents
**Pinned commit**: `c9e51ec0b3d43f5dcdd0b558a6cd28ba6ada97c1`
**Content location**: `catalog/packs/voltagent/subagents/` (see that pack's own `NOTICE.md`)
**Files adapted**: 24 agent definitions from the research and analysis, meta-orchestration, and business and product categories, regrouped into 5 team templates
**License verified**: MIT, confirmed at the pinned commit (the repository's own `LICENSE` file). Because the import was commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.
**Verbatim-overlap check**: each adapted file was compared against `contains-studio/agents` (no LICENSE, all rights reserved) and `wshobson/agents` using normalised word 8-gram overlap plus a longest common contiguous run. Maximum overlap was 0.0 and the longest shared run was 0 words against both, so there is no evidence that the upstream aggregated unlicensed material into these files.

**Modifications**: entries were reselected, renamed, re-described, and rewritten by the Clawboo maintainers. The upstream bodies are bullet-list role sheets with YAML frontmatter; the bodies here are new prose in Clawboo's soul, identity and tools shape, with upstream tool names, product references and cross-agent plumbing removed. The team templates are original. Bodies are adapted, not verbatim.

MIT License

Copyright (c) 2025 VoltAgent

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

### wshobson/agents

**Source**: https://github.com/wshobson/agents
**Pinned commit**: `d82998e7df393c671ede2387a8435075f0b633f5`
**Content location**: `catalog/packs/wshobson/agents/` (see that pack's own `NOTICE.md`)
**Files adapted**: 97 of 110 upstream agent definitions, plus 24 upstream plugin bundles reworked into team templates
**License verified**: MIT, confirmed at the pinned commit (the repository's own `LICENSE` file). Because the import was commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: 13 upstream files were dropped and the remaining 97 were rewritten
into the Clawboo `SOUL.md` / `IDENTITY.md` / `TOOLS.md` document set. Frontmatter was
replaced with structured catalog fields, every description was rewritten, marketing
superlatives and upstream tool branding were removed, fenced shell and code samples and
report templates were dropped, and the very long source files were cut down editorially.
The team rosters were adapted and trimmed, and the leader choice, the workflow narrative
and every routing edge were written by the Clawboo maintainers. Skill assignments,
categories, tags, colours and emoji are Clawboo's. Bodies are adapted, not verbatim.

MIT License

Copyright (c) 2024 Seth Hobson

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

### coreyhaines31/marketingskills

**Source**: https://github.com/coreyhaines31/marketingskills
**Pinned commit**: `b1aaa3619e747f4a836c61e03084c4a531de1262`
**Content location**: `catalog/packs/coreyhaines/growth-marketing/` (see that pack's own `NOTICE.md`)
**Adapted content**: 26 agent entries, 5 team templates, and 9 pack skills
**What was taken**: the demand-side and revenue-side units the catalog had no coverage for; the units duplicating its existing search, paid-media, social-channel and content-writing agents were dropped
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo `SOUL.md` / `IDENTITY.md` / `TOOLS.md`
document set rather than copied. Upstream frontmatter was replaced with structured catalog
fields and every description was rewritten. The upstream helper scripts were not imported at
all: a Clawboo pack carries markdown and JSON only. Team rosters, leader choices, workflow
narratives, routing edges, pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Corey Haines does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2025 Corey Haines

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

### garrytan/gstack

**Source**: https://github.com/garrytan/gstack
**Pinned commit**: `394db326f2d3aaccd4804fe846b82aaa7d189dee`
**Content location**: `catalog/packs/clawboo/founder-sprint/` (see that pack's own `NOTICE.md`)
**Adapted content**: 14 agent entries, 4 team templates
**What was taken**: nothing. No upstream file was copied, quoted at length, or used as a starting point; only the role structure and the handoff order were adapted, and every word of the pack was written by Clawboo
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: The upstream project is a command-line toolchain: at the pinned commit, 1,171 of its 1,444
files are code, and its markdown is generated from templates that invoke upstream binaries and
local state paths Clawboo does not ship. None of that is present here. What was adapted is the
idea layer: that one person can run a whole product sprint by moving through a fixed chain of
roles, and the order in which those roles hand work to each other. That chain became fourteen
agent personas and four teams, all written from scratch. The rubrics, the severity scale, the
weakness classes, the exclusion list and every routing edge are Clawboo's own wording. The
tool-bound capabilities in the upstream project (browser control, image generation, device
bridges, document rendering, telemetry and deployment detection) were dropped rather than
described. The pack is published under the `clawboo` publisher, is named "Founder Sprint",
and carries no person's name and no upstream product name in its label.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Garry Tan does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Garry Tan

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

### mattpocock/skills

**Source**: https://github.com/mattpocock/skills
**Pinned commit**: `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`
**Content location**: `catalog/packs/mattpocock/engineering-craft/` (see that pack's own `NOTICE.md`)
**Adapted content**: 12 agent entries, 3 team templates, and 7 pack skills
**What was taken**: the craft-of-engineering units around module design, domain vocabulary, written decisions and the thinking-partner slice; units duplicating agents already in the catalog were dropped
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied. Upstream
frontmatter, invocation syntax, install instructions, repository-specific setup, file-path
conventions and links were dropped. Team rosters, leader choices, workflow narratives, routing
edges, pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Matt Pocock does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Matt Pocock

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

### alirezarezvani/claude-skills

**Source**: https://github.com/alirezarezvani/claude-skills
**Pinned commit**: `19392f7a08264ed00486a251f5b2098321771f94`
**Content location**: `catalog/packs/alirezarezvani/business-desk/` (see that pack's own `NOTICE.md`)
**Adapted content**: 18 agent entries and 4 team templates
**What was taken**: the business slice only, covering legal and regulatory compliance, people operations, commercial and deal operations, finance and business operations; the engineering, marketing, product and research slices were excluded because the catalog already covers them
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied. The upstream carries 846 `SKILL.md` files of which only 449 are unique by content hash; the assistant-specific mirror copies were discarded before any selection was made. The upstream also ships 745 Python helper scripts, and many upstream bodies instruct the reader to execute one. No script ships here, and every instruction that depended on one was rewritten as a prompt-level method. One upstream skill whose files are byte-identical to another vendor's published example material was excluded entirely, as were two skills giving individual investment guidance. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, leader choices, workflow narratives, routing edges, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Alireza Rezvani does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2025 Alireza Rezvani

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

### phuryn/pm-skills

**Source**: https://github.com/phuryn/pm-skills
**Pinned commit**: `18468a95b427e70e258b51389796367c6f684e7d`
**Content location**: `catalog/packs/phuryn/product-craft/` (see that pack's own `NOTICE.md`)
**Adapted content**: 12 agent entries and 3 team templates
**What was taken**: the product-management craft the catalog does not already ship: discovery interviews and their synthesis, opportunity mapping, assumption testing, requirement authoring, story slicing, prioritisation facilitation, pre-mortems, metric definition, experiment readouts, goal coaching and stakeholder communication; 56 of the 68 upstream units were left behind
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied; the upstream documents are thin, around three and a half kilobytes at the median, and none was converted one for one. The 158 links to the upstream author's paid newsletter and video courses, which appear across 56 of the 68 documents, were all removed. Named third-party products, upstream file paths, plugin and installation instructions and prompt-argument placeholders were removed as well. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, leader choices, workflow narratives, routing edges, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Pawel Huryn does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Pawel Huryn

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

### google/skills

**Source**: https://github.com/google/skills
**Pinned commit**: `0dad3f947e45a736060e524bbefa3eab692809f9`
**Content location**: `catalog/packs/google/ads-and-analytics/` (see that pack's own `NOTICE.md`)
**Adapted content**: 7 agent entries and 1 team template
**What was taken**: the advertising slice (13 documents), the analytics slice (2 documents) and the developer-practice slice (2 documents) only; the 111 cloud-infrastructure documents were not imported
**License verified**: Apache License, Version 2.0 — NOT MIT — read from the repository's own `LICENSE` file at the pinned commit and confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Attribution notice** (required by section 4 of the Apache License, Version 2.0): this product includes material adapted from the `google/skills` repository, https://github.com/google/skills, at commit `0dad3f947e45a736060e524bbefa3eab692809f9`, licensed under the Apache License, Version 2.0.

**On the copyright line**: the upstream `LICENSE` ships the Apache-2.0 appendix with its bracketed placeholders left unfilled. At the pinned commit the appendix reads `Copyright [yyyy] [name of copyright owner]`, the repository carries no separate `NOTICE` file, and there is no filled copyright statement anywhere in it. No copyright line has been invented here. Attribution is therefore made to Google LLC as the owner of the `google` GitHub organisation that publishes the repository, which is the only attribution the upstream material itself supports.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied; no upstream file is reproduced. Product names, console commands, package names, library version numbers, endpoint paths, code samples, reference-file paths and documentation links were removed, so the agents describe the engineering practice rather than mirroring documentation that changes on its own schedule. The two developer-practice documents were folded into the other agents rather than becoming agents themselves. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. The team roster, leader choice, workflow narrative, routing edges, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under the Apache License, Version 2.0. Google LLC does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights, and none are claimed.

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### TheCraigHewitt/skills

**Source**: https://github.com/TheCraigHewitt/skills
**Pinned commit**: `fdbf39b61fbc8cb7cea67949bfb5e8fc567bbc51`
**Content location**: `catalog/packs/craighewitt/creator-founder-ops/` (see that pack's own `NOTICE.md`)
**Adapted content**: 14 agent entries and 4 team templates
**What was taken**: the 62 documents in the video, sales, company-running and office-work folders; the coding folder was skipped because the catalog already covers that ground several times over, and the general folder because it is about handing work between assistants rather than about running a business
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied, and 62 upstream documents were consolidated into 14 agents, so no agent transcribes any single upstream file. Two shell scripts, a Python file, two JavaScript modules, a stylesheet and 17 evaluation fixtures were left behind, because a Clawboo pack carries Markdown and JSON only. Named contact-data and prospecting services, a named professional-network sales product, named customer relationship platforms, a named email provider, named payment processors, a named presentation framework, a named third-party sales methodology, the revenue bands attached to a management-stage ladder and all unsourced performance figures were removed rather than restated. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, leader choices, workflow narratives, routing edges, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Craig Hewitt does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Craig Hewitt

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

### calesthio/generative-media-skills

**Source**: https://github.com/calesthio/generative-media-skills
**Pinned commit**: `8c85352d5d75d4dcbe58480bd138e37b9742bab1`
**Content location**: `catalog/packs/calesthio/generative-media/` (see that pack's own `NOTICE.md`)
**Adapted content**: 12 agent entries, 4 team templates, and 9 pack skills
**What was taken**: the 65 vendor-neutral production units only; the 88 provider-reference units were excluded because they are written against specific paid media APIs, and the repository's own evaluation files were excluded as repository tooling
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied, and the 65 source units were merged and re-scoped rather than carried across as files. Provider names, tool branding, bundled scripts, prompt templates and source ledgers were removed, and no executable file ships here. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, leader choices, workflow narratives, routing edges, pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. The upstream project and its contributors do not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 generative-media-skills contributors

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

### AgriciDaniel/claude-repurpose

**Source**: https://github.com/AgriciDaniel/claude-repurpose
**Pinned commit**: `669187e2b69ef3c854d149657b7fb2483263dab4`
**Content location**: `catalog/packs/agricidaniel/repurpose/` (see that pack's own `NOTICE.md`)
**Adapted content**: 8 agent entries and 2 team templates
**What was taken**: the cross-platform repurposing craft carried by the 21 skill documents, the 6 agent definitions and the platform reference material; the Python extraction scripts and packaging files were not imported
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied. Upstream command syntax, flag names, sub-skill file paths, an image-generation extension's branding and a third-party stock-image search recipe were removed. Engagement multipliers the upstream states as fact were dropped or reframed as assumptions to check against an account's own analytics. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, the leader choice, workflow narratives, routing edges, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. The upstream author does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 AgriciDaniel

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

### charlie947/social-media-skills

**Source**: https://github.com/charlie947/social-media-skills
**Pinned commit**: `d2e948719eafc8ed9e2436357ad18489bb371a81`
**Content location**: `catalog/packs/charliehills/creator-studio/` (see that pack's own `NOTICE.md`)
**Adapted content**: 12 agent entries and 3 team templates
**What was taken**: the social and creator craft in the 17 short skill documents, expanded with the reasoning the step-by-step originals leave implicit; the shell validation script and the reference assets were not imported
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied. One upstream skill built entirely around a named individual and their colleagues was removed along with that individual's published engagement benchmarks and the instruction to score a stranger's draft against them. Named third-party paid services, required API-key environment variables, a named commercial data scraper, named image-generation products and a named creator's proprietary planning framework were removed, and the underlying techniques are described generically. Unsourced performance figures were dropped or reframed as assumptions to check against an account's own analytics. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, leader choices, workflow narratives, routing edges, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Charlie Hills does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Charlie Hills

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

### thatrebeccarae/claude-marketing

**Source**: https://github.com/thatrebeccarae/claude-marketing
**Pinned commit**: `a8a63ec1341f05ec9c1e9cb52b4edeb14e3bdcba`
**Content location**: `catalog/packs/thatrebeccarae/lifecycle-commerce/` (see that pack's own `NOTICE.md`)
**Adapted content**: 6 agent entries, 2 team templates, and 7 pack skills
**What was taken**: the net-new commerce and lifecycle slice only; 48 of the 55 upstream skill directories were left behind because the engineering, general marketing, copywriting, search and paid-channel units land in cells the catalog already ships agents for
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied, and the six agents' scopes do not match the upstream directory boundaries. Installation instructions, repository clone commands, connector and server registration steps, Python helper scripts and their invocation examples, third-party application stack recommendations, a named platform-versus-platform comparison table and every product link were removed rather than reworded; no upstream Python, shell or configuration file ships here. Vendor-specific tool inventories and API guidance were replaced with vendor-neutral method. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Team rosters, leader choices, workflow narratives, routing edges, pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Rebecca Rae Barton does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Rebecca Rae Barton

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

### kgelster/awesome-ecom-skills

**Source**: https://github.com/kgelster/awesome-ecom-skills
**Pinned commit**: `0b6f9e51b4a14b030ab52a2f1ff8a320bdc50070`
**Content location**: `catalog/packs/kgelster/storefront-catalog/` (see that pack's own `NOTICE.md`)
**Adapted content**: 5 agent entries, 1 team template, and 6 pack skills
**What was taken**: seven of the nine upstream skill directories, reorganised into scopes that do not follow the upstream boundaries; the unit built entirely around a paid third-party bulk-editing application and the landing-page ideation unit were dropped
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied. Every reference to the paid bulk-editing application was removed rather than reworded and no link to it survives. Store authentication instructions, access-token and command-line setup, plugin installation commands, pinned API version numbers, GraphQL query and mutation text and every request or verification snippet were removed; what was kept is the method, written as prose. A named brand used upstream as a worked example is not named here. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. The team roster, leader choice, workflow narrative, routing edges, pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Kurt Elster does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Kurt Elster

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

### black-forest-labs/skills

**Source**: https://github.com/black-forest-labs/skills
**Pinned commit**: `8907d515b0ac270a988ec7a239add81ee13d6cba`
**Content location**: `catalog/packs/blackforestlabs/visual-direction/` (see that pack's own `NOTICE.md`)
**Adapted content**: 2 agent entries and 4 pack skills; this pack ships no team templates, because two agents in one narrow discipline do not make a team
**What was taken**: the vendor-neutral craft the units teach: prompt element ordering, the weight lighting carries, describing positively rather than by exclusion, giving each reference one job, brief triage, the action budget, shot ordering, the continuity contract, keyframe and continuation planning, audio layering, and the rule that exactness belongs in post
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: Every body was re-authored into the Clawboo document set rather than copied. The API integration unit was dropped entirely along with its endpoint list, authentication steps, model pricing table, polling and webhook guidance and code examples. Every model name, product name, model-selection table, request field name, request-mode identifier, parameter and documentation link was removed rather than reworded, so nothing here instructs anyone to use a particular product. A vendor-branded example prompt was not carried across. Upstream frontmatter was replaced with structured catalog fields and every description was rewritten. Pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. Black Forest Labs does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 Black Forest Labs Inc.

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

### heygen-com/skills

**Source**: https://github.com/heygen-com/skills
**Pinned commit**: `1bd5e4d33a028dfed3abf504c5e3dd644fb9ea8a`
**Content location**: `catalog/packs/heygen/presenter-video/` (see that pack's own `NOTICE.md`)
**Adapted content**: 1 agent entry and 3 pack skills; this pack ships no team templates, because one agent is not a team
**What was taken**: the production craft that transfers to any tool: conversational discovery instead of a questionnaire, one idea per video, script structures by video type, writing for the ear, front-loading the hook, pulling exact on-screen text into its own list, deciding aspect ratio before composition, checking caption safe areas per destination, and reviewing translated text before the final render
**License verified**: MIT, read from the repository's own `LICENSE` file at the pinned commit, confirmed again on 2026-09-01 against the blob returned by the GitHub contents API at that commit. Because the reference is commit-pinned, a later upstream relicense does not affect the grant that applied at this commit; re-verify if the pin is ever moved.

**Modifications**: The body was written from scratch into the Clawboo document set rather than copied. Transport and mode detection, authentication and API-key handling, installation commands, command-line and tool-call surfaces, endpoint versions, workspace file conventions and service-specific troubleshooting were dropped rather than reworded, and the avatar-identity unit was not carried across at all because its substance is a file-and-identifier convention for one product. No vendor name, product name, endpoint, command, environment variable, tool name or documentation link from the upstream appears anywhere in this pack, and no upstream shell script ships here. The consent boundary on likeness and voice is Clawboo's addition. Upstream frontmatter was replaced with structured catalog fields and the description was newly written. Pack skills, categories, tags, colours and emoji are Clawboo's.

**No affiliation**: this content is adapted from the named repository under its MIT licence. HeyGen does not endorse, sponsor, or have any affiliation with Clawboo, and the upstream repository is named here solely to identify the source of the adapted material. A licence grants use of the licensed work; it grants no trademark rights and no personality rights, and none are claimed.

MIT License

Copyright (c) 2026 HeyGen

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

### Clawboo life and home teams

The `catalog/packs/clawboo/home/` pack (10 team templates and 35 agent entries) is
first-party Clawboo content, written from an internal concept brief. No external
attribution required.

---

## Acknowledgements

Clawboo integrates with these open-source AI agent runtimes as peer teammates. Each runs
on its own terms and keeps its own native capabilities; Clawboo coordinates them over MCP.

- **OpenClaw**: https://github.com/openclaw/openclaw
- **Hermes** (`hermes-agent`)
- **Claude Code** (Anthropic Claude Agent SDK)
- **Codex** (OpenAI Codex CLI)

Clawboo's architecture and design were informed by prior art in the open-source
agent-orchestration space, among them Paperclip (https://github.com/paperclipai/paperclip)
and vibe-kanban (https://github.com/BloopAI/vibe-kanban). Nous Research's
hermes-paperclip-adapter (https://github.com/NousResearch/hermes-paperclip-adapter, MIT)
was a useful reference for running Hermes Agent as a managed worker. These projects are
credited here as design inspiration.

---

## Additional licenses

### node-cross-spawn

**Source**: https://github.com/moxystudio/node-cross-spawn

The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

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

### OpenClaw and openclaw-studio

**Source**: https://github.com/openclaw/openclaw,
https://github.com/grp06/openclaw-studio

MIT License

Copyright (c) 2026 OpenClaw Foundation
Copyright (c) 2026 George Pickett

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
