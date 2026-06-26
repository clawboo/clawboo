---
title: "@clawboo/ui"
description: Shared React UI primitives: the BooAvatar component, the cn class merger, the cva re-export, and the design-token constant.
---

- **Version** 0.1.0 · **Purity** browser-safe (React component package; ships JSX)
- **Purpose** Shared React components, the `BooAvatar`, the `cn` class merger, and the design-token constant for Clawboo's apps.
- **Workspace deps** `@clawboo/boo-avatar`
- **External deps** `class-variance-authority`, `clsx`, `tailwind-merge`; peer `react` (`^18 || ^19`)

<Note>
shadcn/ui components are NOT exported here; they are initialized per-app via `npx shadcn@latest init`. This package carries only the cross-app primitives. The single React component shipped is `BooAvatar`.
</Note>

## Public API

The barrel re-exports two symbols (`resolveBooTint`, `TINTS`) directly from `@clawboo/boo-avatar` so consumers can derive an agent's tint without adding a direct dependency on that package.

### Functions

| Export           | Signature                                                 | Contract                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cn`             | `cn(...inputs: ClassValue[]): string`                     | Merge Tailwind class strings: `twMerge(clsx(inputs))`, dedupes conflicting utility classes, last-wins.                                                                               |
| `cva`            | re-export of `class-variance-authority`'s `cva`           | Class-variance-authority factory; re-exported so consumers import it from one place.                                                                                                 |
| `resolveBooTint` | `resolveBooTint(seed: string, isBooZero = false): string` | Re-exported from `@clawboo/boo-avatar`. Deterministic FNV-1a tint from a seed; Boo Zero → `TINTS[0]`, others map into `TINTS[1..9]`. Same logic `generateBooAvatar` uses internally. |

### Components

| Export      | Signature                                       | Contract                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BooAvatar` | `BooAvatar(props: BooAvatarProps): JSX.Element` | Memoized React component. Renders `generateBooAvatar(params)` as an inline SVG, rewriting the fixed `width="100" height="92"` to the requested `size` (height auto-derived from the 100:92 aspect). Re-renders only when seed/size/accessory/eyeShape/tint change. |

### Types & interfaces

| Export           | Shape                                                           | Contract                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BooAvatarProps` | `extends BooAvatarParams { size?: number; className?: string }` | Props for `BooAvatar`. `size` defaults to `40` (px width; height auto-computed). Extends `BooAvatarParams` from `@clawboo/boo-avatar` (seed, tint, accessory, eyeShape, isBooZero). |
| `VariantProps`   | re-exported type of `class-variance-authority`                  | Inferred variant-prop type for a `cva` config.                                                                                                                                      |

### Constants

| Export   | Type                | Contract                                                                                                                                                                                                                     |
| -------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens` | `const` object      | Design tokens: CSS color hex values (`background`, `surface`, `accent`, `blue`, `mint`, `amber`, `text`, `secondary`) and font stacks (`display`, `body`, `mono`). The dark-palette source-of-record at the component layer. |
| `TINTS`  | `readonly string[]` | Re-exported from `@clawboo/boo-avatar`. The 10 Boo tint hexes; index `0` is OpenClaw red (reserved for Boo Zero), `1..9` are the per-agent palette.                                                                          |

```ts
// tokens shape
const tokens = {
  colors: {
    background: '#0A0E1A',
    surface: '#111827',
    accent: '#E94560',
    blue: '#0F3460',
    mint: '#34D399',
    amber: '#FBBF24',
    text: '#E8E8E8',
    secondary: '#6B7280',
  },
  fonts: {
    display: '"Cabinet Grotesk", sans-serif',
    body: '"DM Sans", sans-serif',
    mono: '"Geist Mono", monospace',
  },
} as const
```

<Tip>
`@clawboo/web` re-exports `cn` / `cva` / `VariantProps` from its own `src/lib/utils.ts`, so most app code imports them from `@/lib/utils` rather than directly from `@clawboo/ui`.
</Tip>

## Used by

`@clawboo/web` (`apps/web`), the only consumer. `BooAvatar` is wrapped by `AgentBooAvatar` (which auto-resolves `isBooZero`) and used in preview surfaces (CreateTeamModal, OnboardingWizard, NativeReadyStep, marketplace cards, the welcome-screen Boo-verse). `TINTS` seeds the team-color palettes (`lib/teamPalettes.ts`, `lib/resolveTeamBooColor.ts`); `cn`/`cva`/`VariantProps` are re-exported through `lib/utils.ts`.

## Source

`packages/ui/src/index.ts` (barrel) · `packages/ui/src/BooAvatar.tsx` · `packages/ui/src/utils.ts`

## See also

- [@clawboo/boo-avatar](/reference/packages/boo-avatar), source of `generateBooAvatar`, `resolveBooTint`, `TINTS`, `BooAvatarParams`
- [Design system](/internals/design-system), the runtime CSS-token system that supersedes the static `tokens` constant
- [Packages overview](/reference/packages/index)
