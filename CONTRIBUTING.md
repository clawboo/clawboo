# Contributing to Clawboo

Thanks for taking the time to contribute. Please read this guide before opening a PR.

---

## Prerequisites

- Node.js 22+
- pnpm 9+

That's it. Clawboo runs agents natively (paste a provider key), so you do not need any external runtime to develop or test. Connecting OpenClaw, Claude Code, Codex, or Hermes is optional and only needed when you are working on those adapters.

## Setup

```bash
git clone https://github.com/clawboo/clawboo.git
cd clawboo
pnpm install
pnpm dev          # Vite UI on :5173, API on :18790 (auto-fallback)
```

Clawboo stores all of its state under `~/.clawboo/` (auto-created on first run). The only optional override most contributors touch is `CLAWBOO_HOME`, to point a dev instance at a throwaway directory. There are **no feature flags**: every subsystem ships on, so there is nothing to enable. (Governance ships track-and-warn: budgets record spend and warn at thresholds, but nothing auto-pauses a run until you set a hard cap.)

## Your first contribution

New here? Welcome. The friendliest way in:

1. Browse issues labeled [`good first issue`](https://github.com/clawboo/clawboo/labels/good%20first%20issue). They are scoped small, name the files to touch, and do not need deep knowledge of the codebase.
2. Comment on the one you want ("I'd like to take this") and we will assign it to you. No need to ask twice.
3. Follow **Setup** above, make your change on a branch, and open a PR. If you get stuck, say so in the issue. A half-finished PR with a question is completely welcome.

Good starting areas that rarely need core changes: **new marketplace team templates**, **docs pages**, **a provider or runtime icon**, or **a test for an uncovered component**. If you are unsure whether an idea fits, open a [Discussion](https://github.com/clawboo/clawboo/discussions) first, before writing code.

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
pnpm lint                               # ESLint flat config across all packages
pnpm test                               # Vitest unit tests (node + jsdom projects)
pnpm e2e                                # Playwright end-to-end tests (incl. board round-trip + eval smoke)
pnpm assemble && pnpm test:clean-install  # bundle the CLI and smoke-test a clean install
```

Run them locally before pushing to avoid back-and-forth.

---

## Submitting a pull request

### 1. One PR, one concern

Keep PRs focused. Split unrelated changes into separate PRs.

### 2. Pass CI before requesting review

Every PR must pass `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`. New surfaces should also pass `pnpm e2e`.

### 3. Add a changeset for user-facing changes

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs. Any change that affects a published package (`@clawboo/*` or `clawboo`) needs one:

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
- **Forward-only migrations.** Files in `drizzle/` are append-only; never edit a committed migration.
- **Pure where it claims to be.** Policy and projection functions stay side-effect-free and unit-testable.
- **No secrets in logs, responses, or storage.** A credential's presence may be shown (the env-var name plus true/false), never its value.

---

## Release process (maintainers only)

Releases are automated via the `publish.yml` GitHub Actions workflow: when changesets land on `main`, the Changesets action opens a "Version Packages" PR; merging it bumps versions, updates changelogs, and publishes the changed packages to npm. No manual `npm publish` needed.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
