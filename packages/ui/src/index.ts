// Shared UI utilities and design tokens for Clawboo.
// shadcn/ui components are initialized per-app with: npx shadcn@latest init
// This package exports shared utilities used across apps.

export { BooAvatar } from './BooAvatar'
export type { BooAvatarProps } from './BooAvatar'
// Re-export so consumers can derive an agent's tint without adding a direct
// `@clawboo/boo-avatar` dependency (the ui package already depends on it).
export { resolveBooTint, TINTS } from '@clawboo/boo-avatar'
export { cn } from './utils'
export { cva } from 'class-variance-authority'
export type { VariantProps } from 'class-variance-authority'

// Design tokens (CSS custom property names)
export const tokens = {
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
