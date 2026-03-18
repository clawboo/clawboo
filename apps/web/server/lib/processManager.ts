import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export interface GatewayPidInfo {
  pid: number
  port: number
  startedAt: number
}

export function getGatewayPidPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'gateway.pid')
}

export function readGatewayPid(): GatewayPidInfo | null {
  try {
    const raw = fs.readFileSync(getGatewayPidPath(), 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    const pid = data['pid']
    const port = data['port']
    const startedAt = data['startedAt']
    if (
      typeof pid !== 'number' ||
      pid <= 0 ||
      typeof port !== 'number' ||
      port <= 0 ||
      typeof startedAt !== 'number' ||
      startedAt <= 0
    ) {
      return null
    }
    return { pid, port, startedAt }
  } catch {
    return null
  }
}

export function writeGatewayPid(pid: number, port: number): void {
  const pidPath = getGatewayPidPath()
  fs.mkdirSync(path.dirname(pidPath), { recursive: true })
  fs.writeFileSync(pidPath, JSON.stringify({ pid, port, startedAt: Date.now() }, null, 2), 'utf8')
}

export function removeGatewayPid(): void {
  try {
    fs.unlinkSync(getGatewayPidPath())
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return
    throw err
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function probeGatewayPort(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return true
  } catch {
    return false
  }
}

export function findProcessByPort(port: number): number | null {
  try {
    const output = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
    const firstLine = output.trim().split('\n')[0]
    const pid = parseInt(firstLine, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
