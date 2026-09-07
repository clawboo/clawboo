// The on-disk half of `screenshotBus`.
//
// The bus holds the newest frame per agent in memory, and that was always the
// right call for a LIVE panel: the value of a frame expires in seconds, and the
// obs log is append-only with no delete writer, so megabytes of base64 in it
// would grow the database forever.
//
// What memory alone could not do is survive a restart. Every server start wiped
// every frame, so the browser panel read "Nothing captured yet" for a Boo that
// had browsed all afternoon, and the only way back was to make it browse again.
// That is a worse lie than an empty panel: the agent DID capture something, and
// the record of it was thrown away by an implementation detail.
//
// So this is a cache, not a store. It mirrors the bus rather than fronting it:
// reads never touch the disk (the bus is loaded once at boot), and a write that
// fails is dropped without disturbing the frame that is already in memory. If
// the directory is unwritable the panel behaves exactly as it did before.
//
// FILE NAMES ARE HASHED. An agent id reaches this module from the database and
// from the OpenClaw sync, and neither is constrained to characters that are safe
// in a path. Hashing removes the question rather than answering it, and the real
// id is kept in the index where it cannot be a traversal.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'

const log = createLogger('screenshot-frames')

/** One frame's descriptor, as the index records it. */
export interface FrameRecord {
  agentId: string
  file: string
  mimeType: string
  toolName: string
  ts: number
}

interface FrameIndex {
  version: 1
  frames: FrameRecord[]
}

/** Extensions we are willing to write, keyed by the mime types the route serves.
 *  A connector states its own mimeType, so an unknown one gets a generic name
 *  rather than a path segment of its choosing. */
const EXT_BY_TYPE = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
])

function framesDir(): string {
  return path.join(resolveClawbooDir(), 'frames')
}

function indexPath(): string {
  return path.join(framesDir(), 'index.json')
}

function fileNameFor(agentId: string, mimeType: string): string {
  const stem = createHash('sha256').update(agentId).digest('hex').slice(0, 32)
  return `${stem}${EXT_BY_TYPE.get(mimeType) ?? '.bin'}`
}

/**
 * Writes are SERIALIZED through this chain.
 *
 * Every write rewrites the whole index, so two frames landing together would
 * otherwise read the same index, and the second would write a copy that had
 * never seen the first. Frames arrive in bursts while an agent browses, which
 * makes that the normal case rather than a race worth ignoring.
 */
let queue: Promise<void> = Promise.resolve()

function enqueue(work: () => void): void {
  queue = queue
    .then(() => work())
    .catch((err) => {
      // A cache that cannot write is still a working panel. Logged once per
      // failure rather than thrown, because the frame is already in memory and
      // the caller is a tool-result handler with nowhere to put an error.
      log.warn({ err: String(err) }, 'could not persist frame')
    })
}

function readIndex(): FrameIndex {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { version: 1, frames: [] }
    const frames = (parsed as { frames?: unknown }).frames
    if (!Array.isArray(frames)) return { version: 1, frames: [] }
    // Field-checked rather than trusted: this file is on a user's disk and a
    // half-written or hand-edited one must not take the panel down at boot.
    const clean = frames.filter(
      (f): f is FrameRecord =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as FrameRecord).agentId === 'string' &&
        typeof (f as FrameRecord).file === 'string' &&
        typeof (f as FrameRecord).mimeType === 'string' &&
        typeof (f as FrameRecord).ts === 'number' &&
        // The index is ours, but it is also a file anyone can edit. A `file`
        // with a separator in it is the one field that could reach outside the
        // frames directory, so it is rejected outright rather than resolved.
        !(f as FrameRecord).file.includes('/') &&
        !(f as FrameRecord).file.includes('\\') &&
        !(f as FrameRecord).file.includes('..'),
    )
    return { version: 1, frames: clean }
  } catch {
    return { version: 1, frames: [] }
  }
}

function writeIndex(index: FrameIndex): void {
  const target = indexPath()
  const tmp = `${target}.${process.pid}.tmp`
  // Written whole and renamed into place: a reader at boot must see either the
  // previous index or this one, never half of this one.
  fs.writeFileSync(tmp, JSON.stringify(index), 'utf8')
  fs.renameSync(tmp, target)
}

/** Persist one frame, replacing whatever that agent had before. */
export function persistFrame(
  agentId: string,
  shot: { data: string; mimeType: string; toolName: string; ts: number },
): void {
  enqueue(() => {
    const dir = framesDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = fileNameFor(agentId, shot.mimeType)
    // Binary, not base64. It is a quarter smaller and it is a real image file,
    // which matters the one time someone has to look at this directory to work
    // out what the panel is showing.
    fs.writeFileSync(path.join(dir, file), Buffer.from(shot.data, 'base64'))

    const index = readIndex()
    const others = index.frames.filter((f) => f.agentId !== agentId)
    // A previous frame for this agent under a DIFFERENT extension would be
    // orphaned by the rename, so it is removed by name rather than left behind.
    for (const stale of index.frames) {
      if (stale.agentId === agentId && stale.file !== file) removeFile(stale.file)
    }
    writeIndex({
      version: 1,
      frames: [
        ...others,
        { agentId, file, mimeType: shot.mimeType, toolName: shot.toolName, ts: shot.ts },
      ],
    })
  })
}

/** Forget one agent's frame, so eviction in memory is eviction on disk. */
export function forgetFrame(agentId: string): void {
  enqueue(() => {
    const index = readIndex()
    const going = index.frames.filter((f) => f.agentId === agentId)
    if (going.length === 0) return
    for (const f of going) removeFile(f.file)
    writeIndex({ version: 1, frames: index.frames.filter((f) => f.agentId !== agentId) })
  })
}

function removeFile(file: string): void {
  try {
    fs.unlinkSync(path.join(framesDir(), file))
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/**
 * Every frame on disk, newest first, as base64 for the bus's own shape.
 *
 * Newest first so a caller that stops at a byte budget keeps the frames most
 * likely to be looked at. A record whose file has vanished is skipped rather
 * than treated as an error: the directory is a cache and may be cleared by hand.
 */
export function loadFrames(): (FrameRecord & { data: string })[] {
  const index = readIndex()
  const out: (FrameRecord & { data: string })[] = []
  for (const rec of [...index.frames].sort((a, b) => b.ts - a.ts)) {
    try {
      const bytes = fs.readFileSync(path.join(framesDir(), rec.file))
      out.push({ ...rec, data: bytes.toString('base64') })
    } catch {
      continue
    }
  }
  return out
}

/** Test seam: settle the write chain so an assertion can read the directory. */
export async function flushFrameWrites(): Promise<void> {
  await queue
}
