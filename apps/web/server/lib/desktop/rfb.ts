// A small RFB (VNC) client: the server's one connection to an agent's display.
//
// The Clawboo server is the ONLY client of an agent's display. It keeps the
// framebuffer here and fans changed regions out to whoever is watching, as
// pictures; nobody watching ever speaks RFB, so a view-only watcher has no way
// to send the display a key or a click, rather than a filter that must parse
// every message a viewer might send.
//
// Only what an Xvnc display needs is implemented: protocol 3.8, security type
// None (the display listens on a socket only its own user can open), a 32-bit
// true-colour framebuffer, the Raw and CopyRect encodings, and the DesktopSize
// and LastRect pseudo-encodings. Anything else the display sends is a protocol
// error and closes the connection: a guess at a message's length would read the
// rest of the stream as garbage.
//
// RFC 6143 is the reference for every byte below.

import { EventEmitter } from 'node:events'

/** A region of the framebuffer, in display pixels. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The two halves of a byte stream to the display. A socket is both. */
export interface RfbStream {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}

/** The display refused us, or spoke something this client does not read. */
export class RfbProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RfbProtocolError'
  }
}

const ENC_RAW = 0
const ENC_COPYRECT = 1
const ENC_LASTRECT = -224
const ENC_DESKTOPSIZE = -223

/** The largest display this client accepts, a little over the largest size an
 *  agent display is started at (3840x2160). Anything bigger, from ServerInit or a
 *  resize a program on the display asked for, is refused and ends the
 *  connection: its framebuffer and every picture of it would cost the server
 *  memory and time out of all proportion. */
export const MAX_DISPLAY_SIDE = 4096

/** Bytes waiting to be read, and the reads waiting for them. */
class ByteQueue {
  private chunks: Buffer[] = []
  private size = 0
  private wanted: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null
  private failure: Error | null = null

  push(chunk: Buffer): void {
    if (this.failure) return
    this.chunks.push(chunk)
    this.size += chunk.length
    this.serve()
  }

  fail(err: Error): void {
    if (this.failure) return
    this.failure = err
    const w = this.wanted
    this.wanted = null
    w?.reject(err)
  }

  /** Exactly `n` bytes, once they have arrived. One read at a time. */
  read(n: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.wanted) return Promise.reject(new Error('ByteQueue: overlapping reads'))
    if (n === 0) return Promise.resolve(Buffer.alloc(0))
    return new Promise((resolve, reject) => {
      this.wanted = { n, resolve, reject }
      this.serve()
    })
  }

  private serve(): void {
    const w = this.wanted
    if (!w || this.size < w.n) return
    this.wanted = null
    w.resolve(this.take(w.n))
  }

  private take(n: number): Buffer {
    const first = this.chunks[0]!
    if (first.length >= n) {
      const out = first.subarray(0, n)
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      this.size -= n
      return out
    }
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const head = this.chunks[0]!
      const take = Math.min(head.length, n - filled)
      head.copy(out, filled, 0, take)
      filled += take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.size -= n
    return out
  }
}

/**
 * The pixel format this client asks for: 32 bits per pixel, depth 24, little
 * endian, true colour, red in the low byte. In memory that is red, green, blue
 * and one unused byte per pixel, which is what the PNG encoder reads.
 */
function pixelFormat(): Buffer {
  const pf = Buffer.alloc(16)
  pf[0] = 32 // bits per pixel
  pf[1] = 24 // depth
  pf[2] = 0 // big-endian flag
  pf[3] = 1 // true colour
  pf.writeUInt16BE(255, 4) // red max
  pf.writeUInt16BE(255, 6) // green max
  pf.writeUInt16BE(255, 8) // blue max
  pf[10] = 0 // red shift
  pf[11] = 8 // green shift
  pf[12] = 16 // blue shift
  return pf
}

export interface RfbClientEvents {
  /** The display drew these regions; the framebuffer already holds them. */
  update: (rects: Rect[]) => void
  /** The display changed size; the framebuffer was replaced and is blank. */
  resize: (width: number, height: number) => void
  /** One update from the display ended, whatever it held: the moment to ask for
   *  the next. (A size change alone draws nothing, so `update` does not fire.) */
  frame: () => void
  /** The connection ended; `err` says why when it was not a clean close. */
  close: (err?: Error) => void
}

export class RfbClient extends EventEmitter {
  width = 0
  height = 0
  name = ''
  /** Red, green, blue, unused: 4 bytes per pixel, `width` pixels per row. */
  fb: Buffer = Buffer.alloc(0)
  private readonly queue = new ByteQueue()
  private closed = false
  private ready = false

