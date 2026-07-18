// UI-driven "Sign in with ChatGPT" — the PURE half of the CLI-login relay.
//
// clawboo's LOCAL server spawns the OFFICIAL CLI's login command and relays its
// USER-FACING output (device codes / auth URLs — meant for the user by design)
// to the web UI. The OAuth exchange stays entirely inside the vendor CLI; the
// human still authorizes in their browser on openai.com; clawboo never reads,
// refreshes, or stores tokens. The manual copy-the-command affordance remains
// the fallback everywhere (unsupported platform / spawn failure).
//
// SECURITY: every plan below is spawn() ARGV — no exec(), no `shell: true`
// anywhere in this path. No user input reaches an argument: binary paths come
// from `resolveRuntimeBin` (filesystem resolution), every other token is a
// compile-time constant. The one composed string is util-linux `script -c`'s
// OWN contract (it takes a single command string); the interpolated binary
// path is quote-validated and the rest is constants.
//
// Per-tool ground truth (pinned from the INSTALLED CLIs' source — see CLAUDE.md
// "UI-driven ChatGPT sign-in"):
// - codex 0.136: `codex login` (browser-PKCE) is headless-spawnable — no TTY
//   guard, never reads stdin, waits only on its localhost:1455 callback, opens
//   the browser itself, and prints the auth URL as a fallback line. (The
//   `--device-auth` variant exists but can be ACCOUNT-gated — browser is primary.)
// - hermes 0.15.2: `hermes auth add openai-codex --type oauth` is the REAL flow
//   (`hermes login` is a dead stub) — no TTY check, no prompts. MUST spawn with
//   PYTHONUNBUFFERED=1: CPython block-buffers pipes, so without it the device
//   code sits invisible in the buffer for the whole 15-minute poll. Its codex
//   login is hard-wired to the DEVICE flow (`_codex_device_code_login()`, no
//   browser variant; `--no-browser`/`--manual-paste` are inert for codex) —
//   which is ACCOUNT-GATED by ChatGPT's "device code authorization" security
//   setting. The UI carries the Settings → Security remediation.
// - openclaw 2026.5.27: `models auth login` DEFAULTS to the `oauth` method =
//   the exact `codex login` browser-PKCE flow (same client id, same
//   localhost:1455 callback, NOT account-gated) — so we spawn it WITHOUT
//   `--device-code` (the device method hits the same gated deviceauth
//   endpoints as hermes). It auto-opens the browser, completes with zero
//   stdin on the happy path, and prints the parseable line `Open: <url>`.
//   Slow sign-ins (>16 s) drop a clack paste-prompt that idles harmlessly
//   under our PTY while the 1455 callback keeps racing (pi-ai races both) —
//   completion is store-probe-driven in cliLogin.ts, never prompt-dependent.
//   The command has a hard `process.stdin.isTTY` guard (no bypass flag) — so
//   it is wrapped in the OS `script` PTY allocator (BSD and util-linux arg
//   orders differ; both handled below). Windows has no `script`/PTY without
//   a native dep (node-pty is deliberately NOT added — `npx clawboo` install
//   reliability) → UNSUPPORTED there; the UI degrades to the copy-command.

import path from 'node:path'

import { resolveRuntimeBin } from '../platform'
import { buildChildEnv } from './childEnv'

export type CliLoginTool = 'codex' | 'hermes' | 'openclaw'

export const CLI_LOGIN_TOOLS: readonly CliLoginTool[] = ['codex', 'hermes', 'openclaw'] as const

export function isCliLoginTool(v: unknown): v is CliLoginTool {
  return typeof v === 'string' && (CLI_LOGIN_TOOLS as readonly string[]).includes(v)
}

export interface CliLoginPlan {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** The manual fallback command shown to the user (what we spawn, minus wrappers). */
  displayCommand: string
}

export type CliLoginPlanResult =
  | { ok: true; plan: CliLoginPlan }
  | { ok: false; code: 'NOT_INSTALLED' | 'UNSUPPORTED_PLATFORM'; message: string }

/** The manual terminal command per tool (the copy-fallback + display string). */
export const CLI_LOGIN_COMMANDS: Record<CliLoginTool, string> = {
  codex: 'codex login',
  hermes: 'hermes auth add openai-codex',
  openclaw: 'openclaw models auth login --provider openai-codex',
}

/**
 * Build the spawn plan for a tool's login. Pure given (tool, platform, resolver)
 * — unit-testable without spawning anything. `resolveBin` defaults to the real
 * PATH+user-dirs resolver.
 */
