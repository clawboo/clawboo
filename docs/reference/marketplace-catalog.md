---
title: 'Marketplace catalog reference'
sidebarTitle: 'Marketplace catalog'
description: 'What the marketplace catalog contains, where Clawboo gets it and how often, all 19 packs with their licenses, and the pack format.'
keywords:
  [
    'catalog',
    'packs',
    'pack format',
    'pack.schema.json',
    'CLAWBOO_CATALOG_INDEX_URL',
    'templates',
    'pinned commit',
  ]
---

The marketplace catalog is the set of ready-made teams, agents and skills behind the **Marketplace**. This page lists what it contains, where Clawboo gets it and how often, the packs it is made of, and the pack format for anyone who wants to read or write a pack. To browse and deploy, see [Browse and deploy from the Marketplace](/using/marketplace).

## At a glance

| Item             | Value                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Packs            | 19: two written for Clawboo, and 17 adapted from open-source repositories (16 MIT, 1 Apache-2.0)         |
| Teams            | 85 in the full catalog; 5 when only the built-in pack is available                                       |
| Agents           | 436 in the full catalog; 15 when only the built-in pack is available                                     |
| Skills           | 44 built into Clawboo, listed on the **Skills** tab; 7 packs declare 45 more that their agents reference |
| Comes from       | The Clawboo repository on GitHub, downloaded by your Clawboo server                                      |
| Refreshed        | At most every 6 hours                                                                                    |
| Offline fallback | The built-in pack, compiled into Clawboo                                                                 |
| Format           | Pack schema version 1, published as JSON Schema in `catalog/schema/`                                     |

The counts describe the catalog, not your fleet, and they grow as packs are added. The **Teams** and **Agents** tab counts in the Marketplace show what your server has loaded.

## What the catalog contains

- **Pack.** A bundle of agents, teams and skills from one source, usually one open-source repository, with one license and one provenance record (repository, pinned commit, authors).
- **Agent.** One specialist: a card (name, role, emoji, color, description, category, tags and skills) and its texts. `IDENTITY.md` holds its full instructions, `SOUL.md` a shorter persona, and `TOOLS.md` tool notes. The 15 built-in agents also carry an `AGENTS.md`.
- **Team.** A roster of at least two agents, plus routing: for each member, the `AGENTS.md` text that says whom it hands work to. A team can also carry a workflow description.
- **Skill.** A named capability an agent's card lists. The 44 built-in skills appear on the **Skills** tab. A pack may declare its own skills for its agents, but may not redeclare a built-in one.

