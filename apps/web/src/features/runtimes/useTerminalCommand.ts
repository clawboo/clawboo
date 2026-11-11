import { useEffect, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

/** A runtime whose terminal command a page may show a person. */
export type TerminalTool = 'openclaw' | 'codex'

async function readCommand(tool: TerminalTool): Promise<string | null> {
  if (tool === 'openclaw') {
    const res = await apiFetch('/api/system/status')
    if (!res.ok) return null
    const body = (await res.json()) as { openclaw?: { command?: unknown } }
    return typeof body.openclaw?.command === 'string' ? body.openclaw.command : null
  }
  const res = await apiFetch('/api/runtimes')
  if (!res.ok) return null
  const body = (await res.json()) as { runtimes?: { id?: unknown; terminalCommand?: unknown }[] }
  const row = body.runtimes?.find((r) => r.id === tool)
  return typeof row?.terminalCommand === 'string' ? row.terminalCommand : null
}

/**
 * How a person types `tool` in their own terminal, as the server reports it:
 * the full path of the launcher when Clawboo installed the runtime into its
 * runtimes folder (which is not on their PATH), else the bare name. Read each
 * time a component that shows it mounts (an install may have happened since);
 * the bare name until it arrives, or when the read fails.
 */
export function useTerminalCommand(tool: TerminalTool): string {
  const [command, setCommand] = useState<string>(tool)
  useEffect(() => {
    let live = true
    readCommand(tool)
      .then((c) => {
        if (live && c) setCommand(c)
      })
      .catch(() => {
        // Keep the bare name.
      })
    return () => {
      live = false
    }
  }, [tool])
  return command
}

/** `command` with its leading bare tool name replaced by `name`. */
export function withTerminalName(command: string, tool: TerminalTool, name: string): string {
  return command.startsWith(`${tool} `) || command === tool
    ? `${name}${command.slice(tool.length)}`
    : command
}
