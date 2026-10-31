---
title: 'Catalog API'
sidebarTitle: 'Catalog'
description: 'REST reference for the marketplace catalog the dashboard browses: the index of agent and team templates, and the files behind each entry.'
keywords: ['misc', 'catalog', 'marketplace', 'packs', 'templates', 'CLAWBOO_CATALOG_INDEX_URL']
---

The agent and team templates the **Marketplace** browses, served as an index plus one document set per entry. Use this page when you build a catalog view of your own or check what a template deploys. These routes read files, not the database, and they never return an empty catalog.

Examples use the default port `18790` and no access token. With `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each `curl`. All three routes are on the general rate limit described in the [REST API overview](/reference/rest-api/index).

## Routes

| Method | Path                      | Summary                                    |
| ------ | ------------------------- | ------------------------------------------ |
| GET    | `/api/catalog/index`      | Browse rows for every agent, team and pack |
| GET    | `/api/catalog/agents/:id` | One agent template's files                 |
| GET    | `/api/catalog/teams/:id`  | One team template's workflow and routing   |

## Where the catalog comes from

The server merges a built-in pack with the packs it can fetch:

1. **The built-in pack** (15 agents, 5 teams) is compiled into the server and always included, so first-run onboarding works offline.
2. **The other packs** come from the first source that exists: a local `catalog/dist/v1/` folder (a repo checkout), then the URL in `CLAWBOO_CATALOG_INDEX_URL`, then `catalog/dist/v1/index.json` on the `main` branch of the `clawboo/clawboo` repository on GitHub.

Each pack's bytes are checked against the `sha256` digest the index lists before they are parsed, and a pack that fails the check is skipped. A pack this build cannot read is dropped, and an index newer than this build understands (`schemaVersion` above 1) is ignored. Fetched packs are cached on disk under `<clawboo home>/catalog/` and checked again each time they are read.

The merged result is cached in memory for 6 hours. If the remote cannot be reached, the index holds only the built-in pack, and that result is cached for 6 hours too; restart the server to try again sooner. For the pack format and how content is published, see the [Marketplace catalog reference](/reference/marketplace-catalog).

## `GET /api/catalog/index`

Browse rows only: names, descriptions and tags, never an agent's files.

### Responses

**`200 OK`**:

```ts
{
  schemaVersion: number
  counts: {
    agents: number
    teams: number
  }
  agents: Array<{
    id: string
    packId: string
    source: string
    name: string
    role: string
    emoji: string
    color: string
    description: string
    category: string
    tags: string[]
    skillIds: string[]
    suggestedRuntime?: string
  }>
  teams: Array<{
    id: string
    packId: string
    source: string
    name: string
    emoji: string
    color: string
    description: string
    category: string
    tags: string[]
    agentIds: string[]
    defaultRuntime?: string
  }>
  packs: Array<{
    publisher: string
    slug: string
    id: string
    version: string
    offline?: true // only on the compiled-in built-in pack
  }>
}
```

A fetched copy of the built-in pack, once verified, replaces the compiled-in row, so `offline: true` means the server is using the copy it shipped with.

### Example

```bash
curl http://localhost:18790/api/catalog/index
```

A shortened response:

```json
{
  "schemaVersion": 1,
  "counts": { "agents": 436, "teams": 85 },
  "agents": [
    {
      "id": "clawboo-dev-code-reviewer-boo",
      "packId": "clawboo",
      "source": "clawboo",
      "name": "Code Reviewer Boo",
      "role": "Code Reviewer",
      "emoji": "👾",
      "color": "#34D399",
      "description": "Code Reviewer on the Dev Team.",
      "category": "engineering",
      "tags": ["clawboo", "dev", "code review"],
      "skillIds": ["code-search"]
    }
  ],
  "teams": [
    {
      "id": "clawboo-dev",
      "packId": "clawboo",
      "source": "clawboo",
      "name": "Dev Team",
      "emoji": "👾",
      "color": "#34D399",
      "description": "Code review, bug hunting, and documentation.",
      "category": "engineering",
      "tags": ["code review", "debugging"],
      "agentIds": ["clawboo-dev-code-reviewer-boo", "clawboo-dev-bug-fixer-boo"]
    }
  ],
  "packs": [
    { "publisher": "clawboo", "slug": "builtin", "id": "clawboo", "version": "1.0.0" },
    { "publisher": "agency", "slug": "agents", "id": "agency-agents", "version": "1.0.0" }
  ]
}
```

## `GET /api/catalog/agents/:id`

One agent template's files, keyed by file name.

### Responses

**`200 OK`**:

```ts
{
  id: string
  files: Record<string, string> // SOUL.md, IDENTITY.md and TOOLS.md; AGENTS.md when the entry has its own routing
  sourceUrl?: string // link to the upstream source, when the entry has one
}
```

A team deploy from the dashboard does not pass this map through as it stands. It renames the agent in `IDENTITY.md` and `SOUL.md`, adds the personality section to `SOUL.md`, and builds `AGENTS.md` and `CLAWBOO.md` from the team, using the entry's own `AGENTS.md` routing as input.

**`404 Not Found`**:

```json
{ "error": "Unknown catalog agent" }
```

### Example

```bash
curl http://localhost:18790/api/catalog/agents/clawboo-dev-code-reviewer-boo
```

## `GET /api/catalog/teams/:id`

One team template's workflow narrative and per-member routing.

### Responses

**`200 OK`**:

```ts
{
  id: string
  workflowNarrative?: string
  routing?: Record<string, string> // agent id -> that member's AGENTS.md routing text
  sourceUrl?: string
}
```

**`404 Not Found`**:

```json
{ "error": "Unknown catalog team" }
```

### Example

```bash
curl http://localhost:18790/api/catalog/teams/clawboo-dev
```

**Source of truth:** `apps/web/server/api/catalog.ts` and `apps/web/server/lib/catalogIndex.ts`; the built-in pack is `apps/web/server/lib/catalogSeed.ts`, generated from `catalog/packs/clawboo/builtin`.

## Related

- [Browse and deploy from the Marketplace](/using/marketplace): the dashboard view over these routes
- [Marketplace catalog reference](/reference/marketplace-catalog): the pack format, publishing and integrity checks
- [Agents API](/reference/rest-api/agents): `POST /api/agents`, the route a deploy creates each agent through
- [Agent settings API](/reference/rest-api/agent-settings): installing a skill on an agent