When you deploy, Clawboo saves an agent's three texts on the new agent and writes its `AGENTS.md` from the team's routing. Only OpenClaw agents follow `IDENTITY.md`; on every other runtime the agent runs on `SOUL.md` plus its personality settings, and `IDENTITY.md` is kept for reference. The per-runtime table is in [What each runtime runs](/using/marketplace#what-each-runtime-runs).

## Where the catalog comes from

The catalog is not part of the npm package. Only the built-in pack ships inside Clawboo; your Clawboo server downloads the rest:

1. The first time the dashboard asks for the catalog, the server downloads the catalog index from the Clawboo repository on GitHub, waiting up to 5 seconds.
2. For each pack the index lists, it reads a copy saved in `~/.clawboo/catalog/`, or downloads one. It checks the pack's SHA-256 digest before reading it and skips a pack that does not match. Saved packs are keyed by their digest, so an unchanged pack is downloaded once.
3. It merges every pack that passed with the built-in pack, which is always included, so the catalog is never empty.
4. It keeps the result in memory for 6 hours. After that, the next request asks GitHub whether the index changed and rebuilds the catalog.

A pack published upstream can therefore take up to 6 hours, or a server restart, to appear. The request carries no account or usage data; it only asks for the published files.

<Note>

The 6-hour hold also applies to a download that failed. If GitHub could not be reached when the catalog was first needed, the Marketplace shows only the built-in pack (5 teams, 15 agents) until the next refresh. Restart the server (`clawboo restart`) to try again sooner.

</Note>

- The index URL is `https://raw.githubusercontent.com/clawboo/clawboo/refs/heads/main/catalog/dist/v1/index.json`. Set `CLAWBOO_CATALOG_INDEX_URL` to serve the same files from a mirror.
- When the server runs from a repository checkout that has `catalog/dist/v1/`, it reads the catalog from those files instead of GitHub.
- An index in a newer format than your Clawboo can read shows only the built-in pack. A single pack it cannot read is left out, and the rest still show.

## Packs

| Pack                           | `id`                                | Entry prefix  | Agents  | Teams  | Skills | License    |
| ------------------------------ | ----------------------------------- | ------------- | ------- | ------ | ------ | ---------- |
| Agency Agents                  | `agency-agents`                     | `agency-`     | 116     | 5      | 0      | MIT        |
| Engineering Agents             | `wshobson-agents`                   | `wshobson-`   | 97      | 24     | 0      | MIT        |
| Clawboo Life and Home          | `clawboo-home`                      | `home-`       | 35      | 10     | 0      | MIT        |
| Growth Marketing               | `coreyhaines-growth-marketing`      | `growth-`     | 26      | 5      | 9      | MIT        |
| Research and Orchestration     | `voltagent-subagents`               | `voltagent-`  | 24      | 5      | 0      | MIT        |
| Business and Compliance Desk   | `alirezarezvani-business-desk`      | `bizdesk-`    | 18      | 4      | 0      | MIT        |
| Clawboo (built-in)             | `clawboo`                           | `clawboo-`    | 15      | 5      | 0      | MIT        |
| Founder Sprint                 | `clawboo-founder-sprint`            | `sprint-`     | 14      | 4      | 0      | MIT        |
| Creator and Founder Operations | `craighewitt-creator-ops`           | `creatorops-` | 14      | 4      | 0      | MIT        |
| Generative Media Production    | `calesthio-generative-media`        | `genmedia-`   | 12      | 4      | 9      | MIT        |
| Creator Studio                 | `charliehills-creator-studio`       | `creatorkit-` | 12      | 3      | 0      | MIT        |
| Engineering Craft              | `mattpocock-craft`                  | `craft-`      | 12      | 3      | 7      | MIT        |
| Product Craft                  | `phuryn-product-craft`              | `pmcraft-`    | 12      | 3      | 0      | MIT        |
| Content Repurposing            | `agricidaniel-repurpose`            | `repurpose-`  | 8       | 2      | 0      | MIT        |
| Ads and Analytics              | `google-ads-analytics`              | `adsapi-`     | 7       | 1      | 0      | Apache-2.0 |
| Lifecycle Commerce             | `thatrebeccarae-lifecycle-commerce` | `lifecycle-`  | 6       | 2      | 7      | MIT        |
| Storefront Catalog Ops         | `kgelster-storefront-catalog`       | `shopcat-`    | 5       | 1      | 6      | MIT        |
| Image and Shot Direction       | `blackforestlabs-visual-direction`  | `visdir-`     | 2       | 0      | 4      | MIT        |
| Presenter Video Studio         | `heygen-presenter-video`            | `presenter-`  | 1       | 0      | 3      | MIT        |
| **Total**                      |                                     |               | **436** | **85** | **45** |            |

The pack names are the pack filters in the Marketplace. Every agent and team id is the pack's prefix plus a slug, for example `agency-engineering-frontend-developer`, and is unique across the catalog. Every pack is at content version `1.0.0`.

### Sources

Clawboo Life and Home and the built-in pack are written for Clawboo. The other 17 are adapted from these repositories, each pinned to the commit it was taken from:

| Pack                           | Upstream repository                                  | Pinned commit                              |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------ |
| Agency Agents                  | `github.com/msitarzewski/agency-agents`              | `64eee9f8e04f69b04e78e150d771a443c64720be` |
| Engineering Agents             | `github.com/wshobson/agents`                         | `d82998e7df393c671ede2387a8435075f0b633f5` |
| Growth Marketing               | `github.com/coreyhaines31/marketingskills`           | `b1aaa3619e747f4a836c61e03084c4a531de1262` |
| Research and Orchestration     | `github.com/VoltAgent/awesome-claude-code-subagents` | `c9e51ec0b3d43f5dcdd0b558a6cd28ba6ada97c1` |
| Business and Compliance Desk   | `github.com/alirezarezvani/claude-skills`            | `19392f7a08264ed00486a251f5b2098321771f94` |
| Founder Sprint                 | `github.com/garrytan/gstack`                         | `394db326f2d3aaccd4804fe846b82aaa7d189dee` |
| Creator and Founder Operations | `github.com/TheCraigHewitt/skills`                   | `fdbf39b61fbc8cb7cea67949bfb5e8fc567bbc51` |
| Generative Media Production    | `github.com/calesthio/generative-media-skills`       | `8c85352d5d75d4dcbe58480bd138e37b9742bab1` |
| Creator Studio                 | `github.com/charlie947/social-media-skills`          | `d2e948719eafc8ed9e2436357ad18489bb371a81` |
| Engineering Craft              | `github.com/mattpocock/skills`                       | `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76` |
| Product Craft                  | `github.com/phuryn/pm-skills`                        | `18468a95b427e70e258b51389796367c6f684e7d` |
| Content Repurposing            | `github.com/AgriciDaniel/claude-repurpose`           | `669187e2b69ef3c854d149657b7fb2483263dab4` |
| Ads and Analytics              | `github.com/google/skills`                           | `0dad3f947e45a736060e524bbefa3eab692809f9` |
| Lifecycle Commerce             | `github.com/thatrebeccarae/claude-marketing`         | `a8a63ec1341f05ec9c1e9cb52b4edeb14e3bdcba` |
| Storefront Catalog Ops         | `github.com/kgelster/awesome-ecom-skills`            | `0b6f9e51b4a14b030ab52a2f1ff8a320bdc50070` |
| Image and Shot Direction       | `github.com/black-forest-labs/skills`                | `8907d515b0ac270a988ec7a239add81ee13d6cba` |
| Presenter Video Studio         | `github.com/heygen-com/skills`                       | `1bd5e4d33a028dfed3abf504c5e3dd644fb9ea8a` |

Every pack ships a `NOTICE.md`, and attribution is collected in `THIRD_PARTY_NOTICES.md` (see [License and notices](/appendices/license-and-notices)). The 140 entries from Agency Agents (116) and Research and Orchestration (24) also link to the exact upstream file they came from (`origin.url`); the other packs record provenance once, at pack level. A pin records where content came from; nothing fetches the upstream repositories again. The 17 packs are marked `adaptation: "adapted"`, and their bodies have the upstream YAML frontmatter removed.

## Pack format

A pack is a folder of JSON files. The public specification is JSON Schema 2020-12 in the repository: `catalog/schema/pack.schema.json` describes a pack, and `catalog/schema/index.schema.json` the browse index. You can write a pack against those two files without installing anything. Inside the repository, `packages/pack-format` holds the same format in TypeScript.

```text
catalog/packs/<publisher>/<slug>/
  pack.json            the manifest, plus the agent, team and skill listings
  agents/<slug>.json   one agent's texts
  teams/<slug>.json    one team's routing and workflow
  NOTICE.md            required when provenance.repo is set
```

### The manifest

```ts
interface PackManifest {
  schemaVersion: 1 // first key; an integer
  id: string // the pack id, for example 'agency-agents'
  idPrefix?: string // entry-id prefix; defaults to id
  name: string
  description: string
  version: string // exact semver of the content; ranges such as '^1.2.3' are rejected
  provenance: Provenance
  counts: { agents: number; teams: number; skills: number }
  newCategories?: string[] // categories this pack introduces
  renames?: Record<string, string | null> // former entry id -> current id, or null if removed
}
```

- `provenance` is recorded once per pack: `sourceId`, `label`, `color` (`#RRGGBB`), `repo`, `ref` (the pinned commit), `license` (an SPDX id), `authors`, `adaptation` (`verbatim`, `adapted` or `original`) and `importedAt` (an ISO time). An entry from a different upstream can override it with an `origin` block (`url`, `adaptation`, `authors`).
- `renames` is entry bookkeeping, not a schema migration. The built-in pack maps its five old team ids, such as `dev`, to the current ones, such as `clawboo-dev`.
- `category` values are open: 19 are known (for example `engineering`, `marketing`, `research`, `support`), and a pack that uses another must list it in `newCategories`.

### Listings and bodies

A listing is what a card shows; a body is what the detail view and a deploy need. They are separate files because the agent texts are most of the bytes and no card reads them.

```ts
interface AgentListing {
  id: string // `${idPrefix}-${slug}`, flat kebab-case, unique across the catalog
  packId: string
  slug: string
  name: string
  role: string
  emoji: string
  color: string // #RRGGBB
  description: string
  category: string
  tags: string[]
  skillIds: string[] // built-in skills or this pack's own
  body: string // relative path to the agent's body file
  origin?: { url?: string; adaptation?: string; authors?: string[] }
  suggestedRuntime?: string
}

interface TeamListing {
  id: string
  packId: string
  slug: string
  name: string
  emoji: string
  color: string
  description: string
  category: string
  tags: string[]
  members: { agentId: string; name: string; role: string }[] // so a card needs no body fetch
  body: string
  origin?: { url?: string; adaptation?: string; authors?: string[] }
  defaultRuntime?: string
}

interface AgentBody {
  id: string
  files: Record<string, string> // must include non-empty SOUL.md and IDENTITY.md
}

interface TeamBody {
  id: string
  workflowNarrative?: string
  routing?: Record<string, string> // each member's AGENTS.md text, keyed by agent id
}

interface PackSkill {
  id: string
  name: string
  description: string
  category: 'code' | 'web' | 'data' | 'comm' | 'file' | 'other'
  tags: string[]
}
```

- `files` is a map, so a pack can carry another agent file without a format change.
- At deploy, Clawboo writes `SOUL.md` with the default personality added, `IDENTITY.md` with the agent's final name (a number is added when the name is taken), `TOOLS.md`, an `AGENTS.md` built from the team's routing and Clawboo's team instructions, and a `CLAWBOO.md` help file.
- `suggestedRuntime` and `defaultRuntime` are optional hints the team dialog uses to preselect a runtime. No pack sets them.

### Versions

`schemaVersion` is required, must be an integer, and is never assumed. Version 1 is the only one, so this Clawboo reads exactly version 1. A pack that fails is rejected on its own, and the rest of the catalog still loads.

| Rejection                           | Cause                                                           |
| ----------------------------------- | --------------------------------------------------------------- |
| `missing-schema-version`            | No `schemaVersion`                                              |
| `schema-version-not-an-integer`     | A value such as `"1"` or `1.0.0`                                |
| `schema-version-too-new`            | Newer than this Clawboo reads; upgrade Clawboo                  |
| `schema-version-too-old`            | Older than this Clawboo reads; republish the pack               |
| `invalid-at-declared-version`       | The pack does not validate against its own version              |
| `upgrade-produced-invalid-document` | Upgrading the pack to the current version produced invalid data |

## Catalog routes

The dashboard reads the catalog from its own server:

| Route                         | Returns                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/catalog/index`      | `{ schemaVersion, counts, agents, teams, packs }`: browse rows for the built-in pack and every pack that verified |
| `GET /api/catalog/agents/:id` | `{ id, files, sourceUrl? }`, or 404 `{ "error": "Unknown catalog agent" }`                                        |
| `GET /api/catalog/teams/:id`  | `{ id, workflowNarrative?, routing?, sourceUrl? }`, or 404 `{ "error": "Unknown catalog team" }`                  |

`sourceUrl` is the entry's `origin.url`, when it has one. Full shapes and examples are in the [Catalog API](/reference/rest-api/catalog).

## For contributors

<AccordionGroup>

<Accordion title="Repository layout">

```text
catalog/
  catalog.config.json      which packs exist, and which one is the built-in seed
  schema/                  pack.schema.json and index.schema.json (the public spec)
  packs/<publisher>/<slug>/
  dist/v1/index.json       generated and committed: the browse index
  dist/v1/packs/<publisher>/<slug>/<version>.json   generated and committed: one bundle per pack
```

`catalog/` is not a pnpm workspace member and is in no turbo task: a pack is content, not code. `catalog/dist/` is committed, which is what lets the default index URL (a raw GitHub URL on `main`) serve the catalog with no deploy step.

</Accordion>

<Accordion title="Add or change a pack">

Edit the files under `catalog/packs/<publisher>/<slug>/`, then run:

```bash
pnpm catalog:build
pnpm catalog:verify
```

`catalog:build` regenerates `catalog/dist/` and the compiled built-in pack. `catalog:verify` runs every content rule, then checks that `catalog/dist/` and the compiled built-in pack are byte-for-byte what a rebuild would write. Commit the regenerated files with your change.

</Accordion>

<Accordion title="What catalog:verify checks">

- The pack validates against the schema (strictly, with stale versions treated as errors), and every listing's body file exists and validates. A body file no listing points to is an error.
- A pack with `provenance.repo` ships a non-empty `NOTICE.md`.
- Every `skillIds` entry resolves to a built-in skill or one of the pack's own, and a pack does not redeclare a built-in skill.
- A category the dashboard has no label for is listed in `newCategories`, and `newCategories` lists only new, used categories.
- No two packs emit the same id prefix, and no two packs claim the same id.
- Descriptions are at least 20 characters and do not end in `...`. An `IDENTITY.md` does not open with YAML frontmatter (`---`) and is at most 50,000 characters. No entry repeats a tag.
- A team has at least two members, routes only to its members, and has routing for every member.
- No string names a competing registry, installer or chat invite.
- No text trips the prompt-injection scan, except findings reviewed in `scripts/catalog/injection-allowlist.ts`.

`node scripts/catalog/budget.mjs` separately keeps the compiled built-in pack under 128 KB and the index under 512 KB.

</Accordion>

<Accordion title="Digests and canonical bytes">

Each pack row in `index.json` names one bundle by version and carries `integrity`, a `sha256-<base64>` digest of the bundle's exact bytes. The server recomputes the digest and compares it before parsing the bundle, so bytes that do not match are never parsed.

Bundles and the index are written as canonical bytes: object keys sorted recursively, no insignificant whitespace, LF line endings and no trailing newline. Those exact bytes are written, served and hashed, which is why Prettier never touches `catalog/dist/` (its `**/dist/` ignore entry). Pack sources under `catalog/packs/` are ordinary Prettier-formatted JSON.

</Accordion>

<Accordion title="The built-in pack">

The built-in pack (`catalog/packs/clawboo/builtin`) is compiled into Clawboo, because first-run onboarding offers no start-from-scratch path and needs teams to pick from. `pnpm catalog:build` generates it into two files, one per build target, and `catalog:verify` fails if either drifts from the pack:

| Generated file                            | Used by       |
| ----------------------------------------- | ------------- |
| `apps/web/src/features/marketplace/seed/` | The dashboard |
| `apps/web/server/lib/catalogSeed.ts`      | The server    |

Never edit them by hand.

</Accordion>

<Accordion title="CI for content pull requests">

A pull request that changes only `catalog/` skips the full CI matrix and runs `.github/workflows/catalog-ci.yml`: the content rules, the injection scan and the size budgets, offline. A change under `catalog/packs/clawboo/` gets the full matrix, because that folder holds the built-in pack, which ships inside Clawboo.

Never make `catalog-ci.yml` a required check. It is path-filtered, so it never reports on other pull requests, and GitHub would keep them waiting. The `catalog-verify` job in `ci.yml` runs the same checks on every code pull request; require that one. Publishing a release runs `pnpm catalog:verify` too.

</Accordion>

</AccordionGroup>

## Related

- [Browse and deploy from the Marketplace](/using/marketplace): search, details, deploy, and what each runtime runs.
- [Catalog API](/reference/rest-api/catalog): the three catalog routes in full.
- [License and notices](/appendices/license-and-notices): licenses and attribution for the adapted packs.
- [Agents](/using/agents): the agent files a deployed agent gets, per runtime.
- [Configuration](/reference/configuration): `~/.clawboo/catalog/` and the other files Clawboo keeps.
