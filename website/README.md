# Clawboo website

The marketing site for Clawboo, served at [www.claw.boo](https://www.claw.boo). A standalone Astro project (it is intentionally not part of the pnpm workspace) so it builds and deploys on its own.

## Stack

- Astro 5, static output, no SSR adapter.
- React islands (`@astrojs/react`) for the day-sky atmosphere and the live Boo squad, the only hydrated components.
- Tailwind CSS v4 via `@tailwindcss/vite`, sharing the product's exact design tokens.
- Everything else (typed terminal, scroll-reveal, theme toggle, star count, copy buttons) is dependency-free vanilla JS.

## Develop

```bash
cd website
pnpm install
pnpm dev        # Astro dev server
pnpm build      # static build into dist/
pnpm preview    # serve the built site
pnpm check      # astro type-check
```

## Brand reuse

The site shares the product's brand so it reads identically:

- `src/lib/boo-avatar.ts` is vendored from `packages/boo-avatar/src/index.ts` (the procedural ghost-lobster generator).
- `src/components/atmosphere/SkyAtmosphere.tsx` and `BackgroundBoos.tsx` are vendored from `apps/web/src/features/atmosphere/` (the day-sky backdrop). `BackgroundBoos` carries one local edit, an inline `BooAvatar` over the vendored generator, so no workspace dependency is needed.
- `src/styles/tokens.css` is the product's `:root` (light) and `.dark` token blocks from `apps/web/src/app/globals.css`.
- Favicons, the logo, the OG card, the Geist Mono woff2, and the product screenshots are copied into `public/` and `src/assets/`.

Re-sync the copied assets with `scripts/sync-brand.sh`. The vendored TypeScript and CSS sources are hand-maintained; re-copy them by hand if the product versions change, preserving the local edits each file documents.

## Deploy (Cloudflare Pages)

- Connect the repo and set the project Root directory to `website`.
- Build command: `pnpm install --frozen-lockfile && pnpm build`.
- Build output directory: `dist`.
- Node version: 22.

Because the project is standalone, Cloudflare Pages installs only this folder's dependencies and never builds the monorepo. `public/_headers` sets caching and security headers; the apex to www redirect is configured as a Cloudflare redirect rule.

## Conventions

Copy uses no em dashes, no personal emails (the contact alias is conduct@claw.boo), and every claim matches the shipped v0.2.0 surface.
