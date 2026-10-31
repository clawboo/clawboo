---
title: 'Monorepo and build'
description: 'How the pnpm and Turborepo workspace is wired, the real build order, what the npm package contains, the root commands, and the lint and schema rules.'
keywords: ['turbo', 'turborepo', 'pnpm', 'workspace', 'tsup', 'build order', 'assemble']
---

Clawboo is one pnpm workspace built with Turborepo. Shared libraries live under the `@clawboo/*` scope in `packages/`, and two apps consume them: `apps/web` (the dashboard and its Express server) and `apps/cli` (the `clawboo` command). Use this page when you add a package, change a dependency edge, add a root command, or need to know what ends up in the npm package.

What each package is for, who uses it, and the dependency layers are in the [package overview](/reference/packages/index), which links the deeper package guides. How the parts behave at runtime is on the [contributor overview](/internals/index).

## The workspace

`pnpm-workspace.yaml` declares four globs:

```yaml
packages:
  - 'packages/*'
  - 'packages/adapters/*'
  - 'apps/*'
  - 'docs'
```

The second glob matters. The runtime adapters sit one level deeper, in `packages/adapters/*`, so without it pnpm would not find them and `workspace:*` links to them would fail. `packages/adapters` itself has no `package.json`.

| Part                  | Count | Notes                                                                                                                                                        |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/*`          | 27    | Includes the config-only `@clawboo/tsconfig` (`base.json`, `react.json`, `node.json`), which is a devDependency everywhere and has no code.                  |
| `packages/adapters/*` | 6     | `native`, `openclaw`, `claude-code`, `codex`, `hermes`, and `mock`: a fault-injection runtime that appears only when `CLAWBOO_ENABLE_MOCK_RUNTIME=1` is set. |
| `apps/*`              | 2     | `@clawboo/web` (private) and `clawboo` in `apps/cli` (the one public package).                                                                               |
| `docs`                | 1     | `@clawboo/docs` (private): this Mintlify site, deployed as it is.                                                                                            |

All 33 packages under `packages/` are `private: true`, and so are `@clawboo/web` and `@clawboo/docs`. Apps depend on them through `workspace:` links, so there is no publish-then-install loop: Turbo builds a package's `dist/` and the app that depends on it reads that directly.

### Folders that are not workspace members

`website/` (the Astro marketing site, with its own lockfile) and `catalog/` (the marketplace content) sit outside every glob on purpose.

`catalog/` is JSON content: agent prose, team routing, and the artifacts built from them. As a workspace member, every content pull request would run `turbo lint`, `turbo typecheck` and `turbo test` over files with no code. It has no `package.json` and appears in no Turbo task; `scripts/catalog/*` reach it from the repo root, and `.github/workflows/catalog-ci.yml` is its fast CI path. See [the marketplace catalog reference](/reference/marketplace-catalog).

## Layer boundaries

`apps/web` is two build targets in one package: tsup bundles `server/` for Node, and Vite bundles `src/` for the browser. With the one-way rule between apps and packages, that gives three boundaries. `eslint.config.mjs` enforces all three:

| Rule                                                  | Why                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web/server/**` may not import `apps/web/src/**` | Keeps browser code out of the server bundle.                                                      |
| `apps/web/src/**` may not import `apps/web/server/**` | Server modules pull in `node:*` and native modules that would be dragged into the browser bundle. |
| `packages/**` may not import `apps/**`                | Dependencies flow one way; a package that reached into an app would invert the build graph.       |

Code two layers both need goes into a `@clawboo/*` package instead. `@clawboo/model-catalog` is the example: the model catalog both the SPA and the server read.

The rules match relative paths only, so a bare specifier such as `react-dom/server` is not mistaken for a crossing. The two `apps/web` rules pair `no-restricted-imports` with a `no-restricted-syntax` selector, because `no-restricted-imports` does not see dynamic `import()`. The server rule runs only because `apps/web`'s `lint` script is `eslint src/ server/`; [`importBoundary.test.ts`](/internals/testing) fails if that script stops covering `server/`.

### Other SPA lint rules

The same config holds three more rules for `apps/web/src`. Each one fails lint:

| Rule                                                                  | Use instead                                                                      | Why                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| No capture-phase `keydown` or `keyup` listeners                       | Register the overlay with `useDismissableLayer()`, or listen in the bubble phase | A capture listener runs before the dismiss stack and every React `onKeyDown`, so two overlays act on one Escape.      |
| No root-absolute `/api/...` URL in `fetch()` or `new EventSource()`   | `apiFetch()` and `apiUrl()` from `@clawboo/control-client`                       | Clawboo can be served under a path prefix (`CLAWBOO_BASE_PATH`); a hardcoded root path skips the prefix and 404s.     |
| No root-absolute static asset path in a JSX `src`, `href` or `poster` | A relative path such as `logo.svg`                                               | A relative path resolves against the `<base href>` the server injects, which is right at the root and under a prefix. |

The repo's own `scripts/` folder is linted too: `pnpm lint` ends with `pnpm lint:repo` (`eslint scripts/ --max-warnings 0`).

## The build pipeline

`turbo.json` defines five tasks, and each one depends on the upstream build:

```json
{
  "globalDependencies": ["eslint.config.mjs"],
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true, "dependsOn": ["^build"] },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

- **`^build`** means "build every dependency of this package first". Turbo reads each `package.json`'s `@clawboo/*` edges and sorts them, so nobody maintains the order by hand. `lint`, `typecheck` and `test` depend on it too, so they run against fresh `dist/` output, even on a clean checkout.
- **`outputs: ["dist/**"]`** lets Turbo skip an unchanged package and restore its `dist/` from cache.
- **`globalDependencies`** puts `eslint.config.mjs` into every task's cache key, so an ESLint config change invalidates the whole cache.
- **`dev`** is a long-running watcher: never cached, always persistent.

Each library builds with tsup, which writes CJS, ESM and `.d.ts` files to `dist/`. `apps/web` builds in three steps: `vite build` for the SPA, then one tsup run for the server bundle (`tsup.server.config.ts`) and one for the four MCP stdio bins (`tsup.mcp-bins.config.ts`). `apps/cli` is one tsup run with two entries, `src/index.ts` and `src/bootstrap.ts`.

## Build order

Turbo computes the exact order from the `package.json` graph. The table groups packages by depth: the longest chain of `@clawboo/*` dependencies beneath each one (`tsconfig` left out, since it has no code).

| Depth | Packages                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `agent-registry`, `board-core`, `boo-avatar`, `capability-registry`, `compaction`, `config`, `connector-catalog`, `executor`, `governance`, `logger`, `model-catalog`, `obs`, `pack-format`, `process-lookup`, `protocol`, `scheduler`, `worktrees`                                                                                                                                                                                 |
| 1     | `adapter-claude-code`, `adapter-codex`, `adapter-hermes`, `adapter-mock`, `adapter-native` (each needs `executor`); `control-client` (`agent-registry`); `db` (`board-core`, `compaction`, `governance`, `obs`); `gateway-client` (`logger`); `gateway-proxy` (`config`); `team-orchestration` (`board-core`, `executor`, `governance`); `ui` (`boo-avatar`); the `clawboo` CLI (`config` and `process-lookup`, as devDependencies) |
| 2     | `evals` (`db`, `executor`, `governance`, `obs`); `events` (`gateway-client`, `logger`, `protocol`); `mcp` (`db`)                                                                                                                                                                                                                                                                                                                    |
| 3     | `adapter-openclaw` (`events`, `executor`, `gateway-client`, `logger`, `protocol`)                                                                                                                                                                                                                                                                                                                                                   |
| 4     | `@clawboo/web`                                                                                                                                                                                                                                                                                                                                                                                                                      |

`apps/web` depends directly on 31 workspace packages, all six adapters included. `boo-avatar` reaches it through `ui`, so every package except the config-only `tsconfig` ends up in the app.

`board-core` holds the task state machine that `db`, `team-orchestration` and the board UI all import. `executor` has no runtime dependencies and exports three entry points: `.`, `./contract` and `./tiers`.

## What publishes

`pnpm build` produces a `dist/` for every package, but only `clawboo` (the CLI in `apps/cli`) reaches npm. Every other package is `private: true`, so `pnpm changeset publish` skips it, and `packagePosture.test.ts` fails the build if a second package goes public.

The server's libraries ship inside the CLI as one bundle. `tsup.server.config.ts` marks the whole `@clawboo/*` scope `noExternal`, so `dist/server.js` inlines every workspace library it uses. `scripts/assemble-cli.sh` (run by `pnpm assemble`) then copies the server bundle, the SPA, the four MCP bins and `THIRD_PARTY_NOTICES.md` into `apps/cli/dist/`. It fails if a `marketplace-catalog-*` chunk shows up in the SPA assets: only the small built-in seed may ship, and the full catalog is fetched at runtime.

`apps/cli/package.json` publishes `files: ["dist"]`, so the tarball holds:

| File                                        | What it is                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `dist/bootstrap.js`                         | The `clawboo` bin. It checks the Node version before anything else loads, then loads `index.js`.       |
| `dist/index.js`                             | The CLI itself.                                                                                        |
| `dist/server.js`                            | The Express server with the workspace libraries inlined.                                               |
| `dist/ui/`                                  | The built SPA.                                                                                         |
| `dist/bin/{tasks,memory,tools,teamchat}.js` | The stdio MCP servers, published as the `clawboo-mcp-tasks`, `-memory`, `-tools` and `-teamchat` bins. |
| `dist/THIRD_PARTY_NOTICES.md`               | Licenses of the bundled dependencies, which do not travel in `node_modules`.                           |

npm adds its usual files on top (`package.json`, the README, the license).

A few modules stay outside the bundle:

- **External and declared in the CLI's `dependencies`:** `better-sqlite3`, `ws`, `pino`, `pino-pretty` and `@composio/client`.
- **External and optional:** `@opentelemetry/*` and `@anthropic-ai/claude-agent-sdk`. Both load lazily, and the npm package ships neither. Without OpenTelemetry, traces stay in the event log and OTLP export is unavailable. Without the Agent SDK, a Claude Code run fails with a message that says what to install (see [Claude Code](/runtimes/claude-code)).
- **Inlined:** everything else, including `express` and its middleware, `drizzle-orm`, `@noble/ed25519`, the provider SDKs (`@anthropic-ai/sdk`, `openai`) and `croner`, so a clean install runs Clawboo Native and Routines with nothing extra.

The CLI's only workspace edges are devDependencies (`@clawboo/config`, `@clawboo/process-lookup`, `@clawboo/tsconfig`). tsup inlines whatever is not listed in `dependencies`, so those reach the published package already bundled. `pnpm test:bundle-externals` checks the shipped bundles statically: every module they still load must be declared, a Node builtin, or on the optional list in `scripts/lib/bundle-externals.mjs`. [Testing](/internals/testing) covers that check and the clean-install gate.

## Root commands

Run these from the repo root. The Turbo-backed ones fan out across the workspace in build order.

| Command                      | What it does                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                 | `turbo build`: every package and app, in dependency order, cached.                                                                              |
| `pnpm dev`                   | `turbo dev --concurrency=20`: builds the dependencies, then starts each member's `dev` script (see below).                                      |
| `pnpm lint`                  | `turbo lint && pnpm lint:repo`: ESLint in every package, the docs frontmatter and heading check (the `docs` package's `lint`), then `scripts/`. |
| `pnpm lint:repo`             | `eslint scripts/ --max-warnings 0`.                                                                                                             |
| `pnpm format`                | `prettier --write .`: fixes formatting.                                                                                                         |
| `pnpm format:check`          | `prettier --check .`: the first step of CI's Lint job. A formatting-only failure turns that job red while ESLint passes.                        |
| `pnpm typecheck`             | `turbo typecheck`: `tsc --noEmit` in every package. The web app and CLI builds do not type-check, so their type errors surface here.            |
| `pnpm test`                  | `turbo test`: each package's own Vitest suites.                                                                                                 |
| `pnpm test:coverage`         | The same suites plus a per-package coverage table. CI's Test job runs this; there is no threshold.                                              |
| `pnpm e2e`                   | `playwright test`: the sandboxed end-to-end suite. It needs `pnpm build` first.                                                                 |
| `pnpm assemble`              | `pnpm build && bash scripts/assemble-cli.sh`: build, then copy the server bundle, SPA and MCP bins into `apps/cli/dist/`.                       |
| `pnpm catalog:build`         | Rebuilds `catalog/dist/**` and the compiled marketplace seed from the packs.                                                                    |
| `pnpm catalog:verify`        | Every marketplace content rule, then a `--check` that `catalog/dist` and the seed match a rebuild. Offline.                                     |
| `pnpm verify:connectors`     | Checks the committed connector catalog. Offline; add `--live` to re-resolve pinned packages and dial remote endpoints.                          |
| `pnpm check:docs`            | `docs/scripts/check-frontmatter.mjs`: fails on frontmatter that is not valid YAML, or a bare `%` in a heading.                                  |
| `pnpm test:clean-install`    | Packs and installs the CLI tarball, then boots that install. Run `pnpm assemble` first.                                                         |
| `pnpm test:bundle-externals` | The static check that the assembled bundles load only declared, builtin or optional modules.                                                    |
| `pnpm prepublish:check`      | `pnpm catalog:verify && pnpm verify:connectors && pnpm assemble && pnpm test:clean-install`.                                                    |

A Husky pre-commit hook runs `lint-staged`, which applies `eslint --fix` and Prettier to staged code files and Prettier to staged JSON, Markdown, YAML and CSS.

### The dev stack

Two members have a `dev` script, so `pnpm dev` starts both:

- **`apps/web`** runs `scripts/dev-orchestrator.cjs`. It picks the API port first: exactly `CLAWBOO_API_PORT` if set (and exits if that port is busy), otherwise the first free port of 20 from `CLAWBOO_API_PORT_START` (default 18790). It then runs `pnpm dev:api` (`tsx watch server/index.ts --dev`) and `pnpm dev:ui` (Vite on port 5173) with that port in their environment, so the UI's proxy and the API agree.
- **`docs`** runs `mint dev --port 3111`, the Mintlify preview. It needs the Mintlify CLI (`npm i -g mint`, or `npx mint`).

The repo needs Node `>=22.12.0` and pnpm `>=9`; `packageManager` pins `pnpm@9.15.0`, and `corepack enable` selects it. CI uses Node 22 and `pnpm install --frozen-lockfile`, so an out-of-date lockfile fails the install.

## Schema changes

Besides the usual build, lint, typecheck and test, `@clawboo/db` has one script: `db:studio` (`drizzle-kit studio`, a browser over `packages/db/dev.db`). There is no `db:migrate`, no `db:generate`, and no migration ladder.

The schema is the `CREATE TABLE IF NOT EXISTS` DDL in `ensureSchema` (`packages/db/src/schemaBootstrap.ts`), and it is the only place tables are created. `schema.ts` is the Drizzle type layer for typed queries; it never applies a migration. When the server opens an older database, `reconcileSchema` (`packages/db/src/schemaReconcile.ts`) reads the column list back out of the same DDL and adds any column the file is missing.

That makes one rule load-bearing. A new column on an existing table must be addable to a database that already exists:

- no `PRIMARY KEY`, no `UNIQUE`, and no `STORED` generated column;
- a `DEFAULT` must be a literal, not an expression;
- a `NOT NULL` column must have a non-NULL `DEFAULT`;
- a `REFERENCES` column must not have a non-NULL `DEFAULT`.

`schemaReconcile.test.ts` enforces it against the snapshot in `packages/db/src/__tests__/schemaBaseline.ts`; a column added after the snapshot counts as new and is held to the rule, so the snapshot needs no upkeep. The reconciler only adds columns. It leaves a column the DDL no longer declares in place, and it never changes a column's type, `NOT NULL`, `DEFAULT`, constraints or index definitions, so none of those changes is an in-place upgrade. `schemaSource.test.ts` checks that every `schema.ts` table and column matches the DDL, and that no migration scripts or `drizzle/` directory come back. The per-table reference is the [database schema](/reference/database-schema).

## Related

- [Package overview](/reference/packages/index): what each package is for, who uses it, and the dependency layers.
- [Testing](/internals/testing): the test layers and the CI job list.
- [Release process](/internals/release-process): changesets and the publish workflow.
- [Marketplace catalog](/reference/marketplace-catalog): the pack format behind `catalog:build` and `catalog:verify`.
- [Contributor overview](/internals/index): the repo map and the runtime architecture.
