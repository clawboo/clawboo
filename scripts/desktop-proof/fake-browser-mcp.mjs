// A stand-in browser connector: an MCP stdio server, started the way Clawboo
// starts an agent's browser (with a `--user-data-dir` profile of its own), with
// one tool, `browser_open`, that opens Chromium on whatever display it was
// given and says which user it runs as and where it drew.
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const profile = argv[argv.indexOf('--user-data-dir') + 1]
const PAGE =
  'data:text/html,<body style="margin:0;background:%2311ee66;font:64px sans-serif">Agent display</body>'
let chromium = null

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
        serverInfo: { name: 'fake-browser', version: '1' },
      }
    } else if (msg.method === 'tools/list') {
      result = {
        tools: [{ name: 'browser_open', description: 'open', inputSchema: { type: 'object' } }],
      }
    } else if (msg.method === 'tools/call') {
      if (!chromium) {
        chromium = spawn(
          'chromium',
          [
            '--no-sandbox',
            '--no-first-run',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            `--user-data-dir=${profile}`,
            '--window-position=0,0',
            '--window-size=1280,800',
            PAGE,
          ],
          { stdio: 'ignore' },
        )
      }
      const text = JSON.stringify({
        uid: process.getuid(),
        display: process.env.DISPLAY ?? null,
        xauthority: process.env.XAUTHORITY ?? null,
        profile,
      })
      result = { content: [{ type: 'text', text }] }
    } else {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
})
process.stdin.on('end', () => {
  chromium?.kill()
  process.exit(0)
})
