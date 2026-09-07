/**
 * Central site config: canonical URLs, nav, and shared copy constants.
 * Copy law: no em dashes; claims match the shipped v0.3.1 surface only.
 */

export const REPO = 'clawboo/clawboo'

export const links = {
  github: 'https://github.com/clawboo/clawboo',
  stargazers: 'https://github.com/clawboo/clawboo/stargazers',
  discussions: 'https://github.com/clawboo/clawboo/discussions',
  issues: 'https://github.com/clawboo/clawboo/issues',
  npm: 'https://www.npmjs.com/package/clawboo',
  docs: 'https://docs.claw.boo',
  quickstart: 'https://github.com/clawboo/clawboo#quickstart',
  contributing: 'https://github.com/clawboo/clawboo/blob/main/CONTRIBUTING.md',
  security: 'https://github.com/clawboo/clawboo/blob/main/SECURITY.md',
  conduct: 'mailto:conduct@claw.boo',
} as const

export const site = {
  name: 'Clawboo',
  wordmark: 'clawboo',
  url: 'https://www.claw.boo',
  domain: 'www.claw.boo',
  install: 'npm install -g clawboo',
  tryInstall: 'npx clawboo@latest',
  version: 'v0.3.1',
  tagline: 'Run your coding agents as one team.',
  subhead:
    'Claude Code, Codex, Hermes and OpenClaw on one shared board, in one chat, with one memory. Native agents are built in, so you can paste a key and start.',
  description:
    'Deploy a team of AI agents and watch them collaborate live. Native agents are built in, and Claude Code, Codex, Hermes, and OpenClaw join as peer teammates in one chat. Open-source, MIT, local-first. Install with npm install -g clawboo, or run npx clawboo@latest.',
} as const

export const nav = [
  { label: 'How it works', href: '#how' },
  { label: 'Runtimes', href: '#runtimes' },
  { label: 'Trust', href: '#trust' },
  { label: 'FAQ', href: '#faq' },
] as const

/** The 10 brand tints, in display order (index 0 = reserved Boo Zero red). */
export const TINTS = [
  '#ff4d4d',
  '#34D399',
  '#FBBF24',
  '#60A5FA',
  '#A78BFA',
  '#F472B6',
  '#38BDF8',
  '#FB923C',
  '#A3E635',
  '#FB7185',
] as const
