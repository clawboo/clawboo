---
title: Monorepo and build
description: How Clawboo's TurboRepo + pnpm-workspaces monorepo is laid out, the build order, what publishes, and the root commands.
---

Clawboo is a TurboRepo + pnpm-workspaces monorepo. Shared libraries live under the `@clawboo/*` scope in `packages/`; the two consumers are `apps/web` (the dashboard SPA + Express API) and `apps/cli` (`npx clawboo`). This page is for people working _on_ Clawboo: how the workspace is wired, why the build runs in the order it does, what actually ships to npm, and the root commands you run day to day.

If you want the per-package API surface and the dependency graph in detail, read [the package overview](/reference/packages/index); this page is the build mechanics, not the package catalog.

## What it is, and what it isn't

The repo is a **single workspace** of many small packages, not a polyrepo with version pins. Every `@clawboo/*` library is consumed via `workspace:*` (or `workspace:^`) protocol from the two apps, so there is no internal npm publish-then-install loop; Turbo builds a package's `dist/` and the app that depends on it picks it up directly.

It is **not** a "publish every package" monorepo. Despite 29 scoped packages, **all of them are `private: true`**; none publishes to npm. The **only** published artifact is the `clawboo` CLI in `apps/cli`, and it does not depend on its sibling packages at runtime the way the web app does. Instead, the build _inlines_ the libraries it needs into the CLI's shipped bundle. See [What publishes](#what-publishes).

## The workspace layout

`pnpm-workspace.yaml` declares four globs:

```yaml
packages:
  - 'packages/*'
  - 'packages/adapters/*'
  - 'apps/*'
  - 'docs'
```

The second glob is load-bearing. The five runtime adapters live one level deeper, `packages/adapters/{native,openclaw,claude-code,codex,hermes}`, so without `packages/adapters/*` pnpm would not discover them and `workspace:*` resolution would fail. The result is **29 packages** (24 top-level under `packages/*` plus 5 nested adapters), two apps, and the `docs/` Mintlify site (hand-edited Markdown, deployed as-is).

`@clawboo/tsconfig` is the shared TypeScript-config root, `base.json`, `react.json`, `node.json`. It is a devDependency everywhere and has no runtime edge, so it doesn't appear in the dependency graph that drives the build order.

### Layer boundaries (lint-enforced)

`apps/web` is two build targets in one workspace package: `server/` is bundled for Node by tsup, `src/` is bundled for the browser by Vite. Together with the one-way apps → packages rule, that gives three boundaries, all enforced in `eslint.config.mjs` rather than by reviewer vigilance:

