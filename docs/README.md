# @clawboo/docs: Mintlify documentation site

This directory **is** the documentation site, hand-edited Mintlify Markdown that Mintlify deploys
as-is. There is no build or generation step: the `.md` files and `docs.json` here are the source of
truth, exactly what ships to [docs.claw.boo](https://docs.claw.boo).

## Layout

- `*.md` / `*.mdx`: the pages. Mintlify-flavored Markdown: YAML frontmatter
  (`title` / `description`), callout components (`<Note>` / `<Tip>` / `<Info>` / `<Warning>` /
  `<Danger>`), and root-relative links such as `/concepts/the-board`. Almost every page is `.md`;
  a couple are `.mdx` where a page genuinely needs MDX/JSX. **Frontmatter must be valid YAML: wrap any
  `title` / `description` value containing a colon (or a leading `@`, backtick, or other YAML-special
  character) in quotes.** An unquoted `:` followed by a space is parsed as a nested mapping, so the page fails to
  build and Mintlify serves it as a 404. Single and double quotes are both valid YAML, and Prettier
  normalizes them to single quotes when the pre-commit hook formats the page. `mint broken-links` does
  NOT catch this (it only checks links); only a full build does, so verify with `mint dev` before
  opening a PR, or run the standalone `check-frontmatter` script below. The extension is irrelevant:
  the same frontmatter breaks `.md` and `.mdx` identically, so never "fix" a broken page by renaming it.
- **Never put a bare `%` in a body heading.** Mintlify URI-decodes headings to build their anchor
  slugs, so a `%` that isn't valid percent-encoding raises `URIError: URI malformed` and fails the
  whole page. This is the mirror image of the frontmatter bug above: `mint broken-links` _does_
  surface it, while a `mint dev` build can render straight past it, so run both. A `%` in ordinary
  prose is harmless (26 pages have one); only a heading trips it. Reword the heading instead.
- `docs.json`: theme, settings and the seven-tab navigation (Get started, Use Clawboo, Runtimes,
  How it works, Reference, Help, Contribute). Hand-maintained: when you add a page, add its path to
  the right group's `pages` array. When you rename, move or delete a page, add a `redirects` entry
  so old links keep working.
- `images/`: screenshots, referenced by pages as `/images/<name>`.
- `logo/`, `favicon.svg`: brand assets referenced by `docs.json`.
- `scripts/`: the frontmatter checker below. Not part of the deployed site.
- There is no hand-written `llms.txt`. Mintlify generates `/llms.txt`, `/llms-full.txt` and a docs
  MCP server from the pages and their `description` frontmatter, so keep descriptions accurate.

## Editing

Edit the `.md` files directly and open a PR. On merge to `main`, Mintlify redeploys
[docs.claw.boo](https://docs.claw.boo) automatically (no build step). Outside contributors can use
the per-page "Suggest edits" link (it opens the file on GitHub) or fork, edit, and open a PR.

```bash
# preview locally (needs the Mintlify CLI: npm i -g mint, or use npx mint)
mint dev --port 3111          # or: pnpm --filter @clawboo/docs dev

# validate internal links (add --check-anchors to also check #anchors)
mint broken-links             # or: pnpm --filter @clawboo/docs check-links

# validate docs.json and run a strict build
mint validate

# validate every page's YAML frontmatter (no Mintlify CLI, no build, no network)
pnpm check:docs               # from the repo root; or, from anywhere:
                              # pnpm --filter @clawboo/docs check-frontmatter
```

`check-frontmatter` (`scripts/check-frontmatter.mjs`) is this package's `lint` script, so it also
runs under `pnpm lint` and in CI's Lint job on every PR. It enforces both rules above, the
frontmatter one and the heading `%` one, which is the point: no CI job runs Mintlify itself, so
without it neither rule is checked before a page deploys. It is not a substitute for the real
tools, though: `mint dev` and `mint broken-links` each still catch strictly more.

If `npx mint` hangs on first run behind a flaky network, prefix with
`NODE_OPTIONS='--dns-result-order=ipv4first --no-network-family-autoselection'`.

## Writing rules

- Write for two readers without mixing them: people who use the dashboard (who may not code) and
  people who self-host, integrate or contribute. User pages use the app's own labels and plain words;
  identifiers, routes and file paths belong in Reference and Contribute pages.
- Only write what the code does today, and verify every number. Do not stamp release versions on
  pages: the docs track `main`, and the changelog's Unreleased section lists what is not on npm yet.
- Keep the honest limits: budgets warn by default and hard caps are opt-in; only some work is
  verified; Claude Code, Codex and Hermes run with their own sandboxes off and a worktree is not a
  sandbox; prompts go to the providers you connect.
- No em dashes. State current behavior instead of narrating history; old names go in the glossary
  and in frontmatter `keywords`.
- Explain each topic once on its canonical page and link to it from elsewhere.

## Notes

- These pages are **Mintlify-flavored** (callout components + root-relative links), not portable
  GitHub-flavored Markdown, so they render best on the Mintlify site rather than in the GitHub file view.
- `pnpm build` here is a deliberate no-op: Mintlify deploys this directory directly, so there is
  nothing to build.
