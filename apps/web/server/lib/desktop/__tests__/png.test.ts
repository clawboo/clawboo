import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { encodeRegionPng, encodeRegionPngAsync } from '../png'

/** Read a PNG back: its size and its RGB pixels, checking every CRC. */
function decode(png: Buffer): { w: number; h: number; rgb: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  let off = 8
  let w = 0
  let h = 0
  const idat: Buffer[] = []
  for (;;) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    const crc = png.readUInt32BE(off + 8 + len)
    expect(crc).toBe(zlib.crc32(data, zlib.crc32(type)) >>> 0)
    off += 12 + len
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      expect([...data.subarray(8)]).toEqual([8, 2, 0, 0, 0])
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const rgb = Buffer.alloc(w * h * 3)
  for (let row = 0; row < h; row++) {
    const line = raw.subarray(row * (w * 3 + 1), (row + 1) * (w * 3 + 1))
    expect(line[0]).toBe(1)
    for (let i = 0; i < w * 3; i++) {
      const left = i >= 3 ? rgb[row * w * 3 + i - 3]! : 0
      rgb[row * w * 3 + i] = (line[1 + i]! + left) & 0xff
    }
  }
  return { w, h, rgb }
}

describe('encodeRegionPng', () => {
  it('encodes exactly the region asked for, dropping the unused fourth byte', () => {
    const fbWidth = 4
    const fb = Buffer.alloc(fbWidth * 3 * 4)
    for (let i = 0; i < fbWidth * 3; i++) {
      fb[i * 4] = i * 10
      fb[i * 4 + 1] = 255 - i
      fb[i * 4 + 2] = i * 3
      fb[i * 4 + 3] = 0xaa
    }
    const { w, h, rgb } = decode(encodeRegionPng(fb, fbWidth, 1, 1, 2, 2))
    expect([w, h]).toEqual([2, 2])
    const pixel = (px: number, py: number) => {
      const i = py * fbWidth + px
      return [i * 10, 255 - i, i * 3]
    }
    expect([...rgb]).toEqual([...pixel(1, 1), ...pixel(2, 1), ...pixel(1, 2), ...pixel(2, 2)])
  })

  it('refuses an empty region', () => {
    expect(() => encodeRegionPng(Buffer.alloc(16), 2, 0, 0, 0, 1)).toThrow(RangeError)
  })
})

describe('encodeRegionPngAsync', () => {
  it('makes the same picture as the encoder on this thread', async () => {
    const fbWidth = 5
    const fb = Buffer.alloc(fbWidth * 4 * 4)
    for (let i = 0; i < fb.length; i++) fb[i] = (i * 37) & 0xff
    const png = await encodeRegionPngAsync(fb, fbWidth, 1, 0, 3, 4)
    expect(png).toEqual(encodeRegionPng(fb, fbWidth, 1, 0, 3, 4))
  })

  it('copies the region before it returns, so later drawing does not reach it', async () => {
    const fbWidth = 2
    const fb = Buffer.alloc(fbWidth * 2 * 4, 0x10)
    const before = encodeRegionPng(fb, fbWidth, 0, 0, 2, 2)
    const pending = encodeRegionPngAsync(fb, fbWidth, 0, 0, 2, 2)
    fb.fill(0xee)
    expect(await pending).toEqual(before)
  })
})
