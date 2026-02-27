# Contributing to Clawboo

Thanks for taking the time to contribute! Please read this guide before opening a PR.

---

## Prerequisites

- Node.js 22+
- pnpm 9+
- A running [OpenClaw Gateway](https://github.com/openclaw/openclaw) instance for end-to-end testing

## Setup

```bash
git clone https://github.com/clawboo/clawboo.git
cd clawboo
pnpm install
pnpm dev          # starts apps/web on :3000
```

## Commands

```bash
pnpm build        # build all packages and apps
pnpm typecheck    # tsc --noEmit across the monorepo
pnpm lint         # ESLint flat config across all packages
pnpm test         # Vitest unit tests
pnpm e2e          # Playwright end-to-end tests
```

---

## Submitting a Pull Request

### 1. One PR, one concern

Keep PRs focused. Split unrelated changes into separate PRs.

### 2. Pass CI before requesting review

Every PR must pass all four CI jobs:

| Job       | Command          |
| --------- | ---------------- |
| Build     | `pnpm build`     |
| Lint      | `pnpm lint`      |
| Typecheck | `pnpm typecheck` |
| Test      | `pnpm test`      |

Run them locally before pushing to avoid back-and-forth.

### 3. Add a changeset for user-facing changes

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs. Any change that affects a published package (`@clawboo/*` or `clawboo`) needs a changeset.

**What needs a changeset:**

- Bug fixes in any `packages/*` package
- New features in any `packages/*` package or `apps/cli`
- Breaking changes (use a `major` bump)

**What does NOT need a changeset:**

- Documentation-only changes
- CI/tooling changes (`.github/`, config files)
- Changes only to `apps/web` (the dashboard is not published)

#### How to add a changeset

```bash
pnpm changeset
```

The interactive CLI will ask you:

1. **Which packages are affected?** — Select every package your PR changes.
2. **What type of change?**
   - `patch` — bug fix, no API change
   - `minor` — new feature, backward-compatible
   - `major` — breaking change
3. **Summary** — Write a one-line description of what changed (appears in the changelog).

This creates a file in `.changeset/`. Commit it alongside your code changes.

```bash
git add .changeset/
git commit -m "chore: add changeset"
```

#### Example changeset file

```markdown
---
'@clawboo/gateway-client': patch
---

Fix WebSocket reconnect race condition when the upstream closes unexpectedly.
```

---

## Release process (maintainers only)

Releases are automated via the `release.yml` GitHub Actions workflow:

1. When changesets land on `main`, the Changesets action opens (or updates) a **"Version Packages"** PR.
2. That PR bumps `package.json` versions and updates `CHANGELOG.md` files for all affected packages.
3. When the PR is merged, the action publishes all changed packages to npm automatically.

No manual `npm publish` needed.

---

## Code guidelines

- **TypeScript strict** — no `any`, no `@ts-ignore`
- **No breaking changes to migrations** — `drizzle/` files are append-only
- **Pure policy functions** — `packages/events/src/policy/` must remain side-effect-free and fully unit-testable
- **Architecture invariants** — see `CLAUDE.md` for the full list (same-origin WS, Bridge→Policy→Handler pipeline, etc.)

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
