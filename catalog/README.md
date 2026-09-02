# The Clawboo marketplace catalog

Agent and team content, kept apart from the product code that renders it.

`catalog/` is a plain content folder. It is **not** a pnpm workspace member and
it is **not** part of any turbo task, on purpose: adding a pack must not put a
content pull request through `turbo lint`, `turbo typecheck` and `turbo test`.
That separation is the whole reason this folder exists, and the same posture
`website/` already has.

## Layout

```
catalog/
  catalog.config.json                 which packs exist, and where the index is served
  schema/pack.schema.json             the PUBLIC pack specification (JSON Schema 2020-12)
  schema/index.schema.json            the PUBLIC browse-index specification
  packs/<publisher>/<slug>/
    pack.json                         manifest + listings (each listing points at a body)
    agents/<slug>.json                one agent document set: SOUL.md, IDENTITY.md, TOOLS.md
    teams/<slug>.json                 one team body: workflow narrative + per-member routing
    NOTICE.md                         required when provenance.repo is set
  dist/v1/index.json                  GENERATED, COMMITTED - the browse index
  dist/v1/packs/<publisher>/<slug>/<version>.json
                                      GENERATED, COMMITTED - one self-contained bundle per pack
```

## Two commands

```bash
pnpm catalog:build    # packs/** -> dist/** and the compiled seed
pnpm catalog:verify   # every content rule, then "is dist/ current?"
```

`catalog:verify` is what CI runs. It fails if any rule is broken **or** if the
committed `dist/` and the compiled seed are not exactly what `catalog:build`
would write, so a hand-edited artifact cannot ship.

## Why `dist/` is committed

It is what makes the fallback URL work with no infrastructure at all. A raw
`githubusercontent.com` URL against `main` serves the same bytes a CDN would,
so there is no deploy step between merging a pack and it being installable.

The bytes are **canonical**: keys sorted, no insignificant whitespace, LF, and
no trailing newline. Those exact bytes are what gets written, served, and
hashed. Prettier never touches them (`.prettierignore` already matches
`**/dist/`), and a formatter anywhere in that chain would invalidate every
published `integrity` value. See the comment at the top of
`scripts/catalog/lib/hash.ts` for why this rule is deliberately different from
the retired ingest manifest's.

## The index is mutable, each row is immutable

`dist/v1/index.json` is rewritten on every build. Each `packs[]` row inside it
names one immutable bundle by version and carries its `integrity`. The
integrity value is the trust anchor, not the URL: a client recomputes the digest
over the bytes it received and compares **before** parsing them.

## The seed

One pack - the one named by `seed` in `catalog.config.json` - is compiled into
the app rather than fetched. First-run onboarding renders with
`allowStartFromScratch={false}`, so an empty catalog is not degraded, it is
unrecoverable. The builtin teams therefore ship in the binary, and the index
endpoint merges them unconditionally.

`scripts/catalog/build-seed.ts` generates it into
`apps/web/src/features/marketplace/seed/` and `apps/web/server/lib/catalogSeed.ts`.
Both are generated and committed. Never edit them by hand.

## Adding a pack

See the "Contributing a marketplace pack" section of `CONTRIBUTING.md`, and
`docs/reference/marketplace-catalog.md` for the format itself.
