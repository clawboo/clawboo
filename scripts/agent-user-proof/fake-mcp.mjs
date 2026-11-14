// A stand-in MCP stdio server with local reach: one tool, `whoami`, that says
// which user it runs as and whether it can read Clawboo's private files.
import fs from 'node:fs'

const probe = (p) => {
  if (!p) return 'unset'
  try {
    fs.readFileSync(p)
    return 'readable'
  } catch (e) {
    return e.code || 'other'
  }
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    let result
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      }
    } else if (msg.method === 'tools/list') {
      result = {
        tools: [{ name: 'whoami', description: 'who am I', inputSchema: { type: 'object' } }],
      }
    } else if (msg.method === 'tools/call') {
      const text = JSON.stringify({
        uid: process.getuid(),
        db: probe(process.env.PROOF_DB),
        key: probe(process.env.PROOF_KEY),
        vault: probe(process.env.PROOF_VAULT),
      })
      result = { content: [{ type: 'text', text }] }
    } else {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
})
