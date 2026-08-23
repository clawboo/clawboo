// The two producers of a connector identity live in different files and nothing
// but this test would catch them drifting. If they disagree, the supervisor
// mints an owner grant under one id while the broker looks one up under another,
// and the only symptom is `no-grant` denials for a connector the graph shows as
// healthy.

import { describe, expect, it } from 'vitest'

import { ConnectorCapabilitySource } from '../connector'
import { connectorIdForRecord, connectorInstanceIdForSlug } from '../connectorIdentity'
import { connectorInstanceId } from '../../connectors/supervisor'

describe('connector identity', () => {
  it('the supervisor and the identity helper agree', () => {
    expect(connectorInstanceId('memory')).toBe(connectorInstanceIdForSlug('memory'))
  })

  it('the identity derived from a REAL source record matches the one grants are keyed on', async () => {
    // The load-bearing assertion, and it has to read the record the source
    // ACTUALLY emits. Hand-writing the field values would assert only that two
    // literals in this file agree, so changing `runtime` or `sourceKey` in
    // connector.ts would split the key silently and this test would still pass.
    const { connectConnector, resetConnectorsForTests } =
      await import('../../connectors/supervisor')
    const { createDb } = await import('@clawboo/db')
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { createRequire } = await import('node:module')

    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-identity-'))
    try {
      const db = createDb(path.join(dir, 'test.db'))
      const req = createRequire(path.join(process.cwd(), 'package.json'))
      const sdk = (s: string) => JSON.stringify(req.resolve(`@modelcontextprotocol/sdk/${s}`))
      const file = path.join(dir, 'server.cjs')
      writeFileSync(
        file,
        `const { Server } = require(${sdk('server/index.js')})
const { StdioServerTransport } = require(${sdk('server/stdio.js')})
const { ListToolsRequestSchema } = require(${sdk('types.js')})
const s = new Server({ name: 'x', version: '1.0.0' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
s.connect(new StdioServerTransport())
`,
      )

      await connectConnector(db, {
        slug: 'memory',
        displayName: 'Knowledge Graph Memory',
        provenance: 'curated',
        launch: {
          transport: 'stdio',
          command: process.execPath,
          args: [file],
          pinnedVersion: '1.0.0',
        },
        egressAllow: [],
        trifecta: { readsPrivateData: false, ingestsUntrustedContent: false, canEgress: false },
      })

      const { records } = await new ConnectorCapabilitySource().read()
      expect(records).toHaveLength(1)
      expect(connectorIdForRecord(records[0]!)).toBe(connectorInstanceId('memory'))

      await resetConnectorsForTests()
      // Windows will not unlink a file with an open handle, so the database has
      // to be closed before the directory goes.
      db.$client.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns null for a record that is not a connector', () => {
    expect(
      connectorIdForRecord({
        kind: 'skill',
        id: 'native:x',
        runtime: 'r',
        sourceKey: 'k',
      } as never),
    ).toBeNull()
  })
})
