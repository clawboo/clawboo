// For hosts that sleep and wake this engine: whatever stops it when nobody is
// using it and starts it again on demand (a process supervisor, a desktop shell,
// a service manager).
//
//   GET  /api/system/idle      is a person here, is work going, and when is the
//                              next scheduled work due (see lib/idleState)
//   POST /api/system/presence  a client reports a person: { tabId, visible,
//                              focused, acted? } (see lib/presence)
//
// Behind the same origin guard and access gate as every other /api route. Reading
// either route is never presence: only a beat a client sends on purpose is.

import type { Request, Response } from 'express'

import { buildIdleState } from '../lib/idleState'
import { PRESENCE_TAB_ID_RE, presence } from '../lib/presence'

export function systemIdleGET(_req: Request, res: Response): void {
  // A cached answer would say a person is here, or nothing is due, after it stopped being true.
  res.setHeader('Cache-Control', 'no-store')
  void buildIdleState()
    .then((state) => res.json(state))
    .catch((err: unknown) =>
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
    )
}

export function systemPresencePOST(req: Request, res: Response): void {
  const body = (req.body ?? {}) as {
    tabId?: unknown
    visible?: unknown
    focused?: unknown
    acted?: unknown
  }
  if (typeof body.tabId !== 'string' || !PRESENCE_TAB_ID_RE.test(body.tabId)) {
    res.status(400).json({ error: 'tabId must be 1 to 64 letters, digits, _ or -.' })
    return
  }
  if (typeof body.visible !== 'boolean' || typeof body.focused !== 'boolean') {
    res.status(400).json({ error: 'visible and focused must be true or false.' })
    return
  }
  if (body.acted !== undefined && typeof body.acted !== 'boolean') {
    res.status(400).json({ error: 'acted must be true or false when given.' })
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  res.json(
    presence().beat(body.tabId, {
      visible: body.visible,
      focused: body.focused,
      acted: body.acted === true,
    }),
  )
}
