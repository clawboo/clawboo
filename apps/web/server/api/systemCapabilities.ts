// GET /api/system/capabilities: this engine's version, API revision, support
// floor and feature flags, for any client (the dashboard, a desktop shell, a
// proxy in front of the engine, a remote app) to check before it uses a feature.
// Read-only and cheap; see lib/engineCapabilities.ts for what goes in it.
//
// Behind the same origin guard and access gate as every other /api route. A
// client that has not signed in yet gets the gate's 401, which already tells it
// an engine is there and that it needs the token.

import type { Request, Response } from 'express'

import { buildEngineCapabilities } from '../lib/engineCapabilities'

export function systemCapabilitiesGET(_req: Request, res: Response): void {
  // The answer changes when the engine restarts into a new version at the same
  // URL, so no cache may keep the old one.
  res.setHeader('Cache-Control', 'no-store')
  res.json(buildEngineCapabilities())
}
