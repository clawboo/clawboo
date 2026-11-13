// The agent host protocol: what the server and the agent host say to each other.
//
// With CLAWBOO_AGENT_USER set, one long-lived process, the agent host, runs as
// that user for the whole life of the server. Everything the server used to do
// itself in agent space (start a runtime, run an approved command, read or write
// a file in a work folder) becomes a request to it.
//
// Frames are one JSON object per line, over the host's stdin and stdout when the
// server started it through sudo, or over a Unix socket when a container
// launcher started it. This file is shared by both ends and uses nothing but the
// language, so the host bundle stays free of dependencies.
//
// TRUST. The host runs as the agent user, so an agent can trace it, kill it or
// forge its replies. The server therefore treats every reply as data, the way it
// treats a runtime's stdout: bounded in size, checked in shape, never executed.
// The host trusts the server, which is the more privileged side.

/** Bumped on any change a peer of the other version would misread. */
export const AGENT_HOST_PROTOCOL_VERSION = 1

/**
 * The longest line either side accepts. A frame carries at most one chunk of a
 * child's output or one bounded file read, base64-encoded; anything longer is a
 * broken or hostile peer, and buffering it would let the agent side grow the
 * server's memory without limit.
 */
export const MAX_FRAME_CHARS = 16 * 1024 * 1024

/** The most a single file read may return. */
export const MAX_READ_BYTES = 8 * 1024 * 1024

/** The most a single file write may carry. */
export const MAX_WRITE_BYTES = 8 * 1024 * 1024

/** What the host says first, before any request. */
export interface HelloFrame {
  t: 'hello'
  v: number
  uid: number
  gid: number
  user: string
  home: string
  pid: number
  platform: string
}

export type StdioMode = 'pipe' | 'ignore'

/** Server to host: the requests. Every one is answered by one `res`. */
export type HostRequest =
  | { op: 'ping' }
  | {
      op: 'spawn'
      proc: string
      command: string
      args: string[]
      cwd?: string
      env: Record<string, string>
      stdio: [StdioMode, StdioMode, StdioMode]
      /** Start the child as a process-group leader (POSIX). */
      group: boolean
    }
  | { op: 'signal'; proc: string; signal: string }
  | { op: 'killTree'; proc: string; graceMs: number }
  | { op: 'fs.read'; path: string; maxBytes: number; offset?: number }
  | { op: 'fs.write'; path: string; data: string; mode: number }
  /** Append to a file, creating it with `mode`; never through a link at the path's end. */
  | { op: 'fs.append'; path: string; data: string; mode: number }
  | { op: 'fs.mkdir'; path: string; mode: number }
  | { op: 'fs.rm'; path: string }
  | { op: 'fs.rename'; from: string; to: string }
  | { op: 'fs.stat'; path: string }
  | { op: 'fs.list'; path: string; max: number }
  | { op: 'probe'; checks: ProbeCheck[] }
  | { op: 'procView'; pid: number }
  | { op: 'inodes'; root: string; targets: InodeRef[]; maxEntries: number }
  | { op: 'sudoList' }
  | { op: 'canExec'; paths: string[] }

export type HostOp = HostRequest['op']

export interface ProbeCheck {
  path: string
  /** `read` opens the file for reading; `list` reads the folder's entries;
   *  `write` creates, writes, lists and removes a file inside the folder. */
  mode: 'read' | 'list' | 'write'
}

export interface ProbeResult {
  path: string
  mode: ProbeCheck['mode']
  ok: boolean
  /** The error code when it failed (`EACCES`, `ENOENT`, ...). */
  code?: string
}

/** A file's device and inode, as decimal strings: an inode number can pass
 *  2^53 on some filesystems, where a JSON number would lose it. */
export interface InodeRef {
  dev: string
  ino: string
}

export interface FsStat {
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtimeMs: number
  mode: number
  uid: number
  nlink: number
}

export interface FsEntry {
  name: string
  type: FsStat['type']
  size: number
  mtimeMs: number
}

/** What each request's successful reply carries, by op. */
export interface HostReplies {
  ping: Record<string, never>
  spawn: { pid: number }
  signal: { delivered: boolean }
  killTree: Record<string, never>
  'fs.read': { missing: true } | { missing: false; data: string; size: number; truncated: boolean }
  'fs.write': Record<string, never>
  'fs.append': Record<string, never>
  'fs.mkdir': Record<string, never>
  'fs.rm': Record<string, never>
  'fs.rename': Record<string, never>
  'fs.stat': { stat: FsStat | null }
  'fs.list': { entries: FsEntry[]; truncated: boolean }
  probe: { results: ProbeResult[] }
  procView: {
    /** Linux: whether `/proc/<pid>/environ` could be read, and what it held. */
    environ: { ok: boolean; code?: string; text?: string }
    /** The command line as another user sees it (`/proc/<pid>/cmdline` or `ps`). */
    cmdline: { ok: boolean; code?: string; text?: string }
    /** macOS: `ps -E -ww -p <pid>`, which shows the environment to whoever may see it. */
    psEnv: { ok: boolean; code?: string; text?: string }
  }
  inodes: { matches: string[]; truncated: boolean }
  sudoList: { ran: boolean; exitCode: number | null; stdout: string; stderr: string; code?: string }
  canExec: { results: { path: string; ok: boolean; code?: string }[] }
}

/** A reply frame. `ok: false` carries an error code and message. */
export type ResFrame =
  | ({ t: 'res'; id: number; ok: true } & Record<string, unknown>)
  | { t: 'res'; id: number; ok: false; code: string; message: string }

/** Host to server: what a started process does. */
export type ProcEventFrame =
  | { t: 'ev'; proc: string; ev: 'out' | 'err'; data: string }
  | { t: 'ev'; proc: string; ev: 'exit' | 'close'; code: number | null; signal: string | null }
  | { t: 'ev'; proc: string; ev: 'error'; code: string; message: string }

/** Server to host: a started process's stdin. No reply. */
export type StdinFrame = { t: 'in'; proc: string; data: string } | { t: 'in-end'; proc: string }

export type ReqFrame = { t: 'req'; id: number } & HostRequest

export type HostToServerFrame = HelloFrame | ResFrame | ProcEventFrame
export type ServerToHostFrame = ReqFrame | StdinFrame

/**
 * Split a byte stream into lines, refusing any line longer than the limit.
 *
 * `onLine` gets each complete line without its newline. `onOverflow` is called
 * once, and nothing further is delivered, when a line grows past `maxChars`
 * before its end: the peer is broken or hostile, and the caller ends the
 * connection.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxChars = MAX_FRAME_CHARS,
): (chunk: string) => void {
  let buf = ''
  let dead = false
  return (chunk: string) => {
    if (dead) return
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.length > maxChars) {
        dead = true
        buf = ''
        onOverflow()
        return
      }
      if (line.length > 0) onLine(line)
    }
    if (buf.length > maxChars) {
      dead = true
      buf = ''
      onOverflow()
    }
  }
}

/** One frame as a line. */
export function encodeFrame(frame: HostToServerFrame | ServerToHostFrame): string {
  return JSON.stringify(frame) + '\n'
}

/** An object, or null when the line is not one. */
export function parseFrame(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The process-name part of an error's code, or a generic one. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'EUNKNOWN'
}
