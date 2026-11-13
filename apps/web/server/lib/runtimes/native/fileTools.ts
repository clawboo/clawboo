// Built-in file tools for the native runtime — the runtime's PRIVATE plane
// (every coding runtime ships its own file primitives; the shared MCP spine
// carries coordination, not workspace edits). Strictly jailed to the run's cwd
// (a task worktree, or the team's folder): every path resolves under it, on disk
// as well as by name, or the call is rejected, so a model cannot read or write
// outside it. No cwd ⇒ no file tools.

import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  agentList,
  agentMkdir,
  agentReadFile,
  agentStat,
  agentWriteFile,
} from '../../agentUser/agentFs'
import { isAgentUserMode } from '../../agentUser/config'

export interface NativeToolOutcome {
  output: string
  isError: boolean
  /** Set (to the reason) when a call was DENIED by policy: either the tools
   *  broker refusing a brokered MCP call, or a LOCAL tool that gates itself. The
   *  conversation surfaces it as a non-fatal `policy_denied` signal so the host's
   *  circuit breaker can trip on repeated denials. The three file tools never set
   *  it; they are confined by `resolveJailed` rather than by a decision. */
  denied?: string
}

/**
 * What a local tool is handed when it runs.
 *
 * ONLY THE RUN'S ABORT, for now. Local tools are dispatched directly rather than
 * through the broker, so nothing in that path could previously see a Stop. That
 * is harmless for the file tools, which complete in microseconds, and not
 * harmless at all for a tool that spawns a child: without the signal the child
 * outlives the Stop, the budget kill switch, a breaker trip and the drain guard,
 * while the run itself reports `aborted`.
 */
export interface NativeLocalToolContext {
  signal: AbortSignal
}

/** Provider-neutral tool definition (JSON Schema args) + its local executor. */
export interface NativeLocalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** `ctx` is optional so the file tools, which ignore it, need no change. */
  run(args: Record<string, unknown>, ctx?: NativeLocalToolContext): Promise<NativeToolOutcome>
}

const READ_CAP_BYTES = 64 * 1024