| Rule                                                  | Why                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/server/**` may not import `apps/web/src/**` | Keeps the server portable (it is the basis of the planned thin clients) and stops browser code drifting into the server bundle. |
| `apps/web/src/**` may not import `apps/web/server/**` | The load-bearing direction: server modules pull in `node:*` and native deps that would be dragged into the browser bundle.      |
| `packages/**` may not import `apps/**`                | Dependencies flow one way; a package reaching back into an app would invert the build graph.                                    |

Anything two layers genuinely share is extracted into a `@clawboo/*` package instead. `@clawboo/model-catalog` is the worked example: the static model catalog used to live in SPA source and the server reached across for it, which was the only such import in the tree.

The rules use relative-only patterns on purpose, so a legitimate bare specifier such as `react-dom/server` is not mistaken for a layer crossing, and they pair `no-restricted-imports` with a `no-restricted-syntax` selector because the former does not visit dynamic `import()`. `apps/web`'s `lint` script must cover `server/` as well as `src/` for the server-side rule to run at all; [`importBoundary.test.ts`](/internals/testing#the-standing-guards) asserts exactly that.

```mermaid
graph TD
  root["pnpm-workspace.yaml"]
  root --> p["packages/*<br/>(24 top-level libs)"]
  root --> a["packages/adapters/*<br/>(5 runtime adapters)"]
  root --> apps["apps/*<br/>(web + cli)"]
  p -. "@clawboo/* scope" .- a
  apps -- "workspace:* deps" --> p
  apps -- "workspace:* deps" --> a
```

## The build pipeline (Turbo)

`turbo.json` defines five tasks, all of which `dependsOn` the upstream build:

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true, "dependsOn": ["^build"] },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

The `^build` prefix means **"build all of this package's dependencies first."** That single line is what makes the build order correct without anyone hand-maintaining it: Turbo reads each `package.json`'s `@clawboo/*` dependency edges and topologically sorts them. A package's `dist/` is always present before any task that depends on it runs. `lint`, `typecheck`, and `test` each depend on `^build` too, so they run against compiled dependency output, not stale `dist/` (or a missing one on a clean checkout).

`build` declares `dist/**` as its cache output, so Turbo can skip rebuilding an unchanged package and restore its `dist/` from cache. `dev` is marked `cache: false` and `persistent: true` (it's a long-running watcher, never cached).

Each library builds with **tsup**; the standard config emits CJS + ESM + `.d.ts` into `dist/`. The web app's build is bespoke: a Vite build for the SPA plus two tsup runs (the server bundle and the MCP stdio bins); the CLI is a single tsup run.

<Note>
Turbo derives the *exact* topological order from the `package.json` graph. The tiers below are the human-readable grouping; they are not a strict serial sequence, because edges like `db → obs` and `evals → db` interleave what would otherwise be neat layers.
</Note>

## Build order

Packages build before the apps that depend on them. Within a tier, no package has a `@clawboo/*` edge on a sibling in the same tier.

```mermaid
graph TD
  subgraph t1["1 · roots"]
    tsconfig["tsconfig (config-only)"]
    logger["logger"]
  end
  subgraph t2["2 · leaves"]
    config["config"]
    gc["gateway-client → logger"]
    protocol["protocol"]
    ar["agent-registry"]
    bc["board-core"]
  end
  subgraph t3["3"]
    events["events → gateway-client, logger, protocol"]
    gp["gateway-proxy → config"]
  end
  subgraph t4["4 · pure + adapters + db deps"]
    executor["executor"]
    compaction["compaction"]
    modelcatalog["model-catalog"]
    scheduler["scheduler"]
    worktrees["worktrees"]
    governance["governance"]
    obs["obs"]
    adapters["adapters/* → executor<br/>(openclaw also → events/gateway-client/logger/protocol)"]
  end
  subgraph t4b["4b · db, after its deps"]
    db["db → board-core, compaction, governance, obs"]
    evals["evals → db, executor, governance, obs"]
  end
  subgraph t5["5"]
    booavatar["boo-avatar"]
    ui["ui → boo-avatar"]
  end
  subgraph t6["6"]
    mcp["mcp → db"]
  end
  subgraph t7["7 · apps"]
    web["apps/web → 27 runtime packages (direct)"]
    cli["apps/cli → config"]
  end

  t1 --> t2 --> t3 --> t4 --> t4b --> t5 --> t6 --> t7
```

1. **`tsconfig` + `logger`**: the shared TS-config root and the base logger. `logger` has no `@clawboo/*` runtime edge.
2. **`config` · `gateway-client` · `protocol` · `agent-registry` · `board-core`**: `gateway-client` depends on `logger`; the rest are pure/zero-dep. `board-core` holds the task state machine that `db`, `team-orchestration`, and the board UI all read.
3. **`events` · `gateway-proxy`**: `events` → `gateway-client`/`logger`/`protocol`; `gateway-proxy` → `config`.
4. **`executor` · `adapters/*` · `worktrees` · `compaction` · `model-catalog` · `scheduler` · `governance` · `obs`**: `executor` is pure (`.` + `./contract` + `./tiers` subpath exports); the five adapters depend only on `executor` (`adapter-openclaw` also on `events`/`gateway-client`/`logger`/`protocol`). `compaction`/`governance`/`obs` are the dependencies `db` pulls in, so `db` (and `evals`, which needs `db`/`executor`/`governance`/`obs`) sequence after this tier. `model-catalog` is a zero-dep leaf both `apps/web` layers read, extracted so the server never imports SPA source.
5. **`boo-avatar` + `ui`**: `ui` → `boo-avatar`.
6. **`mcp`**: depends on `db`; its build also produces the stdio bins.
7. **`apps/web` → `apps/cli`**: the web app directly depends on 27 of the `@clawboo/*` runtime packages (`boo-avatar` reaches it transitively via `ui`, so all 28 are consumed); the CLI's only `@clawboo/*` dependency is `config`.

## What publishes

Run `pnpm build` and you produce `dist/` for every package. But `npm publish` only ships **`clawboo`**, the CLI. Every `@clawboo/*` package carries `private: true`, so a `pnpm publish` (or Changesets publish) skips it.

The CLI ships as a self-contained bundle. The web server's tsup config (`tsup.server.config.ts`) marks the whole `@clawboo/*` scope `noExternal`, so `dist/server.js` **inlines** every workspace library it uses, `db`, `mcp`, `governance`, the adapters, and the rest, into one file. `assemble-cli.sh` then copies that `server.js`, the Vite `ui/`, and the four bundled MCP stdio bins into `apps/cli/dist/`. The published CLI tarball's `files` array is just `dist`, so the npm package is exactly: the CLI entrypoint, the inlined server bundle, the SPA assets, and the MCP bins.

This is why the CLI's `package.json` lists only `@clawboo/config` (and the `@clawboo/tsconfig` devDependency) as a workspace dependency. Everything else reaches the published package already bundled into `server.js`, not as a separate npm install.

<Info>
A few runtime deps stay **external** in the server bundle and must be present in the CLI's own `dependencies`: `better-sqlite3`, `ws`, `pino`, and `pino-pretty` (native or stream-y modules tsup shouldn't inline), plus the lazily-imported `@opentelemetry/*`. The provider SDKs `@anthropic-ai/sdk` + `openai` and the scheduler's `croner`, by contrast, **are** bundled (`noExternal`) so a clean `npx clawboo` install runs the native runtime and Routines with no extra `node_modules`.
</Info>

## Root commands

These run from the repo root. The Turbo-fronted ones fan out across the workspace honoring the build order.

| Command                      | What it does                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                 | `turbo build`, builds every package + app `dist/`, dependency-ordered, cached.                                                           |
| `pnpm dev`                   | `turbo dev --concurrency=20`, runs each package/app dev task. For `apps/web` this is the dev orchestrator (below).                       |
| `pnpm lint`                  | `turbo lint`, ESLint across the workspace, plus the docs frontmatter + heading checks (the `docs` package's `lint` script).              |
| `pnpm typecheck`             | `turbo typecheck`, `tsc --noEmit` across the workspace.                                                                                  |
| `pnpm test`                  | `turbo test`, per-package Vitest (the real path; each package has its own config).                                                       |
| `pnpm e2e`                   | `playwright test`, the Playwright end-to-end suite (sandboxed; see [Testing](#testing-strategy-pointer)).                                |
| `pnpm assemble`              | `pnpm build && bash scripts/assemble-cli.sh`, full build, then copy the server bundle + UI + MCP bins into `apps/cli/dist/`.             |
| `pnpm verify:catalog`        | `tsx scripts/verify-catalog.ts`, fails if the committed marketplace catalog drifts from its integrity manifest. Offline.                 |
| `pnpm verify:ingest`         | `tsx scripts/verify-ingest.ts`, fails if the committed marketplace catalog drifts from a fresh codegen. Needs network.                   |
| `pnpm ingest:marketplace`    | `tsx scripts/ingest-marketplace-content.ts`, regenerates that catalog from the pinned upstream SHAs.                                     |
| `pnpm check:docs`            | `docs/scripts/check-frontmatter.mjs`, fails on invalid YAML frontmatter or a bare `%` in a heading (the 404 class of bug).               |
| `pnpm test:clean-install`    | `node scripts/test-clean-install.mjs`, packs + installs the CLI tarball and asserts the install works (see below).                       |
| `pnpm test:bundle-externals` | `node scripts/check-bundle-externals.mjs`, fails if a shipped bundle loads a module that isn't declared / builtin / documented-optional. |
| `pnpm prepublish:check`      | `pnpm verify:catalog && pnpm assemble && pnpm test:clean-install`, the local catalog-and-artifact release check (not the full gate).     |

`pnpm dev` for the web app does **not** start Vite and Express directly. It runs `scripts/dev-orchestrator.cjs`, which picks a free API port first (honoring `CLAWBOO_API_PORT`, else scanning from `CLAWBOO_API_PORT_START`), exports it into the child env, then `concurrently` runs `pnpm dev:api` (`tsx watch server/index.ts`) and `pnpm dev:ui` (`vite`) so both inherit the same port, no race over who binds first.

<Note>
The repo requires Node `>=22` and pnpm `>=9` (`packageManager` pins `pnpm@9.15.0`). CI runs on Node 22 with `pnpm install --frozen-lockfile`, so the lockfile is authoritative.
</Note>

### `db:studio` is the only database script

`@clawboo/db` exposes exactly one script: `db:studio` (`drizzle-kit studio`, a read-only browser over the dev DB). There is **no `db:migrate` and no `db:generate`**; both were removed.

The reason is the schema model: Clawboo has **no migration ladder**. The schema is created by `ensureSchema`'s `CREATE TABLE IF NOT EXISTS` DDL (`packages/db/src/schemaBootstrap.ts`); that DDL is the _sole_ schema-creation source for all 27 tables. `schema.ts` is the Drizzle **type** layer used for typed queries, never to apply migrations. A schema change is a hard reset of the local SQLite file (the database is per-user local state, not a shared server), so there is nothing to generate or migrate.

A unit test (`schemaSource.test.ts`) guards this posture two ways: it builds a real in-memory DB via `createDb()` and asserts every `schema.ts` table and its column set matches the live DDL (catching drift between the type layer and the bootstrap), and it asserts the package ships no `db:migrate`/`db:generate` scripts, no `drizzle` entry in `files`, and no migration-ladder directory on disk. `drizzle.config.ts` remains only so `drizzle-kit studio` can find the schema.

<Danger>
Do not reintroduce a migration ladder or a `db:migrate` script casually. The "DDL is the schema, schema change is a reset" decision is enforced by a test that will fail the build if you ship the migration-runner scripts. If a future change needs migrations, it's a deliberate architectural shift; start by reading `schemaSource.test.ts`.
</Danger>

## The release gate

The release path layers two gates on top of the normal build. `pnpm assemble` produces the CLI bundle; `pnpm test:clean-install` then simulates `npx clawboo` on a real machine. It does that against a **real install**, not the repo build: it `pnpm pack`s `apps/cli` and `npm install`s the tarball into a throwaway directory under the OS temp dir, so nothing can resolve through the workspace's `node_modules` and the published `files` whitelist plus the published dependency closure are what get tested. Against that install it asserts the packaged `bin` entries exist with their npm shims, that every module the bundles still load is declared / builtin / documented-optional, that the CLI's HTTP-signature port probe skips a fake non-Clawboo listener on a nearby port, that the SPA renders at `/` and a deep route falls through to `index.html`, that `/api/settings` returns Clawboo-shaped JSON, that the SPA actually boots in headless Chromium rather than merely being served, that an installed MCP stdio bin completes a real JSON-RPC `tools/list` handshake, that a real `POST /api/runtimes/clawboo-native/run` drives a board task to `done` against a local stub provider, and that a SECOND launch against an already-running dashboard reuses it instead of forking a second server. It exists because v0.1.1 (`Cannot GET /`) and v0.1.2 (port-collision `Unauthorized`) shipped broken; this catches that whole class.

CI mirrors the gate. The `ci.yml` workflow runs `lint`, `typecheck`, `test`, `build`, `verify-catalog`, `smoke-test-bundle`, and `e2e` as parallel jobs; the bundle smoke test runs on a `[ubuntu-latest, windows-latest, macos-latest]` matrix (the Windows leg guards spawn/path regressions; macOS is a primary user OS), while `e2e` is Ubuntu-only because Playwright's `webServer` command is POSIX shell syntax. The `publish.yml` workflow re-runs `verify:catalog` → `build` → `lint` → `typecheck` → `test` → `assemble-cli.sh` → `test:clean-install` before the Changesets publish step, so a broken bundle can't reach npm even if a PR race let it through. Every catalog check on the release path is offline by design; the live upstream re-derive lives in `verify-ingest.yml`. `typecheck` earns its place there specifically because `pnpm build` is bundler-only and never runs `tsc`.

## Testing strategy pointer

The test layout follows the monorepo shape. Each library has its own `vitest.config.ts` and runs under `turbo test`; the root `vitest.config.ts` only globs `packages/*/src/**/*.test.ts` for ad-hoc package runs. `apps/web` uses a **two-project** Vitest config: a `node` project (the SPA logic in `src/` plus the Express-server integration tests in `server/`, all `.test.ts`, with widened timeouts for real-git/real-sqlite tests) and a `jsdom` project (React component tests, `.test.tsx`). On top of that sit the Playwright e2e suite (sandboxed into a throwaway `$HOME`), the clean-install bundle smoke test, and the `@clawboo/evals` orchestration harness. For the full picture see [Testing](/internals/testing).

## See also

- [Package overview](/reference/packages/index), per-package version, purity, deps, and the full dependency graph
- [Testing](/internals/testing), unit / component / e2e / clean-install / evals strategy
- [Release process](/internals/release-process), Changesets, `publish.yml`, and the clean-install gate
- [Codegen and ingestion](/internals/codegen-and-ingestion), the marketplace ingest + `verify:ingest` gate
- [Database schema](/reference/database-schema), the 27 tables created by `createDb`'s DDL
- [Internals overview](/internals/index), the contributor map
