// GET and PUT /api/system/operator-settings: what the dashboard is told, and
// that a pinned setting cannot be changed from it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { resetOperatorSettings } from '../../lib/operatorSettings'
import { operatorSettingsGET, operatorSettingsPUT } from '../operatorSettings'

function call(
  handler: (req: Request, res: Response) => void,
  req: { params?: Record<string, string>; body?: unknown },
): { status: number; body: Record<string, unknown> } {
  const out = { status: 200, body: {} as Record<string, unknown> }
  const res = {
    status(code: number) {
      out.status = code
      return res
    },
    json(body: Record<string, unknown>) {
      out.body = body
      return res
    },
  } as unknown as Response
  handler({ params: req.params ?? {}, body: req.body } as unknown as Request, res)
  return out
}

describe('/api/system/operator-settings', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-operator-api-'))
    vi.stubEnv('CLAWBOO_HOME', home)
    resetOperatorSettings()
    resetDb()
    getDb()
  })
  afterEach(() => {
    resetDb()
    resetOperatorSettings()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('lists every key with its value, where it came from and whether it is pinned', () => {
    writeFileSync(path.join(home, 'operator.json'), '{ "disableSelfUpdate": true }')
    const { status, body } = call(operatorSettingsGET, {})
    expect(status).toBe(200)
    expect(body['settings']).toEqual([
      {
        key: 'disableSelfUpdate',
        value: true,
        source: 'file',
        pinned: true,
        userEditable: false,
        env: 'CLAWBOO_DISABLE_SELF_UPDATE',
      },
      {
        key: 'disableBrowserAutostart',
        value: false,
        source: 'default',
        pinned: false,
        userEditable: true,
        env: 'CLAWBOO_DISABLE_BROWSER_AUTOSTART',
      },
      {
        key: 'catalogIndexUrl',
        value: null,
        source: 'default',
        pinned: false,
        userEditable: false,
        env: 'CLAWBOO_CATALOG_INDEX_URL',
      },
    ])
  })

  it("saves a person's own value", () => {
    const { status, body } = call(operatorSettingsPUT, {
      params: { key: 'disableBrowserAutostart' },
      body: { value: true },
    })
    expect(status).toBe(200)
    expect(body['setting']).toMatchObject({ value: true, source: 'user', pinned: false })
  })

  it('refuses a pinned setting with 409, and reports the pinned value', () => {
    vi.stubEnv('CLAWBOO_DISABLE_BROWSER_AUTOSTART', '1')
    const { status, body } = call(operatorSettingsPUT, {
      params: { key: 'disableBrowserAutostart' },
      body: { value: false },
    })
    expect(status).toBe(409)
    expect(body['error']).toMatch(/administrator/)
    expect(body['setting']).toMatchObject({ value: true, source: 'environment', pinned: true })
  })

  it('refuses a key only an administrator sets with 403', () => {
    const { status } = call(operatorSettingsPUT, {
      params: { key: 'disableSelfUpdate' },
      body: { value: true },
    })
    expect(status).toBe(403)
  })

  it('refuses an unknown key with 404 and a non-boolean value with 400', () => {
    expect(
      call(operatorSettingsPUT, { params: { key: 'nope' }, body: { value: true } }).status,
    ).toBe(404)
    expect(
      call(operatorSettingsPUT, {
        params: { key: 'disableBrowserAutostart' },
        body: { value: 'yes' },
      }).status,
    ).toBe(400)
  })
})