export function buildCliLoginPlan(
  tool: CliLoginTool,
  platform: NodeJS.Platform = process.platform,
  resolveBin: (name: string) => string | null = resolveRuntimeBin,
): CliLoginPlanResult {
  if (tool === 'codex') {
    const bin = resolveBin('codex')
    if (!bin) return notInstalled('codex')
    return {
      ok: true,
      plan: {
        command: bin,
        args: ['login'],
        env: buildChildEnv(),
        displayCommand: CLI_LOGIN_COMMANDS.codex,
      },
    }
  }

  if (tool === 'hermes') {
    const bin = resolveBin('hermes')
    if (!bin) return notInstalled('hermes')
    const binDir = path.dirname(bin)
    return {
      ok: true,
      plan: {
        command: bin,
        args: ['auth', 'add', 'openai-codex', '--type', 'oauth'],
        env: buildChildEnv({
          // LOAD-BEARING: without this, CPython block-buffers the piped stdout
          // and the device code stays invisible for the entire 15-minute poll.
          PYTHONUNBUFFERED: '1',
          // The hermes bin dir is often off the server's PATH (Python user-site).
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        }),
        displayCommand: CLI_LOGIN_COMMANDS.hermes,
      },
    }
  }

  // openclaw — needs a PTY (hard stdin.isTTY guard in `models auth login`).
  if (platform === 'win32') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      message:
        'The OpenClaw sign-in needs a terminal on Windows. Run the command below in your own terminal, then re-check.',
    }
  }
  const bin = resolveBin('openclaw')
  if (!bin) return notInstalled('openclaw')
  // NO --device-code: the default `oauth` method is the ungated browser-PKCE
  // flow (see the header ground truth).
  const loginArgs = ['models', 'auth', 'login', '--provider', 'openai-codex']
  const env = buildChildEnv({
    // The clack note box sizes itself off stdout columns; keep it wide enough
    // that the URL/Code lines never wrap mid-token under the script PTY.
    COLUMNS: '120',
  })
  if (platform === 'darwin') {
    // BSD script: `script -q /dev/null <command> [args…]` — plain argv.
    return {
      ok: true,
      plan: {
        command: 'script',
        args: ['-q', '/dev/null', bin, ...loginArgs],
        env,
        displayCommand: CLI_LOGIN_COMMANDS.openclaw,
      },
    }
  }
  // util-linux script takes ONE command string (`-c`) by contract. The only
  // interpolation is the RESOLVED binary path (never user input), single-quoted;
  // a path containing a quote is rejected outright rather than escaped.
  if (bin.includes("'")) return notInstalled('openclaw')
  return {
    ok: true,
    plan: {
      command: 'script',
      args: ['-qec', `'${bin}' ${loginArgs.join(' ')}`, '/dev/null'],
      env,
      displayCommand: CLI_LOGIN_COMMANDS.openclaw,
    },
  }
}

function notInstalled(name: string): CliLoginPlanResult {
  return {
    ok: false,
    code: 'NOT_INSTALLED',
    message: `The ${name} CLI isn't installed yet. Install it first, then sign in.`,
  }
}

// ─── Output parsing ──────────────────────────────────────────────────────────

/** Strip ANSI escape sequences + clack box-drawing chrome so lines are parseable
 *  and readable in the UI terminal. ESC-anchored (CSI, then OSC, then any stray
 *  escape) so bracketed PROSE without an escape byte survives intact. */
export function stripAnsi(line: string): string {
  return (
    line
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b./g, '')
      // clack/box-drawing frame characters (openclaw's note box) + stray CRs.
      .replace(/[│┌┐└┘├┤─╭╮╰╯◆◇●○\r]/g, ' ')
      .trimEnd()
  )
}

export interface CliLoginSignal {
  /** A device-code flow surfaced its user code (hermes / openclaw). */
  deviceCode?: { url: string; code: string }
  /** A browser flow surfaced its auth URL (codex fallback line). */
  authUrl?: string
}

/** Stateful line parser — feed ANSI-stripped lines in order; returns a signal
 *  when one completes. The device URL is a constant in both device flows
 *  (`https://auth.openai.com/codex/device`); the CODE arrives on its own line
 *  (hermes: the line after `2. Enter this code:`; openclaw: `Code: XXXX`). */
export function createCliLoginParser(tool: CliLoginTool): (line: string) => CliLoginSignal | null {
  const DEVICE_URL = 'https://auth.openai.com/codex/device'
  let expectCode = false
  return (line: string): CliLoginSignal | null => {
    const l = line.trim()
    if (!l) return null

    if (tool === 'codex') {
      // Browser flow: relay the printed auth URL (the CLI opens the browser
      // itself; this is the click-fallback). Any auth.openai.com URL on a
      // "navigate/open" line is relayed — including the device URL on a
      // manually-forced `--device-auth` run (a clickable target either way).
      const url = /https:\/\/auth\.openai\.com\/\S+/.exec(l)?.[0]
      if (url && /navigate to this URL|open this link/i.test(l)) return { authUrl: url }
      if (url && !l.includes('/codex/device')) return { authUrl: url }
      return null
    }

    if (tool === 'openclaw') {
      // Browser-PKCE (the default method we spawn): the flow logs the authorize
      // URL as a plain `Open: <url>` line after auto-opening the browser.
      const openUrl = /^Open:\s*(https:\/\/\S+)/.exec(l)?.[1]
      if (openUrl) return { authUrl: openUrl }
      // Device-flow note lines (`Code: XXXX`) kept as belt-and-suspenders for a
      // manually-forced `--device-code` run.
      const code = /^Code:\s*(\S+)/.exec(l)?.[1]
      if (code) return { deviceCode: { url: DEVICE_URL, code } }
      return null
    }

    // hermes: `  2. Enter this code:` then the code alone on the next line.
    if (/^2\.\s*Enter this code:/.test(l)) {
      expectCode = true
      return null
    }
    if (expectCode) {
      expectCode = false
      const code = l.trim()
      if (code) return { deviceCode: { url: DEVICE_URL, code } }
    }
    return null
  }
}