  constructor(private readonly stream: RfbStream) {
    super()
    stream.input.on('data', (chunk: Buffer | string) => {
      this.queue.push(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk)
    })
    stream.input.on('end', () => this.finish())
    stream.input.on('close', () => this.finish())
    stream.input.on('error', (err: Error) => this.finish(err))
    // A write after the far end went away raises EPIPE on the output stream.
    // It is the same event as the close above, so it ends the connection
    // rather than reaching the process as an unhandled error.
    stream.output.on('error', (err: Error) => this.finish(err))
  }

  /**
   * Shake hands, then read the display's messages until the connection ends.
   * Resolves once the display has said its size, so the caller can serve it.
   */
  async start(): Promise<void> {
    const version = (await this.queue.read(12)).toString('latin1')
    if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) {
      throw this.fail(new RfbProtocolError(`not an RFB server (${JSON.stringify(version)})`))
    }
    const [major, minor] = version.slice(4, 11).split('.').map(Number) as [number, number]
    if (major < 3 || (major === 3 && minor < 8)) {
      throw this.fail(new RfbProtocolError(`RFB ${major}.${minor} is older than 3.8`))
    }
    this.send(Buffer.from('RFB 003.008\n', 'latin1'))

    const count = (await this.queue.read(1))[0]!
    if (count === 0) throw this.fail(new RfbProtocolError(await this.readReason()))
    const types = await this.queue.read(count)
    // None only. The display is reached through a socket in a folder only its
    // own user can enter, or through a process of that user; a password would
    // add nothing that folder does not already give.
    if (!types.includes(1)) {
      throw this.fail(
        new RfbProtocolError(`the display offers no unauthenticated access (${[...types]})`),
      )
    }
    this.send(Buffer.from([1]))
    const result = (await this.queue.read(4)).readUInt32BE(0)
    if (result !== 0) throw this.fail(new RfbProtocolError(await this.readReason()))

    // Shared, so a second connection (a desktop driver's own, say) does not
    // disconnect this one.
    this.send(Buffer.from([1]))
    const init = await this.queue.read(24)
    const width = init.readUInt16BE(0)
    const height = init.readUInt16BE(2)
    const nameLength = init.readUInt32BE(20)
    if (nameLength > 4096) throw this.fail(new RfbProtocolError('display name too long'))
    this.name = (await this.queue.read(nameLength)).toString('utf8')
    this.allocate(width, height)

    const setPixelFormat = Buffer.alloc(20)
    setPixelFormat[0] = 0
    pixelFormat().copy(setPixelFormat, 4)
    this.send(setPixelFormat)
    const encodings = [ENC_COPYRECT, ENC_RAW, ENC_DESKTOPSIZE, ENC_LASTRECT]
    const setEncodings = Buffer.alloc(4 + encodings.length * 4)
    setEncodings[0] = 2
    setEncodings.writeUInt16BE(encodings.length, 2)
    encodings.forEach((e, i) => setEncodings.writeInt32BE(e, 4 + i * 4))
    this.send(setEncodings)

