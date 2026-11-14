import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { RfbClient, RfbProtocolError, type Rect } from '../rfb'

/** A scripted display: what it sends, and what the client sent it. */
function fakeDisplay() {
  const toClient = new PassThrough()
  const fromClient = new PassThrough()
  const received: Buffer[] = []
  fromClient.on('data', (b: Buffer) => received.push(b))
  const client = new RfbClient({ input: toClient, output: fromClient })
  const sent = () => Buffer.concat(received)
  return { toClient, client, sent }
}

function serverInit(w: number, h: number, name = 'agent'): Buffer {
  const b = Buffer.alloc(24 + name.length)
  b.writeUInt16BE(w, 0)
  b.writeUInt16BE(h, 2)
  b.writeUInt32BE(name.length, 20)
  b.write(name, 24, 'utf8')
  return b
}

function handshake(toClient: PassThrough, w: number, h: number): void {
  toClient.write('RFB 003.008\n')
  toClient.write(Buffer.from([1, 1])) // one security type: None
  toClient.write(Buffer.from([0, 0, 0, 0])) // security result: OK
  toClient.write(serverInit(w, h))
}

function rectHeader(x: number, y: number, w: number, h: number, enc: number): Buffer {
  const b = Buffer.alloc(12)
  b.writeUInt16BE(x, 0)
  b.writeUInt16BE(y, 2)
  b.writeUInt16BE(w, 4)
  b.writeUInt16BE(h, 6)
  b.writeInt32BE(enc, 8)
  return b
}

function updateHeader(count: number): Buffer {
  const b = Buffer.alloc(4)
  b[0] = 0
  b.writeUInt16BE(count, 2)
  return b
}

const nextUpdate = (client: RfbClient) =>
  new Promise<Rect[]>((resolve) => client.once('update', resolve))

describe('RfbClient', () => {
  it('shakes hands, asks for a 32-bit RGB framebuffer and the encodings it reads', async () => {
    const { toClient, client, sent } = fakeDisplay()
    handshake(toClient, 4, 2)
    await client.start()
    expect([client.width, client.height, client.name]).toEqual([4, 2, 'agent'])
    const out = sent()
    expect(out.subarray(0, 12).toString('latin1')).toBe('RFB 003.008\n')
    expect(out[12]).toBe(1) // chose None
    expect(out[13]).toBe(1) // shared
    const spf = out.subarray(14, 34)
    expect(spf[0]).toBe(0)
    expect([...spf.subarray(4, 8)]).toEqual([32, 24, 0, 1])
    expect([spf[14], spf[15], spf[16]]).toEqual([0, 8, 16])
    const se = out.subarray(34)
    expect(se[0]).toBe(2)
    const n = se.readUInt16BE(2)
    const encodings = Array.from({ length: n }, (_, i) => se.readInt32BE(4 + i * 4))
    expect(encodings).toEqual([1, 0, -223, -224])
    client.close()
  })

  it('draws Raw and CopyRect rectangles into the framebuffer', async () => {
    const { toClient, client } = fakeDisplay()
    handshake(toClient, 4, 2)
    await client.start()

    const pixels = Buffer.alloc(2 * 2 * 4)
    for (let i = 0; i < 4; i++) pixels.writeUInt32LE(0x00010203 + i, i * 4)
    let got = nextUpdate(client)
    toClient.write(Buffer.concat([updateHeader(1), rectHeader(0, 0, 2, 2, 0), pixels]))
    expect(await got).toEqual([{ x: 0, y: 0, w: 2, h: 2 }])
    expect(client.fb.readUInt32LE(0)).toBe(0x00010203)
    expect(client.fb.readUInt32LE((1 * 4 + 1) * 4)).toBe(0x00010206)

    const src = Buffer.alloc(4)
    src.writeUInt16BE(0, 0)
    src.writeUInt16BE(0, 2)
    got = nextUpdate(client)
    toClient.write(Buffer.concat([updateHeader(1), rectHeader(2, 0, 2, 2, 1), src]))
    expect(await got).toEqual([{ x: 2, y: 0, w: 2, h: 2 }])
    expect(client.fb.readUInt32LE(2 * 4)).toBe(0x00010203)
    expect(client.fb.readUInt32LE((1 * 4 + 3) * 4)).toBe(0x00010206)
    client.close()
  })

  it('takes a new size and stops at LastRect', async () => {
    const { toClient, client } = fakeDisplay()
    handshake(toClient, 4, 2)
    await client.start()
    const resized = new Promise<[number, number]>((r) => client.once('resize', (w, h) => r([w, h])))
    toClient.write(
      Buffer.concat([
        updateHeader(0xffff),
        rectHeader(0, 0, 8, 6, -223),
        rectHeader(0, 0, 0, 0, -224),
        // A later message must still be read from the right place.
        Buffer.from([2]),
      ]),
    )
    expect(await resized).toEqual([8, 6])
    expect(client.fb.length).toBe(8 * 6 * 4)
    expect(client.isClosed).toBe(false)
    client.close()
  })

  it('closes on a rectangle outside the screen rather than writing past the framebuffer', async () => {
    const { toClient, client } = fakeDisplay()
    handshake(toClient, 4, 2)
    await client.start()
    const closed = new Promise<Error | undefined>((r) => client.once('close', r))
    toClient.write(Buffer.concat([updateHeader(1), rectHeader(3, 1, 2, 2, 0)]))
    expect(await closed).toBeInstanceOf(RfbProtocolError)
  })

  it('closes on a server message it cannot measure', async () => {
    const { toClient, client } = fakeDisplay()
    handshake(toClient, 4, 2)
    await client.start()
    const closed = new Promise<Error | undefined>((r) => client.once('close', r))
    toClient.write(Buffer.from([250]))
    expect((await closed)?.message).toMatch(/unknown server message 250/)
  })

  it('refuses a display that wants a password', async () => {
    const { toClient, client } = fakeDisplay()
    toClient.write('RFB 003.008\n')
    toClient.write(Buffer.from([1, 2])) // VncAuth only
    await expect(client.start()).rejects.toThrow(/no unauthenticated access/)
  })

  it('refuses an absurd screen size before allocating it', async () => {
    const { toClient, client } = fakeDisplay()
    toClient.write('RFB 003.008\n')
    toClient.write(Buffer.from([1, 1]))
    toClient.write(Buffer.from([0, 0, 0, 0]))
    toClient.write(serverInit(60000, 60000))
    await expect(client.start()).rejects.toThrow(/unusable display size/)
  })

  it('sends pointer and key events in the wire format, clipped to the screen', async () => {
    const { toClient, client, sent } = fakeDisplay()
    handshake(toClient, 100, 50)
    await client.start()
    const before = sent().length
    client.pointer(150, -3, 1)
    client.key(0xff0d, true)
    client.requestUpdate(true)
    const tail = sent().subarray(before)
    expect([...tail.subarray(0, 6)]).toEqual([5, 1, 0, 99, 0, 0])
    expect(tail[6]).toBe(4)
    expect(tail[7]).toBe(1)
    expect(tail.readUInt32BE(10)).toBe(0xff0d)
    expect([...tail.subarray(14, 24)]).toEqual([3, 1, 0, 0, 0, 0, 0, 100, 0, 50])
    client.close()
  })
})
