// A PNG encoder for one region of an agent's screen.
//
// The live view sends what changed on an agent's display as PNG pictures of the
// changed regions, which a browser draws onto a canvas with no decoder of ours.
// PNG because it is lossless (text stays readable, a login form stays exact)
// and Node can make one with nothing but node:zlib. Screen content is mostly
// flat colour and repeated rows, which the Sub filter and deflate shrink well.

import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(type)) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/**
 * Encode the `w` by `h` region at (`x`, `y`) of a framebuffer as an RGB PNG.
 *
 * `fb` holds 4 bytes per pixel, red, green, blue, then one unused byte, rows
 * `fbWidth` pixels wide: the layout the RFB client asks the display for. The
 * region must lie inside the framebuffer; a caller clips before asking.
 */
export function encodeRegionPng(
  fb: Buffer,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  level = 3,
): Buffer {
  return assemble(w, h, zlib.deflateSync(filteredRows(fb, fbWidth, x, y, w, h), { level }))
}

/**
 * The same picture, compressed on libuv's thread pool rather than the server's
 * own thread, so a large screen being watched never holds up every other
 * request. The region is copied before this returns, so later drawing on the
 * framebuffer does not reach the picture.
 */
export function encodeRegionPngAsync(
  fb: Buffer,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
  level = 3,
): Promise<Buffer> {
  const raw = filteredRows(fb, fbWidth, x, y, w, h)
  return new Promise((resolve, reject) => {
    zlib.deflate(raw, { level }, (err, out) => (err ? reject(err) : resolve(assemble(w, h, out))))
  })
}

/** The region's rows, each with its filter byte, as PNG compresses them. */
function filteredRows(
  fb: Buffer,
  fbWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Buffer {
  if (w <= 0 || h <= 0) throw new RangeError('empty region')
  const rowBytes = w * 3
  const raw = Buffer.alloc((rowBytes + 1) * h)
  for (let row = 0; row < h; row++) {
    const out = row * (rowBytes + 1)
    // Filter 1 (Sub): each byte minus the same channel of the pixel to its
    // left. Flat runs become zeros, which is most of a screen.
    raw[out] = 1
    let src = ((y + row) * fbWidth + x) * 4
    let pr = 0
    let pg = 0
    let pb = 0
    for (let col = 0; col < w; col++, src += 4) {
      const r = fb[src]!
      const g = fb[src + 1]!
      const b = fb[src + 2]!
      const o = out + 1 + col * 3
      raw[o] = (r - pr) & 0xff
      raw[o + 1] = (g - pg) & 0xff
      raw[o + 2] = (b - pb) & 0xff
      pr = r
      pg = g
      pb = b
    }
  }
  return raw
}

function assemble(w: number, h: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