    this.ready = true
    void this.readLoop()
  }

  /** Ask for the next update: only what changed, or the whole screen. */
  requestUpdate(incremental: boolean): void {
    if (!this.ready || this.closed) return
    const msg = Buffer.alloc(10)
    msg[0] = 3
    msg[1] = incremental ? 1 : 0
    msg.writeUInt16BE(0, 2)
    msg.writeUInt16BE(0, 4)
    msg.writeUInt16BE(this.width, 6)
    msg.writeUInt16BE(this.height, 8)
    this.send(msg)
  }

  /** Move the pointer to (x, y) with these buttons down (bit 0 left, 1 middle,
   *  2 right, 3 and 4 the wheel). Clipped to the screen. */
  pointer(x: number, y: number, buttons: number): void {
    if (!this.ready || this.closed) return
    const msg = Buffer.alloc(6)
    msg[0] = 5
    msg[1] = buttons & 0xff
    msg.writeUInt16BE(clamp(Math.round(x), 0, Math.max(0, this.width - 1)), 2)
    msg.writeUInt16BE(clamp(Math.round(y), 0, Math.max(0, this.height - 1)), 4)
    this.send(msg)
  }

  /** Press or release the key with this X keysym. */
  key(keysym: number, down: boolean): void {
    if (!this.ready || this.closed) return
    const msg = Buffer.alloc(8)
    msg[0] = 4
    msg[1] = down ? 1 : 0
    msg.writeUInt32BE(keysym >>> 0, 4)
    this.send(msg)
  }

  /** End the connection. The display itself is stopped by whoever started it. */
  close(): void {
    this.finish()
  }

  get isClosed(): boolean {
    return this.closed
  }

  private send(buf: Buffer): void {
    if (this.closed) return
    try {
      this.stream.output.write(buf)
    } catch (err) {
      this.finish(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async readReason(): Promise<string> {
    const n = (await this.queue.read(4)).readUInt32BE(0)
    return (await this.queue.read(Math.min(n, 4096))).toString('utf8') || 'refused'
  }

  private allocate(width: number, height: number): void {
    if (width < 1 || height < 1 || width > MAX_DISPLAY_SIDE || height > MAX_DISPLAY_SIDE) {
      throw this.fail(new RfbProtocolError(`unusable display size ${width}x${height}`))
    }
    this.width = width
    this.height = height
    this.fb = Buffer.alloc(width * height * 4)
  }

  private fail(err: Error): Error {
    this.finish(err)
    return err
  }

  private finish(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    this.queue.fail(err ?? new Error('the display connection closed'))
    try {
      this.stream.output.end()
    } catch {
      // Already gone.
    }
    this.emit('close', err)
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const type = (await this.queue.read(1))[0]!
        switch (type) {
          case 0:
            await this.readUpdate()
            break
          case 1: {
            // SetColourMapEntries. Never sent for a true-colour format, but its
            // length is known, so it is read and ignored rather than fatal.
            const head = await this.queue.read(5)
            await this.queue.read(head.readUInt16BE(3) * 6)
            break
          }
          case 2:
            // Bell.
            break
          case 3: {
            // ServerCutText: the display's clipboard. Read and dropped: what an
            // agent copies is not sent to whoever watches (Xvnc is also told
            // not to send it).
            const head = await this.queue.read(7)
            const n = head.readUInt32BE(3)
            if (n > 16 * 1024 * 1024) throw new RfbProtocolError('clipboard message too long')
            await this.queue.read(n)
            break
          }
          default:
            throw new RfbProtocolError(`unknown server message ${type}`)
        }
      }
    } catch (err) {
      this.finish(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async readUpdate(): Promise<void> {
    const head = await this.queue.read(3)
    const count = head.readUInt16BE(1)
    const drawn: Rect[] = []
    let resized = false
    for (let i = 0; i < count; i++) {
      const r = await this.queue.read(12)
      const x = r.readUInt16BE(0)
      const y = r.readUInt16BE(2)
      const w = r.readUInt16BE(4)
      const h = r.readUInt16BE(6)
      const encoding = r.readInt32BE(8)
      if (encoding === ENC_LASTRECT) break
      if (encoding === ENC_DESKTOPSIZE) {
        this.allocate(w, h)
        resized = true
        continue
      }
      if (x + w > this.width || y + h > this.height) {
        throw new RfbProtocolError(`rectangle ${w}x${h}+${x}+${y} outside the screen`)
      }
      if (encoding === ENC_RAW) {
        const data = await this.queue.read(w * h * 4)
        for (let row = 0; row < h; row++) {
          data.copy(this.fb, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4)
        }
      } else if (encoding === ENC_COPYRECT) {
        const src = await this.queue.read(4)
        const sx = src.readUInt16BE(0)
        const sy = src.readUInt16BE(2)
        if (sx + w > this.width || sy + h > this.height) {
          throw new RfbProtocolError('copy source outside the screen')
        }
        // Through a copy, because source and destination may overlap.
        const tmp = Buffer.allocUnsafe(w * h * 4)
        for (let row = 0; row < h; row++) {
          this.fb.copy(
            tmp,
            row * w * 4,
            ((sy + row) * this.width + sx) * 4,
            ((sy + row) * this.width + sx + w) * 4,
          )
        }
        for (let row = 0; row < h; row++) {
          tmp.copy(this.fb, ((y + row) * this.width + x) * 4, row * w * 4, (row + 1) * w * 4)
        }
      } else {
        throw new RfbProtocolError(`unrequested encoding ${encoding}`)
      }
      if (w > 0 && h > 0) drawn.push({ x, y, w, h })
    }
    if (resized) this.emit('resize', this.width, this.height)
    if (drawn.length > 0) this.emit('update', drawn)
    this.emit('frame')
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}
