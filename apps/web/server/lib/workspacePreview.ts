// Serve the artifact an agent built, straight out of the task's worktree.
//
// This is the "show me the thing" half of the workspace view: the tree and the
// diff say what changed, this renders the result. It is deliberately a STATIC
// FILE server and not a dev-server proxy — clawboo never runs a build command
// the agent authored, and for a built page the two are indistinguishable to a
// viewer anyway.
//
// It reuses `resolveWorkspaceRelPath` and `openConfinedFile` verbatim rather
// than re-deriving path safety, so the confinement rules stay in one place: no
// absolute paths, no `..`, no NUL or control bytes, no backslashes, no
// symlinks, a re-check of containment after `realpath` resolves any symlinked
// ancestor, and an open that is checked again from the handle's side, so a file
// swapped for a link after the check is never served.
//
// It does NOT go through `readFileAt`. That path is tuned for the text viewer —
// a 256 KB ceiling and a binary sniff that refuses anything with a NUL in its
// first 8 KB — and a preview is mostly images, fonts and bundles. So this reads
// raw bytes under its own, larger ceiling.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  openConfinedFile,
  type ConfinedFile,
  resolveWorkspaceRelPath,
  resolveWorkspaceRoot,
  WorkspacePathError,
} from './workspaceFs'

/**
 * Drop trailing slashes in LINEAR time.
 *
 * Hand-written rather than `/\/+$/`, which backtracks polynomially: the engine
 * retries every split of a long run of slashes before failing. `MAX_REL_PATH`
 * bounds the reachable input, so this is a convention rather than a live DoS,
 * but the repo has already replaced this exact regex elsewhere for this exact
 * reason and a scanner flags every reintroduction.
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

/** Ceiling for a single previewed asset. Larger than the text viewer's 256 KB
 *  because bundles and images legitimately exceed it, bounded because this
 *  streams out of the same process that serves every dashboard read. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

/** Served when the request names a directory, matching static-server custom. */
const INDEX_FILE = 'index.html'

/**
 * Content types for what a built site actually contains.
 *
 * An allowlist rather than a lookup library on purpose: the response is served
 * same-origin from the dashboard, so the type decides what the browser will
 * EXECUTE. An unknown extension gets `application/octet-stream`, which renders
 * as a download rather than as script in clawboo's own origin.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
}

export function previewContentType(relPath: string): string {
  return CONTENT_TYPES[path.extname(relPath).toLowerCase()] ?? 'application/octet-stream'
}

export type PreviewResolution =
  | {
      ok: true
      absPath: string
      /** The real path of the workspace root `absPath` was confined to. */
      realRoot: string
      contentType: string
      size: number
      /** True when a DIRECTORY was resolved to its `index.html`. The caller must
       *  make such a URL end in `/` before serving it: a relative `href` in the
       *  page resolves against the request URL, so serving the index at
       *  `…/preview` sends every asset to `…/<taskId>/asset` instead of
       *  `…/preview/asset`, and the page renders unstyled. */
      isIndex: boolean
    }
  | { ok: false; status: 400 | 404 | 413; error: string }

/**
 * Resolve one preview request to a file on disk, or to the status it should
 * fail with. Directories (and the empty path) resolve to their `index.html`,
 * which is what makes `/preview/` serve a built site's entry point.
 */
export async function resolvePreviewFile(
  taskId: string,
  relPath: string,
): Promise<PreviewResolution> {
  const rootRes = await resolveWorkspaceRoot(taskId)
  if (!rootRes.ok) {
    return { ok: false, status: 404, error: `workspace ${rootRes.reason}` }
  }

  const wanted = relPath.replace(/^\/+/, '')
  let abs: string
  let realRoot: string
  try {
    ;({ abs, realRoot } = await resolveWorkspaceRelPath(rootRes.root, wanted || '.'))
  } catch (err) {
    if (err instanceof WorkspacePathError) return { ok: false, status: 400, error: err.message }
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, status: 404, error: 'No such file in the workspace.' }
    }
    throw err
  }

  let st = await stat(abs)
  let served = wanted
  let isIndex = false
  if (st.isDirectory()) {
    isIndex = true
    // Re-resolve through the same guard rather than joining, so the index is
    // confined on exactly the terms every other path is.
    const indexRel = wanted ? `${trimTrailingSlashes(wanted)}/${INDEX_FILE}` : INDEX_FILE
    try {
      ;({ abs, realRoot } = await resolveWorkspaceRelPath(rootRes.root, indexRel))
    } catch {
      return { ok: false, status: 404, error: 'No index.html in that directory.' }
    }
    st = await stat(abs)
    served = indexRel
  }
  if (!st.isFile()) return { ok: false, status: 404, error: 'Not a file.' }
  if (st.size > MAX_PREVIEW_BYTES) {
    return { ok: false, status: 413, error: 'That file is too large to preview.' }
  }

  return {
    ok: true,
    absPath: abs,
    realRoot,
    contentType: previewContentType(served),
    size: st.size,
    isIndex,
  }
}

export type PreviewStream =
  | {
      ok: true
      stream: Readable
      /** Bytes the stream yields: the opened file's size, for Content-Length. */
      size: number
    }
  | { ok: false; status: 400 | 404 | 413; error: string }

/**
 * Open a resolved preview file and stream it, or say what to answer instead.
 * Streamed rather than buffered so a large asset never sits in this process's
 * heap.
 *
 * Opened through `openConfinedFile`, which checks the open from the handle's
 * side: the agent can replace the file, or a folder above it, with a link
 * between `resolvePreviewFile` and this call. The stream reads from that
 * checked handle and stops at the size read from it, so it never sends more
 * than the Content-Length. A file the agent shrinks while it streams ends the
 * body early, shorter than the Content-Length said.
 *
 * A file that went away answers 404. Any other failure to open it (no
 * permission, no file descriptors left) is thrown, for the route to answer
 * 500 with the error rather than call an existing file missing.
 */
export async function openPreviewStream(
  file: Pick<Extract<PreviewResolution, { ok: true }>, 'absPath' | 'realRoot'>,
): Promise<PreviewStream> {
  let opened: ConfinedFile
  try {
    opened = await openConfinedFile(file.realRoot, file.absPath)
  } catch (err) {
    if (err instanceof WorkspacePathError) return { ok: false, status: 400, error: err.message }
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, status: 404, error: 'No such file in the workspace.' }
    }
    throw err
  }
  const { handle, size } = opened
  if (size > MAX_PREVIEW_BYTES) {
    await handle.close()
    return { ok: false, status: 413, error: 'That file is too large to preview.' }
  }
  if (size === 0) {
    await handle.close()
    return { ok: true, stream: Readable.from([]), size }
  }
  // autoClose (the default) closes the handle when the stream ends or fails.
  return { ok: true, stream: handle.createReadStream({ start: 0, end: size - 1 }), size }
}
