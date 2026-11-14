// A malformed JSON body is answered without its text, and printed nowhere.

import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { jsonBodyErrors } from '../jsonBodyErrors'

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

describe('jsonBodyErrors', () => {
  it('answers a malformed body with a plain 400 and prints none of it', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = express()
    app.use(express.json())
    app.use(jsonBodyErrors)
    app.post('/x', (_req, res) => {
      res.json({ ok: true })
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server!.once('listening', r))
    const { port } = server.address() as AddressInfo
    const secret = 'Hunter2-not-json-secret'
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"password":${secret}}`,
    })
    const text = await res.text()
    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'invalid_json' })
    expect(text).not.toContain(secret)
    expect(JSON.stringify(printed.mock.calls)).not.toContain(secret)
  })
})