/** Resolve `rel` under `cwd`; null when it escapes the jail. */
export function resolveJailed(cwd: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null
  if (path.isAbsolute(rel)) return null
  const resolved = path.resolve(cwd, rel)
  const root = path.resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * `resolveJailed`, then the same answer on disk: the target may not be a symlink,
 * and following every symlink above it must still land inside the cwd. The cwd
 * can be shared (a team folder that Claude Code or Codex also write to), so a
 * link planted there would otherwise carry these tools anywhere the user can
 * reach. Checked, not locked: a link swapped in between this check and the read
 * or write is not caught.
 */
export async function resolveJailedOnDisk(cwd: string, rel: string): Promise<string | null> {
  const lexical = resolveJailed(cwd, rel)
  if (!lexical) return null
  let realRoot: string
  try {
    realRoot = await realpath(cwd)
  } catch {
    return null
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  try {
    if ((await lstat(lexical)).isSymbolicLink()) return null
  } catch {
    // Missing: a file about to be written. Its nearest existing parent decides.
  }
  for (let probe = lexical; ; probe = path.dirname(probe)) {
    try {
      const real = await realpath(probe)
      return real === realRoot || real.startsWith(prefix) ? lexical : null
    } catch {
      if (path.dirname(probe) === probe) return null
    }
  }
}

const err = (message: string): NativeToolOutcome => ({ output: message, isError: true })

const OUTSIDE = 'path must be a relative path inside the workspace'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// WITH AGENTS ON THEIR OWN OS USER (CLAWBOO_AGENT_USER) the run folder belongs to
// that user, and the server never reads, writes or lists in it as itself: the
// tools below ask the agent host, which runs as the agent user. The model loop
// stays here; only the file access moves.
//
// The jail is the same lexical one (`resolveJailed`: relative, no way out of
// the run folder by name). The on-disk half is not repeated: a link inside the
// folder can only take the host where the agent user could go anyway, and the
// server could not resolve real paths in a folder it cannot enter. The last
// component is still never followed: a link there is refused, as it is locally.

async function readInAgentSpace(cwd: string, rel: string): Promise<NativeToolOutcome> {
  const target = resolveJailed(cwd, rel)
  if (!target) return err(OUTSIDE)
  try {
    const info = await agentStat(target)
    if (!info) return err(`ENOENT: no such file or directory, stat '${target}'`)
    if (info.type === 'link') return err(OUTSIDE)
    if (info.type !== 'file') return err('not a file')
    // Enough bytes for READ_CAP_BYTES characters of any UTF-8 text (at most four
    // bytes each), then cut by characters below as the local read is.
    const buf = await agentReadFile(target, { maxBytes: READ_CAP_BYTES * 4 })
    if (!buf) return err(`ENOENT: no such file or directory, open '${target}'`)
    const body = buf.toString('utf8')
    return body.length > READ_CAP_BYTES || buf.length < info.size
      ? {
          output: `${body.slice(0, READ_CAP_BYTES)}\n…[truncated at ${READ_CAP_BYTES} bytes]`,
          isError: false,
        }
      : { output: body, isError: false }
  } catch (e) {
    return err(errorText(e))
  }
}

async function writeInAgentSpace(
  cwd: string,
  rel: string,
  content: string,
): Promise<NativeToolOutcome> {
  const target = resolveJailed(cwd, rel)
  if (!target) return err(OUTSIDE)
  try {
    const existing = await agentStat(target)
    if (existing?.type === 'link') return err(OUTSIDE)
    if (existing && existing.type !== 'file') {
      return err(`EISDIR: illegal operation on a directory, open '${target}'`)
    }
    // Only a missing folder is made: making one that exists would also reset
    // its mode.
    const dir = path.dirname(target)
    if (!existing && !(await agentStat(dir))) await agentMkdir(dir)
    // The write replaces the file with a new one, so carry the old one's mode
    // over (an executable script stays executable).
    await agentWriteFile(target, content, existing ? { mode: existing.mode & 0o777 } : {})
    return { output: `wrote ${path.relative(cwd, target)}`, isError: false }
  } catch (e) {
    return err(errorText(e))
  }
}

async function listInAgentSpace(cwd: string, rel: string): Promise<NativeToolOutcome> {
  const target = resolveJailed(cwd, rel)
  if (!target) return err(OUTSIDE)
  try {
    const info = await agentStat(target)
    if (!info) return err(`ENOENT: no such file or directory, scandir '${target}'`)
    if (info.type === 'link') return err(OUTSIDE)
    if (info.type !== 'dir') return err(`ENOTDIR: not a directory, scandir '${target}'`)
    const { entries, truncated } = await agentList(target)
    const lines = entries
      .map((e) => `${e.type === 'dir' ? 'dir ' : 'file'} ${e.name}`)
      .sort()
      .join('\n')
    const more = truncated ? `\n…[only the first ${entries.length} entries]` : ''
    return { output: (lines || '(empty)') + more, isError: false }
  } catch (e) {
    return err(errorText(e))
  }
}

export function buildFileTools(cwd: string | null): NativeLocalTool[] {
  if (!cwd) return []

  return [
    {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the working directory. Path is relative to the workspace root.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path of the file to read.' } },
        required: ['path'],
      },
      async run(args) {
        if (isAgentUserMode()) return readInAgentSpace(cwd, String(args['path'] ?? ''))
        const target = await resolveJailedOnDisk(cwd, String(args['path'] ?? ''))
        if (!target) return err('path must be a relative path inside the workspace')
        try {
          const info = await stat(target)
          if (!info.isFile()) return err('not a file')
          const body = await readFile(target, 'utf8')
          return body.length > READ_CAP_BYTES
            ? {
                output: `${body.slice(0, READ_CAP_BYTES)}\n…[truncated at ${READ_CAP_BYTES} bytes]`,
                isError: false,
              }
            : { output: body, isError: false }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    },
    {
      name: 'write_file',
      description:
        'Write a UTF-8 text file in the working directory (creates parent directories). Path is relative to the workspace root.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
      },
      async run(args) {
        if (isAgentUserMode()) {
          return writeInAgentSpace(cwd, String(args['path'] ?? ''), String(args['content'] ?? ''))
        }
        const target = await resolveJailedOnDisk(cwd, String(args['path'] ?? ''))
        if (!target) return err('path must be a relative path inside the workspace')
        try {
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, String(args['content'] ?? ''), 'utf8')
          return { output: `wrote ${path.relative(cwd, target)}`, isError: false }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    },
    {
      name: 'list_files',
      description:
        'List entries of a directory in the working directory (default: the workspace root).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (default ".").' },
        },
      },
      async run(args) {
        const rel =
          typeof args['path'] === 'string' && args['path'] ? (args['path'] as string) : '.'
        if (isAgentUserMode()) return listInAgentSpace(cwd, rel)
        const target = await resolveJailedOnDisk(cwd, rel)
        if (!target) return err('path must be a relative path inside the workspace')
        try {
          const entries = await readdir(target, { withFileTypes: true })
          const lines = entries
            .map((e) => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`)
            .sort()
            .join('\n')
          return { output: lines || '(empty)', isError: false }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    },
  ]
}
