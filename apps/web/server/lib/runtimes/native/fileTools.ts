// Built-in file tools for the native runtime — the runtime's PRIVATE plane
// (every coding runtime ships its own file primitives; the shared MCP spine
// carries coordination, not workspace edits). Strictly jailed to the run's
// worktree cwd: every path resolves under it or the call is rejected, so a
// model cannot read or write outside its isolated world. No cwd ⇒ no file
// tools (research/review runs get none).

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface NativeToolOutcome {
  output: string
  isError: boolean
  /** Set (to the reason) when a brokered MCP tool call was DENIED by the tools
   *  broker. The conversation surfaces it as a non-fatal `policy_denied` signal so
   *  the host's circuit breaker can trip on repeated denials. Local file tools
   *  never set it. */
  denied?: string
}

/** Provider-neutral tool definition (JSON Schema args) + its local executor. */
export interface NativeLocalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<NativeToolOutcome>
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

const err = (message: string): NativeToolOutcome => ({ output: message, isError: true })

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
        const target = resolveJailed(cwd, String(args['path'] ?? ''))
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
        const target = resolveJailed(cwd, String(args['path'] ?? ''))
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
        const target = rel === '.' ? path.resolve(cwd) : resolveJailed(cwd, rel)
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
