// The model an OpenClaw agent runs on, as openclaw.json configures it: the
// agent's own entry under `agents.list`, else `agents.defaults`. OpenClaw's
// Gateway reports no token usage, so clawboo prices those runs from their text,
// and this is the model that estimate is priced at. An `ollama/…` ref prices at
// $0. Null when the file, the agent or the field is missing, which prices at the
// shared default rate.

import fs from 'node:fs'
import path from 'node:path'

import { resolveStateDir } from '@clawboo/config'

/** A model setting is a ref string or `{ primary: ref, fallbacks?: [...] }`. */
function modelRef(value: unknown): string | null {
  const ref =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)['primary']
        : null
  return typeof ref === 'string' && ref.trim() ? ref.trim() : null
}

export function openclawAgentModel(
  agentId: string | null | undefined,
  stateDir: string = resolveStateDir(),
): string | null {
  let config: unknown
  try {
    config = JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8'))
  } catch {
    return null
  }
  const agents =
    config && typeof config === 'object' ? (config as Record<string, unknown>)['agents'] : null
  if (!agents || typeof agents !== 'object') return null
  const { list, defaults } = agents as { list?: unknown; defaults?: unknown }
  if (agentId && Array.isArray(list)) {
    const own = list.find(
      (e): e is Record<string, unknown> =>
        !!e && typeof e === 'object' && (e as Record<string, unknown>)['id'] === agentId,
    )
    const ownModel = modelRef(own?.['model'])
    if (ownModel) return ownModel
  }
  return defaults && typeof defaults === 'object'
    ? modelRef((defaults as Record<string, unknown>)['model'])
    : null
}
