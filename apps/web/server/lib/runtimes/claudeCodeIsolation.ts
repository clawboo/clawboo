// What a Clawboo-run Claude Code agent reads of the operator's own Claude Code
// setup: nothing. Left to its defaults, the Agent SDK loads every settings
// source, which hands each agent the operator's `~/.claude/settings.json`
// (plugins, hooks, env, model), their `~/.claude.json` MCP servers, their
// `~/.claude/CLAUDE.md` and rules, and their auto memory for the repository a
// task worktree is cut from, read and written.
//
// Three levers, each verified against SDK 0.3.268 and its bundled CLI:
//
//   - `settingSources: ['project']` drops the user tier (and the gitignored
//     local one), so the working folder's own `.claude/settings.json`,
//     `.mcp.json` and `CLAUDE.md` still apply, as for anyone who clones the repo.
//   - The project tier walks `CLAUDE.md`, `.claude/CLAUDE.md` and
//     `.claude/rules/` up from the working folder to `/`. Clawboo's folders live
//     under `~/.clawboo`, so that walk reaches `~/.claude/CLAUDE.md` and loads it
//     as a project file. `claudeMdExcludes` cuts every directory above the
//     working folder, and the home directory itself.
//   - `autoMemoryEnabled: false`, because auto memory is not a settings source.
//
// None of this touches sign-in: an API key arrives in the env, and the CLI's own
// login lives in its credential store, which no settings source gates. Auth that
// lives in `~/.claude/settings.json` (`apiKeyHelper`, an `env` block) no longer
// applies; the same variables in Clawboo's own environment still do.

import { realpathSync } from 'node:fs'
import path from 'node:path'

/** The `query()` options that keep a run off the operator's Claude Code setup. */
export interface ClaudeCodeIsolation {
  settingSources: ['project']
  settings: { claudeMdExcludes: string[]; autoMemoryEnabled: false }
}

// The CLI matches with picomatch after turning every `\` into `/`, so a
// backslash escape is lost. A `?` stands in for any one character instead: the
// pattern can only match MORE paths at that spot, never fewer.
const GLOB_SPECIAL = /[*?[\]{}()!+@]/g
const literal = (p: string): string => p.replaceAll('\\', '/').replace(GLOB_SPECIAL, '?')

function excludesFor(dir: string): string[] {
  const d = literal(dir).replace(/\/+$/, '')
  return [`${d}/CLAUDE.md`, `${d}/.claude/CLAUDE.md`, `${d}/.claude/rules/**`]
}

/** Every directory strictly above `dir`, up to and including the root. */
function ancestors(dir: string): string[] {
  const out: string[] = []
  let cur = path.resolve(dir)
  for (;;) {
    const up = path.dirname(cur)
    if (up === cur) return out
    out.push(up)
    cur = up
  }
}

export function claudeCodeIsolation(cwd: string, home: string): ClaudeCodeIsolation {
  const bases = new Set([path.resolve(cwd)])
  try {
    bases.add(realpathSync.native(cwd))
  } catch {
    // Not there yet: the SDK reports a missing cwd itself.
  }
  const dirs = new Set([path.resolve(home)])
  for (const base of bases) for (const dir of ancestors(base)) dirs.add(dir)
  return {
    settingSources: ['project'],
    settings: {
      claudeMdExcludes: [...dirs].flatMap(excludesFor),
      autoMemoryEnabled: false,
    },
  }
}
