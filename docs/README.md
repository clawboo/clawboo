# @clawboo/docs: Mintlify documentation site

This directory **is** the documentation site, hand-edited Mintlify Markdown that Mintlify deploys
as-is. There is no build or generation step: the `.md` files and `docs.json` here are the source of
truth, exactly what ships to [docs.claw.boo](https://docs.claw.boo).

## Layout

- `*.md` / `*.mdx` — the pages (129 total). Mintlify-flavored Markdown: YAML frontmatter
  (`title` / `description`), callout components (`<Note>` / `<Tip>` / `<Info>` / `<Warning>` /
  `<Danger>`), and root-relative links such as `/concepts/the-board`. Almost every page is `.md`;
  a couple are `.mdx` where Mintlify's plain-`.md` resolver doesn't pick the page up. **If a page's
  inbound links start failing `mint broken-links`, rename it `.md` → `.mdx`** (no other change needed —
  the nav uses extensionless paths).
- `docs.json` — theme + the four-tab navigation (Documentation / Reference / Internals / Resources).
  Hand-maintained: when you add a page, add its path to the right group's `pages` array.
- `images/` — screenshots, referenced by pages as `/images/<name>`.
- `logo/`, `favicon.svg` — brand assets referenced by `docs.json`.

## Editing

Edit the `.md` files directly and open a PR. On merge to `main`, Mintlify redeploys
[docs.claw.boo](https://docs.claw.boo) automatically (no build step). Outside contributors can use
the per-page "Suggest edits" link (it opens the file on GitHub) or fork, edit, and open a PR.

```bash
# preview locally (needs the Mintlify CLI: npm i -g mint, or use npx mint)
mint dev --port 3111          # or: pnpm --filter @clawboo/docs dev

# validate internal links
mint broken-links             # or: pnpm --filter @clawboo/docs check-links
```

If `npx mint` hangs on first run behind a flaky network, prefix with
`NODE_OPTIONS='--dns-result-order=ipv4first --no-network-family-autoselection'`.

## Notes

- These pages are **Mintlify-flavored** (callout components + root-relative links), not portable
  GitHub-flavored Markdown, so they render best on the Mintlify site rather than in the GitHub file view.
- `pnpm build` here is a deliberate no-op: Mintlify deploys this directory directly, so there is
  nothing to build.
