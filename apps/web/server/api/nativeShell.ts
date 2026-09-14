// ─── The native shell switch ──────────────────────────────────────────────
//
// Whether a clawboo-native Boo may ASK to run a command. Not whether it may run
// one: `run_command` puts every single command in front of a person regardless,
// and there is no allowlist and nothing remembered. So this switch decides
// whether the tool is offered to the model at all.
//
// SEPARATE FROM `/api/exec-settings`, which is OpenClaw's. That route writes the
// Gateway's own approvals store keyed by OpenClaw agent id, and for a native Boo
// nothing consults it. Folding these together would produce a control that
// accepted a setting for the wrong runtime and reported success, which is the
// exact defect the Permissions tab was carrying until today.

import { createLogger } from '@clawboo/logger'
import type { Request, Response } from 'express'

import { getRegistry } from '../lib/agentSource'
import { loadAgentConfig, saveAgentConfig } from '../lib/runtimes/native/agentConfigStore'
import { getDb } from '../lib/db'
import { redactValue } from '../lib/redact'

const log = createLogger('native-shell')

async function nativeAgentOr404(
  agentId: string,
  res: Response,
): Promise<ReturnType<typeof loadAgentConfig> | null> {
  const agent = await getRegistry().source.getAgent(agentId)
  if (!agent) {
    res.status(404).json({ error: 'agent not found' })
    return null
  }
  if (agent.runtime !== 'clawboo-native') {
    // Named rather than silently ignored: an OpenClaw Boo's shell is governed by
    // its Gateway policy, and pretending this switch applied to it would be a
    // control that changes nothing.
    res
      .status(400)
      .json({ error: 'only a clawboo-native Boo has this switch', runtime: agent.runtime })
    return null
  }
  const config = loadAgentConfig(getDb(), agentId)
  if (!config) {
    res.status(404).json({ error: 'native agent config not found' })
    return null
  }
  return config
}

// GET /api/agents/:agentId/shell
export async function nativeShellGET(req: Request, res: Response): Promise<void> {
  try {
    const agentId = (req.params['agentId'] as string | undefined) ?? ''
    const config = await nativeAgentOr404(agentId, res)
    if (!config) return
    // Absent reads as off, which is what the runtime does with it.
    res.json({ ok: true, enabled: config.tools.shell === true })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/agents/:agentId/shell { enabled: boolean }
export async function nativeShellPOST(req: Request, res: Response): Promise<void> {
  try {
    const agentId = (req.params['agentId'] as string | undefined) ?? ''
    const body = req.body as { enabled?: unknown } | undefined
    if (typeof body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false' })
      return
    }

    const config = await nativeAgentOr404(agentId, res)
    if (!config) return

    saveAgentConfig(getDb(), {
      ...config,
      // Spread the whole tools record: it also carries memory, tasks, teamchat
      // and the reserved custom list, and rebuilding it from the fields this
      // route knows about would silently drop the ones it does not.
      tools: { ...config.tools, shell: body.enabled },
      updatedAt: Date.now(),
    })
    log.info({ agentId, enabled: body.enabled }, 'native shell switch changed')

    // Read back rather than echoing the request. The caller is being told what
    // is stored, not what it asked for.
    const after = loadAgentConfig(getDb(), agentId)
    res.json({ ok: true, enabled: after?.tools.shell === true })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
