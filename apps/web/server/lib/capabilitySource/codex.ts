// codex CapabilitySource. Clawboo attaches its own MCP servers to the Codex runs
// it starts, and Codex can use them only once it is signed in (`codex login`): a
// raw API key is not attached. So each server row reads ready after a sign-in
// and `manageable-but-pending-auth` before one, with the sign-in as its hint.
// Clawboo cannot switch these servers per agent, so a ready row carries
// `writable: false` and write() is refused. Built-ins are observe-only.

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { MCP_SERVER_NAMES } from '@clawboo/mcp'

import { isCodexLoggedIn } from '../runtimes/codexAuth'
import { buildRecord, builtinRollup, okStatus } from './helpers'

export interface CodexCapabilitySourceOptions {
  /** Whether Codex is signed in. Defaults to the cached `codex login status` probe. */
  isLoggedIn?: () => Promise<boolean>
}

export class CodexCapabilitySource implements CapabilitySource {
  readonly id = 'codex' as const
  private readonly isLoggedIn: () => Promise<boolean>

  constructor(opts: CodexCapabilitySourceOptions = {}) {
    this.isLoggedIn = opts.isLoggedIn ?? isCodexLoggedIn
  }

  async read(): Promise<CapabilityReadResult> {
    const loggedIn = await this.isLoggedIn()
    const records: CapabilityRecord[] = MCP_SERVER_NAMES.map((server) =>
      buildRecord({
        sourceId: 'codex',
        runtime: 'codex',
        scope: 'global',
        kind: 'connector',
        sourceKey: `mcp:clawboo-${server}`,
        origin: 'mcp-connector',
        manageability: 'external-write',
        name: `clawboo-${server}`,
        description: 'clawboo MCP server (Codex stdio attach)',
        available: true,
        // The auth affordance rides the record, so the panel never hardcodes it:
        // before a sign-in the row shows a disabled Enable carrying this hint.
        // After one there is nothing to switch, so the row offers no button.
        ...(loggedIn
          ? { status: 'ready' as const, writable: false }
          : {
              status: 'manageable-but-pending-auth' as const,
              hint: 'Sign in to Codex first: run `codex login`',
            }),
      }),
    )
    records.push(builtinRollup('codex', 'codex', 'Codex'))
    return { records, status: okStatus('codex') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    // Clawboo attaches these servers to every Codex run; there is no per-agent
    // switch to write.
    unsupported('codex', action.kind)
  }
}
