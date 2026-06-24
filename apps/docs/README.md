# @clawboo/docs — Mintlify documentation site

This directory is a **generated** Mintlify site. The source of truth is the portable
Markdown under [`/docs`](../../docs) (no lock-in: `docs/` renders fine on GitHub and could be
fed to any other static-docs platform). The build step in
[`scripts/build-mintlify-docs.mjs`](../../scripts/build-mintlify-docs.mjs) converts it to the
`.mdx` + `docs.json` that Mintlify consumes.

## What the generator does (`docs/*.md` → `apps/docs/*.mdx`)

- Converts GFM alerts (`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`)
  to Mintlify callout components (`<Note>` / `<Tip>` / `<Info>` / `<Warning>` / `<Danger>`).
- Strips the internal `<!-- clawboo-docs:provenance -->` comments (and any other HTML comments
  MDX can't parse).
- Drops each page's leading `# H1` (Mintlify renders the frontmatter `title` as the page H1, so
  keeping the body H1 would double the heading).
- Rewrites links: relative `*.md` inside `docs/` → extensionless root paths; `../screenshots/*`
  → `/images/*`; anything else relative (repo source like `LICENSE`, `*.ts`, files outside
  `docs/`) → GitHub blob URLs.
- Copies `docs/screenshots/*` → `images/`, and the mascot SVGs → `logo/` + `favicon.svg`.
- Generates `docs.json` (theme + the four-tab navigation: Documentation / Reference / Internals
  / Resources) directly from the section layout, so every generated page is in the nav.

## Local workflow

```bash
# regenerate the .mdx + docs.json from the canonical docs/
pnpm --filter @clawboo/docs generate

# preview locally (regenerates first, then runs Mintlify's free local CLI on :3111)
pnpm --filter @clawboo/docs dev          # needs the `mint` CLI: npm i -g mint  (or use npx mint@latest)

# validate internal links
pnpm --filter @clawboo/docs check-links
```

If `npx mint` hangs on first run behind a flaky network, prefix with
`NODE_OPTIONS='--dns-result-order=ipv4first --no-network-family-autoselection'`.

## Editing rules

- **Edit `/docs/*.md`, never `apps/docs/*.mdx`.** The `.mdx` here are build artifacts —
  re-running `generate` overwrites them.
- After changing `/docs`, re-run `generate` so the site stays in sync (`pnpm build` does this
  too).

## Deploy (pending)

Deploy is via Mintlify (free OSS program applied for). On approval, connect this repo with the
docs root set to `apps/docs/` so Mintlify builds from the committed `.mdx` + `docs.json`.
