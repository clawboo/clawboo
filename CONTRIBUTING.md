# Contributing to Clawboo

Thanks for taking the time to contribute. Please read this guide before opening a PR.

---

## Prerequisites

- Node.js 22+
- pnpm 9 (pinned to 9.15.0; `corepack enable` selects it, see Setup)

That's it. Clawboo runs agents natively (paste a provider key), so you do not need any external runtime to develop or test. Connecting OpenClaw, Claude Code, Codex, or Hermes is optional and only needed when you are working on those adapters.

## Setup

```bash
git clone https://github.com/clawboo/clawboo.git
cd clawboo
corepack enable   # use the repo's pinned pnpm (9.15.0) so lockfile diffs stay clean
pnpm install
pnpm dev          # Vite UI on :5173, API on :18790 (auto-fallback)
```

Clawboo stores all of its state under `~/.clawboo/` (auto-created on first run). The only optional override most contributors touch is `CLAWBOO_HOME`, to point a dev instance at a throwaway directory. There are **no feature flags**: every subsystem ships on, so there is nothing to enable. (Governance ships track-and-warn: budgets record spend and warn at thresholds, but nothing auto-pauses a run until you set a hard cap.)

## Your first contribution

New here? Welcome. The friendliest way in:

1. Browse issues labeled [`good first issue`](https://github.com/clawboo/clawboo/labels/good%20first%20issue). They are scoped small, name the files to touch, and do not need deep knowledge of the codebase.
2. Comment on the one you want ("I'd like to take this") and we will assign it to you. No need to ask twice.
3. Follow **Setup** above, make your change on a branch, and open a PR. If you get stuck, say so in the issue. A half-finished PR with a question is completely welcome.

Good starting areas that rarely need core changes: **new marketplace team templates**, [**docs pages**](#documentation), **a provider or runtime icon**, or **a test for an uncovered component**. If you are unsure whether an idea fits, open a [Discussion](https://github.com/clawboo/clawboo/discussions) first, before writing code.

New to the codebase? The [Internals map](https://docs.claw.boo/internals) is a guided tour of how the pieces fit together, and it flags "caution surfaces": files that encode load-bearing fixes worth reading before you change them.

## Documentation

The docs live in `docs/`, and that directory **is** the site: hand-edited Mintlify Markdown with no build step. Merging to `main` redeploys [docs.claw.boo](https://docs.claw.boo) as-is, so the files in your PR are exactly what ships.

**Frontmatter is parsed as YAML, so quote any `title` or `description` value that contains a colon, or that starts with `@` or a backtick.** An unquoted `:` followed by a space parses as a nested mapping and Mintlify serves the page as a 404 instead of rendering it. Preview with `mint dev` (the Mintlify CLI, `npx mint dev` if you have not installed it) before opening a docs PR: a full build is what surfaces this, whereas `check-links` only validates links. `pnpm check:docs` catches it too, and runs as part of `pnpm lint` and CI.

Either quote style is valid YAML; Prettier normalizes them to single quotes when the pre-commit hook formats your page. One sibling rule, same class of breakage: **never put a bare `%` in a body heading** — Mintlify URI-decodes headings into anchor slugs and fails the page on invalid percent-encoding. A `%` in prose is fine. `pnpm check:docs` enforces both.

See [`docs/README.md`](./docs/README.md) for the rest of the workflow: the directory layout, adding a page to the `docs.json` navigation, previewing locally, and the Mintlify-flavored conventions these pages use.

## Branching

We use [GitHub Flow](https://docs.github.com/en/get-started/using-git/github-flow):

1. Create a branch from `main` with a descriptive prefix: `feat/`, `fix/`, `chore/`, `docs/`, `test/`, or `refactor/`.
2. Make your changes and push the branch.
3. Open a pull request. The PR template guides you through the checklist.
4. CI must pass before merging. PRs are squash-merged into `main`.

## Commands

```bash
pnpm build                              # build all packages and apps
pnpm typecheck                          # tsc --noEmit across the monorepo
pnpm format:check                       # Prettier --check across the repo; fix with pnpm format
pnpm lint                               # ESLint flat config across all packages, plus the docs frontmatter + heading checks
pnpm test                               # Vitest unit tests (node + jsdom projects)
pnpm e2e                                # Playwright end-to-end tests (incl. board round-trip + eval smoke)
pnpm verify:connectors                  # offline: committed connector catalog consistency check
pnpm catalog:build                      # rebuild catalog/dist and the compiled marketplace seed
pnpm catalog:verify                     # offline: every marketplace content rule, then "is catalog/dist current?"
pnpm assemble && pnpm test:clean-install  # bundle the CLI, pack it, install the tarball, and smoke-test it
pnpm test:bundle-externals              # fast check: the bundles load nothing that isn't declared (needs pnpm assemble first)
```

Run them locally before pushing to avoid back-and-forth. Every one of them runs as a CI job too.

`pnpm e2e` needs a built workspace (`pnpm build` first) and a Chromium download (`pnpm exec playwright install chromium`). It sandboxes itself into a throwaway `$HOME`, so it never touches your real `~/.clawboo`.

`pnpm test:clean-install` packs `apps/cli` and installs the tarball into a throwaway temp dir, so it needs network access for the `npm install`. It also drives the installed SPA in headless Chromium, so it needs the same `pnpm exec playwright install chromium` download as `pnpm e2e`. And it refuses to run while another Clawboo dashboard is listening on `18790`–`18809` (it would attach to that one instead of the tarball) — stop your `pnpm dev` server first.

---

## Contributing a marketplace pack

Agent and team content lives in `catalog/`, a plain content folder that is
deliberately **not** a pnpm workspace member and **not** part of any turbo task.
A pull request that touches only `catalog/` runs `catalog-ci.yml` (about two
minutes) instead of the full matrix. `catalog/README.md` has the layout;
[the marketplace catalog reference](docs/reference/marketplace-catalog.md) has
the format.

```bash
# edit catalog/packs/<publisher>/<slug>/**
pnpm catalog:build     # regenerate catalog/dist and the compiled seed
pnpm catalog:verify    # every content rule, then "is dist current?"
```

Commit the regenerated `catalog/dist/**` along with your change. It is committed
on purpose: it is what makes the fallback URL work with no infrastructure, and
`catalog:verify` fails if it is not byte-for-byte what a rebuild would write.

**One exception to the fast path.** `catalog/packs/clawboo/**` is the seed, and
the seed is compiled into the published tarball. Changing it changes shipped
bytes, so it is treated as a product change and gets the full CI matrix. If you
touch it, also commit the regenerated seed modules under
`apps/web/src/features/marketplace/seed/` and `apps/web/server/lib/catalogSeed.ts`.

### The review bar

Content is prompt text that ships to a model and card text that ships to a user,
so it is reviewed as writing, not just as JSON. Packs are merged by hand; there
is no auto-merge.

- **A description is a sentence.** One or two of them, written for a person
  choosing between cards. Not a truncated first paragraph, and never ending in
  an ellipsis.
- **`IDENTITY.md` is the agent's complete instruction body**, not a summary and
  not an excerpt. Whatever the detail sheet shows is what gets written on deploy.
- **No YAML frontmatter.** The listing already carries `name`, `description`,
  `emoji` and `color` as structured fields; repeating them as prompt text is
  waste the model pays for.
- **Attribution is not optional.** A pack that sets `provenance.repo` ships a
  `NOTICE.md` with the upstream licence, the pinned commit, and a plain
  statement of what was modified.
- **A team has at least two members**, and routing for every one of them. A team
  of one is a solo agent wearing a team's clothes.
- **New taxonomy is declared.** A category the host ships no label for must be
  listed in the manifest's `newCategories`, so it is a line in the diff rather
  than a silent new filter chip.
- **No competing registry, installer, or chat invite** in any string, body and
  routing included.

`pnpm catalog:verify` enforces every one of those mechanically, plus schema
validation, referential integrity, and a prompt-injection scan of each field a
deploy would write. A flagged injection finding needs a reviewed row in
`scripts/catalog/injection-allowlist.ts` with a real reason and a real reviewer;
regenerate the skeleton with
`tsx scripts/catalog/validate.ts --update-allowlist`.

### Fixture hygiene

- `catalog/dist/**` is **generated**. Never hand-edit it, and never reformat it:
  those are canonical bytes (sorted keys, no trailing newline) that every
  published `integrity` value was computed over. `.prettierignore` keeps
  Prettier away from them through its `**/dist/` entry.
- The seed modules are generated too, from the same command. `catalog:verify`
  fails when either copy drifts from the pack.
- Pack **source** under `catalog/packs/**` is hand-edited and Prettier-formatted
  like any other JSON in the repo. Only `dist/` is canonical.
- Tests read the real packs off disk rather than a hand-written fixture, because
  a fixture drifts and the content is what the assertions are about.

---

## Submitting a pull request

### 1. One PR, one concern

Keep PRs focused. Split unrelated changes into separate PRs.

Keep the `pnpm-lock.yaml` diff minimal. If yours balloons by thousands of lines, you are on a different pnpm than the pinned `9.15.0`: run `corepack enable`, then `pnpm install`, and commit only the intended lockfile change. (Dependency bumps mostly arrive on their own: Dependabot runs weekly with three grouped entries, one for the root workspace, one for `website/`, and one for the GitHub Actions pins, so you rarely need to touch the lockfile by hand. Major bumps, plus `better-sqlite3` and `ws`, deliberately come as their own PRs.)

### 2. Pass CI before requesting review

Every PR must pass CI: `pnpm build`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`, and CodeQL code scanning. Not every one of those blocks the merge button today, but a red check is a red check: fix it, or say in the PR why it is unrelated.

### 3. Add a changeset for user-facing changes

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs. Every `@clawboo/*` library is `private: true`; only the `clawboo` CLI publishes to npm, with the libraries inlined into its bundle. So a changeset is needed when your change reaches the `clawboo` CLI's bundled behavior:

```bash
pnpm changeset
```

The interactive CLI asks which packages changed, the bump type (`patch` / `minor` / `major`), and a one-line summary. Commit the generated file in `.changeset/` alongside your code.

Documentation-only, CI-only, and `apps/web`-only changes do not need a changeset (the dashboard is not published).

### 4. Tests for new surfaces

Add a test for anything you add. Unit logic goes in Vitest (`*.test.ts` in the node project); React components go in the jsdom project (`*.test.tsx`, RTL + MSW + jest-dom + jest-axe), asserting render, the nav or feature gate, and one interaction. New end-to-end behavior goes in Playwright.

---

## Code guidelines

- **TypeScript strict.** No `any`, no `unknown` leaking through, no `@ts-ignore`.
- **No `console.log`.** Log through `@clawboo/logger` (pino).
- **Lucide icons only.** Never emoji in the UI.
- **Theme tokens, never raw hex.** Use the CSS variables and Tailwind tokens (brand marks are the only exception).
- **No migration ladder; keep new columns addable.** The SQLite schema is the `CREATE TABLE IF NOT EXISTS` DDL in `packages/db/src/schemaBootstrap.ts` (there is no `drizzle/` directory, no `.sql` migrations, and no `db:migrate`/`db:generate`). Keep that DDL additive and idempotent. `CREATE TABLE IF NOT EXISTS` skips the whole statement when the table already exists, so a new column would be a silent no-op on every existing database; `reconcileSchema` closes that by reading the column set back out of the same DDL and adding what an older file is missing. What it asks of you: a **new column on an existing table** must be addable, which means it may not use `PRIMARY KEY`, `UNIQUE`, or a `STORED` generated column; any `DEFAULT` must be a literal rather than an expression; a `NOT NULL` column must carry one; and a `REFERENCES` column must not have a non-NULL one. Break one of those and the build fails, because `schemaBaseline.ts` records the columns as of the last review and a test asserts everything added since can reach a database that already exists. That file needs no upkeep: a column added after the snapshot simply reads as new and is held to the rule, which is the rule anyway. Changing an existing column's type or constraints, or removing one, is still not an in-place upgrade. `schemaSource.test.ts` and `schemaReconcile.test.ts` guard this.
- **Version every persisted client store.** The rule above is about the server's SQLite; the browser is the opposite case, because you cannot hard-reset a user's storage for them. So a zustand `persist` store sets **both** `version` and `migrate` — never one without the other. Without a `migrate`, bumping the version makes zustand log an error and merge `undefined`, silently discarding the rows it just read back; and `migrate` receives the _partialized_ shape and fires on any version mismatch, downgrades included. Keep the migrate a pure exported function with its own `*.test.ts` in the node project. (There is currently no `persist` store in the repo. For a trivial single value, the Atlas layout toggle in `features/graph/store.ts` shows the lighter pattern — validate on read with an exact match, fall back to the default — which is the right weight for one enum; note the graph store must _not_ become a `persist` store, because `persist` re-serializes on every `set` and that store mutates per drag frame.)
- **Pollers pause when the tab is hidden.** A new interval-based refresh uses `useVisiblePolling` from `apps/web/src/lib/useVisiblePolling.ts`, not a bare `setInterval`, so a backgrounded tab stops hitting the local API and catches up once on return. A wall-clock grace or expiry timer is the exception (see `ChatPanel.tsx`) — pausing those changes behaviour, so they keep a plain interval and say why in a comment.
- **Schema fixtures are append-only.** `packages/pack-format/src/__fixtures__/v1/*.json` is the frozen record of what schema v1 looked like. Editing one to make a test pass is exactly how a version ladder silently stops covering the shape it claims to: the fixture stops being evidence and becomes a copy of the current code. When a shape changes, add a fixture under the new version's folder; never rewrite an old one.
- **Every schema version gets a `kitchen-sink.json`.** Alongside `minimal.json` (the smallest valid document), each version needs one fixture that sets **every** optional field to a legal value. Optional fields are where a ladder rots unnoticed, because a `minimal` fixture keeps passing while nothing exercises the half of the schema that only some packs use.
- **Pure where it claims to be.** Policy and projection functions stay side-effect-free and unit-testable.
- **No secrets in logs, responses, or storage.** A credential's presence may be shown (the env-var name plus true/false), never its value.

---

## Release process (maintainers only)

Releases are automated via the `publish.yml` GitHub Actions workflow: when changesets land on `main`, the Changesets action opens a "Version Packages" PR; merging it bumps versions, updates changelogs, and publishes the changed packages to npm. No manual `npm publish` needed.

Before it publishes, the workflow re-runs the whole PR gate — `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `bash scripts/assemble-cli.sh` and `pnpm test:clean-install`. Every check there is offline by design: nothing fetches an upstream repository, so an upstream outage cannot hold up a release. `typecheck` matters most there: `pnpm build` is bundler-only and never runs `tsc`, so it is the only step that would stop a type error reaching npm.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
