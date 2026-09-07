// Derive the Workspace tab's "now line" from the obs event tail: the file the
// agent most recently touched and the command it most recently ran. Pure so it
// unit-tests without a stream. Tool inputs are runtime-specific and
// best-effort by design; a wake this misses degrades to "no activity", never
// to a wrong path.

import type { ObsLogEvent } from '@/features/obs/useObsStream'

export interface NowActivity {
  /** Most recent tool call that named a file path. */
  file: { path: string; tool: string; ts: number } | null
  /** Most recent tool call that carried a shell command. */
  command: { command: string; tool: string; ts: number } | null
}

/** Keys that unambiguously name a FILE the agent is working on. */
const FILE_PATH_KEYS = ['file_path', 'filePath', 'notebook_path'] as const

/** `path` is ambiguous: Read and Write use it for a file, but Grep and Glob use
 *  it for the DIRECTORY they search. Accepting it blindly made a repo-wide
 *  grep report as "editing packages/", outranking the file actually being
 *  edited. It counts only when the call carries no search-shaped sibling key. */
const SEARCH_SIBLING_KEYS = ['pattern', 'glob', 'query', 'output_mode'] as const

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function pickPath(input: Record<string, unknown>): string | null {
  for (const key of FILE_PATH_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  const bare = input['path']
  if (typeof bare === 'string' && bare.trim()) {
    if (SEARCH_SIBLING_KEYS.some((k) => k in input)) return null
    return bare
  }
  return null
}

function pickCommand(input: Record<string, unknown>): string | null {
  const v = input['command'] ?? input['cmd']
  return typeof v === 'string' && v.trim() ? v : null
}

/**
 * Scan the tail newest-first and keep the first file-bearing and the first
 * command-bearing tool call. A single call can carry both (some runtimes put a
 * path AND a command in one input); the path wins for the file slot and the
 * command for the command slot, independently.
 */
export function deriveNowActivity(events: readonly ObsLogEvent[]): NowActivity {
  let file: NowActivity['file'] = null
  let command: NowActivity['command'] = null
  for (let i = events.length - 1; i >= 0 && (!file || !command); i--) {
    const e = events[i]
    if (!e || e.kind !== 'tool_call') continue
    const input = asRecord(e.data['input'])
    if (!input) continue
    const tool = typeof e.data['name'] === 'string' ? (e.data['name'] as string) : 'tool'
    if (!file) {
      const p = pickPath(input)
      if (p) file = { path: p, tool, ts: e.ts }
    }
    if (!command) {
      const c = pickCommand(input)
      if (c) command = { command: c, tool, ts: e.ts }
    }
  }
  return { file, command }
}

/** Relative-path form for display and for tree invalidation: strips the
 *  workspace root prefix when the tool used an absolute path. Returns null when
 *  the path is absolute but outside the workspace (a different repo, the
 *  agent's home): the now line must not imply it happened here. */
export function toWorkspaceRelPath(p: string, workspaceRoot: string | null): string | null {
  // A `..` segment survives the prefix test below: `/w/root/../other/f` starts
  // with `/w/root/` and would be returned as `../other/f`. This is display-only
  // today, but a relative path that climbs is exactly the shape a reader would
  // later hand to a fetch.
  if (p.split('/').some((seg) => seg === '..')) return null
  if (!p.startsWith('/')) return p
  if (!workspaceRoot) return null
  const root = workspaceRoot.endsWith('/') ? workspaceRoot : `${workspaceRoot}/`
  return p.startsWith(root) ? p.slice(root.length) : null
}
