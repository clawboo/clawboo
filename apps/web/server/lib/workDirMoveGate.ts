// What the server answers while the work folder move runs at boot
// (`workDirMigration.ts`). It listens first so a supervisor waiting on
// /api/health sees progress rather than a refused connection, but nothing else
// may run until the folders are where the rest of the server expects them:
// - `GET /api/health` answers 200 with `"status": "migrating"` and the count of
//   items done and left;
// - every other request answers 503 with `Retry-After: 2`;
// - a WebSocket upgrade is refused the same way.
// Mounted after the access gate, so the answers need the same sign-in as ever.

import type { Duplex } from 'node:stream'

import type { NextFunction, Request, Response } from 'express'

import { workDirMoveProgress } from './workDirMigration'

export function refuseWhileMoving(req: Request, res: Response, next: NextFunction): void {
  const moving = workDirMoveProgress()
  if (!moving) {
    next()
    return
  }
  if (req.method === 'GET' && req.path === '/api/health') {
    res.json({
      ok: false,
      status: 'migrating',
      migration: { total: moving.total, done: moving.done, left: moving.total - moving.done },
    })
    return
  }
  res.setHeader('Retry-After', '2')
  res.status(503).json({
    error: 'Clawboo is moving its work folders. Try again in a moment.',
    status: 'migrating',
  })
}

/** True when it refused the upgrade on `socket` because the move is running. */
export function refuseUpgradeWhileMoving(socket: Duplex): boolean {
  if (!workDirMoveProgress()) return false
  socket.end(
    'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  )
  return true
}
