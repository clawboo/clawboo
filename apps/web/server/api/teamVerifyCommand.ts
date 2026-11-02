// GET/PUT for a team's verify command, the check the verification gate runs
// for the team's tasks (see lib/verification/teamVerifyCommand.ts).

import type { Request, Response } from 'express'
import { setSetting } from '@clawboo/db'

import { getDb } from '../lib/db'
import {
  readTeamVerifyCommand,
  teamVerifyCommandSettingKey,
} from '../lib/verification/teamVerifyCommand'

const MAX_COMMAND_CHARS = 2000

// ─── GET /api/team-verify-command/:teamId ────────────────────────────────────

export function teamVerifyCommandGET(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    res.json({ command: readTeamVerifyCommand(getDb(), teamId) ?? '' })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/team-verify-command/:teamId ────────────────────────────────────
// Body: { command: string }. An empty string clears it. One line, capped at
// MAX_COMMAND_CHARS: init.sh stores it as a single VERIFY_CMD assignment.

export function teamVerifyCommandPUT(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const body = req.body as { command?: unknown } | undefined
  if (!body || typeof body !== 'object' || typeof body.command !== 'string') {
    res.status(400).json({ error: 'command (string) required' })
    return
  }
  const command = body.command.trim()
  if (command.length > MAX_COMMAND_CHARS) {
    res.status(400).json({ error: `command exceeds ${MAX_COMMAND_CHARS} characters` })
    return
  }
  if (/[\r\n]/.test(command)) {
    res.status(400).json({ error: 'command must be a single line' })
    return
  }
  try {
    setSetting(getDb(), teamVerifyCommandSettingKey(teamId), JSON.stringify({ command }))
    res.json({ command })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
