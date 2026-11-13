// The agent host's entry point, bundled as `agent-host.js`.
//
// Two ways to start it, one protocol:
// - The server starts it through sudo as the agent user and talks over this
//   process's stdin and stdout. When stdin ends (the server went away), every
//   process it started is stopped and it exits.
// - A container launcher starts it as the agent user with
//   CLAWBOO_AGENT_HOST_SOCKET set. It listens on that Unix socket (mode 0660; the
//   launcher gives it the server's group) and serves each connection.
//
// It refuses to run as root: a host that is root would make every agent root.

import fs from 'node:fs'
import net from 'node:net'

import { serveConnection } from './host'

function refuse(message: string): never {
  process.stderr.write(`clawboo agent host: ${message}\n`)
  process.exit(1)
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  refuse('refusing to run as root. Start it as the agent user.')
}

// Files the host creates are the agent's alone unless a request asks otherwise.
process.umask(0o077)

const socketPath = process.env['CLAWBOO_AGENT_HOST_SOCKET']

if (socketPath) {
  // A socket left by a previous run is removed; anything else at that path is
  // not ours to replace.
  try {
    const st = fs.lstatSync(socketPath)
    if (!st.isSocket()) refuse(`${socketPath} exists and is not a socket`)
    fs.unlinkSync(socketPath)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
  const server = net.createServer((sock) => {
    serveConnection(sock, sock, { onEnd: () => sock.destroy() })
  })
  // 0660 from the start: the umask is narrowed only around the bind.
  const prev = process.umask(0o117)
  server.listen(socketPath, () => {
    process.umask(prev)
    fs.chmodSync(socketPath, 0o660)
    process.stderr.write(`clawboo agent host: listening on ${socketPath}\n`)
  })
  server.on('error', (err) => refuse(err.message))
  const stop = (): void => {
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} else {
  // Stay long enough after the server goes for the SIGKILL that follows each
  // SIGTERM (3 s later) to be sent.
  serveConnection(process.stdin, process.stdout, {
    onEnd: () => setTimeout(() => process.exit(0), 3_500),
  })
  // Ctrl-C in a terminal reaches the whole foreground group, the server included,
  // and the server stops the agents itself. Ignoring it here keeps the host alive
  // long enough to carry those stops out.
  process.on('SIGINT', () => {})
}
