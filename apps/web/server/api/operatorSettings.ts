// The settings an administrator can pin, as the dashboard sees them.
//
//   GET /api/system/operator-settings        every key: its value, where it came
//                                            from, and whether it is pinned
//   PUT /api/system/operator-settings/:key   a person's own value, for the keys
//                                            the dashboard offers
//
// READ-ONLY FOR PINS. Nothing here writes the operator file. A pinned key is
// refused with 409, so the dashboard can say it is set by the administrator
// rather than appear to save a value that will never apply.

import type { Request, Response } from 'express'

import {
  OPERATOR_KEYS,
  PinnedSettingError,
  listEffectiveSettings,
  effectiveSetting,
  parseOperatorKey,
  saveUserSetting,
} from '../lib/operatorSettings'
import { redactValue } from '../lib/redact'

export function operatorSettingsGET(_req: Request, res: Response): void {
  try {
    res.json({ settings: listEffectiveSettings() })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

export function operatorSettingsPUT(req: Request, res: Response): void {
  const key = parseOperatorKey(String(req.params['key'] ?? ''))
  if (!key) {
    res.status(404).json({ error: 'Unknown setting.' })
    return
  }
  if (!OPERATOR_KEYS[key].userEditable) {
    res.status(403).json({ error: 'This setting can only be set by an administrator.' })
    return
  }
  const value = (req.body as { value?: unknown } | undefined)?.value
  // Only flags are offered to a person today. A new editable kind adds its
  // own check here.
  if (OPERATOR_KEYS[key].kind !== 'flag' || typeof value !== 'boolean') {
    res.status(400).json({ error: 'value must be true or false.' })
    return
  }
  try {
    saveUserSetting(key, value)
    res.json({ setting: effectiveSetting(key) })
  } catch (err) {
    if (err instanceof PinnedSettingError) {
      res.status(409).json({ error: err.message, setting: effectiveSetting(key) })
      return
    }
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
