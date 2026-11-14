// The real server bundle, booted with agent isolation on, as the server user.
// Checks that it starts, that the agent host runs as the agent user, that an
// agent-user process reaches Clawboo's MCP servers over HTTP with an attach
// URL, and that stopping the server leaves no agent process.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const TOKEN = process.env.STUDIO_ACCESS_TOKEN
const PORT = 18790
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`)
}
const agentProcs = () =>
  (spawnSync('ps', ['-u', '10002', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

const server = spawn(process.execPath, ['/proof/server.js'], {
  env: { ...process.env, CLAWBOO_API_PORT: String(PORT), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', (d) => (logs += d))
server.stderr.on('data', (d) => (logs += d))

const base = `http://127.0.0.1:${PORT}`
let health = null
for (let i = 0; i < 120 && !health; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  try {
    const r = await fetch(`${base}/api/health`, { headers: { cookie: `clawboo_access=${TOKEN}` } })
    if (r.ok) health = await r.json()
  } catch {
    /* not up yet */
  }
  if (server.exitCode !== null) break
}
check('the server starts with agent isolation on', !!health, logs.slice(-3000))
const procs = agentProcs()
check(
  'the agent host runs as the agent user',
  procs.some((p) => p.includes('agent-host')),
  procs,
)

if (health) {
  const cfg = await fetch(`${base}/api/mcp/config`, {
    headers: { cookie: `clawboo_access=${TOKEN}` },
  })
  const text = await cfg.text()
  const url = (text.match(/http:\/\/127\.0\.0\.1:\d+\/api\/mcp\/tasks[^"'\s\\]*/) || [])[0]
  check('the server hands out an attach URL for the tasks server', !!url, text.slice(0, 500))
  if (url) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'proof', version: '1' },
      },
    })
    const script = `fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:${JSON.stringify(body)}}).then(async r=>{console.log(r.status);console.log((await r.text()).slice(0,300))}).catch(e=>console.log('ERR',e.message))`
    const r = spawnSync(
      'sudo',
      ['-n', '-u', 'clawboo-agent', '--', process.execPath, '-e', script],
      { encoding: 'utf8' },
    )
    const status = (r.stdout || '').split('\n')[0]
    check(
      'an agent-user process reaches the tasks MCP server over HTTP',
      status === '200' && /serverInfo/.test(r.stdout),
      r.stdout + r.stderr,
    )
    const dbPath = `${process.env.HOME}/.clawboo/clawboo.db`
    const db = spawnSync(
      'sudo',
      ['-n', '-u', 'clawboo-agent', '--', 'sqlite3', dbPath, '.tables'],
      { encoding: 'utf8' },
    )
    // Refused for the right reason: the database is there, sudo and sqlite3
    // ran, and sqlite3 could not open the file.
    check(
      'the same agent user cannot open the database',
      existsSync(dbPath) &&
        !db.error &&
        db.status !== 0 &&
        !/^sudo:/m.test(db.stderr) &&
        /unable to open database|permission denied/i.test(db.stderr),
      { exists: existsSync(dbPath), error: db.error?.message, out: db.stdout + db.stderr },
    )
  }
}

// A server that failed to start may have exited already; its 'exit' will not
// come again.
if (server.exitCode === null && server.signalCode === null) {
  const exited = new Promise((r) => server.once('exit', r))
  server.kill('SIGTERM')
  await exited
}
await new Promise((r) => setTimeout(r, 1000))
check('no agent process survives the server stopping', agentProcs().length === 0, agentProcs())
process.exit(failures)
