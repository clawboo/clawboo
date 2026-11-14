// The cookie that keeps an agent's display to the programs it is meant for.
//
// An X display listens where any local user can try to connect (a socket under
// /tmp/.X11-unix, and an abstract one on Linux). With an authority file, the
// display admits only a client that presents the cookie in it, so the file's
// folder (0700, owned by whoever runs the agent's programs) is what decides who
// may draw on or read that display. Without one, an X server admits every local
// connection.
//
// Written here rather than with `xauth`, which is one more program to find. The
// format is Xau's: for each entry, a family (2 bytes), then address, display
// number, auth name and auth data, each as a 2-byte length and its bytes, all
// big-endian. One entry, family Wild with an empty address and an empty display
// number: Xlib takes it for any display, and the X server loads every entry of
// the file it is given whatever its display number.

import { randomBytes } from 'node:crypto'

const FAMILY_WILD = 0xffff
const AUTH_NAME = 'MIT-MAGIC-COOKIE-1'

function field(data: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(data.length, 0)
  return Buffer.concat([len, data])
}

/** A fresh cookie, and the authority file that carries it. */
export function makeXauthority(cookie: Buffer = randomBytes(16)): { file: Buffer; cookie: Buffer } {
  if (cookie.length !== 16) throw new RangeError('an MIT-MAGIC-COOKIE-1 is 16 bytes')
  const family = Buffer.alloc(2)
  family.writeUInt16BE(FAMILY_WILD, 0)
  const file = Buffer.concat([
    family,
    field(Buffer.alloc(0)), // address
    field(Buffer.alloc(0)), // display number: any
    field(Buffer.from(AUTH_NAME, 'latin1')),
    field(cookie),
  ])
  return { file, cookie }
}
