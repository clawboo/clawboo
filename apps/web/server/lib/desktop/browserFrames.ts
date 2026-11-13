// A picture of what an agent's browser shows now, taken through the browser's
// own screenshot tool. Shared by the Browser panel's "capture" route and by the
// live view of an agent that has no display of its own (a Mac, a Windows
// machine, or Linux without the display tools).
//
// It NEVER starts a browser: `callIfRunning` answers null when the agent has
// none open, so watching never puts a window on anyone's screen.
//
// THE AGENT'S OWN GRANT DECIDES whether its browser may be photographed, even
// though a person is the one asking: a revoked grant must stay revoked.
//
// A LIVE frame must not leave a file behind. Playwright's tool saves every
// screenshot it takes to its output folder under a new name, so a live view
// taking one a second would fill the disk; given a file name, it writes that one
// file instead (and returns no picture), so the live view names one file in the
// browser's own working folder and reads it back. Chrome DevTools returns the
// picture without writing anything.

import fs from 'node:fs/promises'
import path from 'node:path'

import { connectorsByCategory } from '@clawboo/connector-catalog'
import { agents, isToolVisibleToAgent } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { agentReadFile } from '../agentUser/agentFs'
import { connectorInstanceIdForSlug } from '../capabilitySource/connectorIdentity'
import { callIfRunning, runningBrowserScratchDir } from '../connectors/agentBrowsers'
import { getLiveConnector } from '../connectors/supervisor'
import { getDb } from '../db'
import { newestTabForSourceAgent } from '../openclawSessionTabs'
import { captureOpenClawTab } from '../openclawTabCapture'

export interface BrowserFrame {
  /** Base64, no `data:` prefix. */
  data: string
  mimeType: string
  /** The tool that took it. */
  toolName: string
}

/** The one file a live view of a Playwright browser writes, over and over. */
export const LIVE_FRAME_FILE = '.clawboo-live-view.jpeg'

/** The largest live frame read back from disk. */
const MAX_LIVE_FRAME_BYTES = 8 * 1024 * 1024

/**
 * The screenshot tool, found by SUFFIX rather than named outright: Playwright
 * ships `browser_take_screenshot`, Chrome DevTools `take_screenshot`.
 */
const isScreenshotTool = (name: string): boolean => name.endsWith('take_screenshot')

async function readLiveFile(connectorId: string, agentId: string): Promise<Buffer | null> {
  const scratch = runningBrowserScratchDir(connectorId, agentId)
  if (!scratch) return null
  const file = path.join(scratch.dir, LIVE_FRAME_FILE)
  if (scratch.inAgentSpace) return agentReadFile(file, { maxBytes: MAX_LIVE_FRAME_BYTES })
  try {
    const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      const st = await handle.stat()
      if (!st.isFile() || st.size > MAX_LIVE_FRAME_BYTES) return null
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Take a picture of the agent's browser, or null when it has none open (or none
 * it may be photographed through). `live` takes it without leaving a file
 * behind, as a smaller JPEG.
 */
export async function captureAgentBrowserFrame(
  agentId: string,
  opts: { live: boolean },
): Promise<BrowserFrame | null> {
  for (const def of connectorsByCategory('browser')) {
    const connectorId = connectorInstanceIdForSlug(def.slug)
    const live = getLiveConnector(connectorId)
    if (!live) continue
    const shooter = live.descriptors.find((d) => isScreenshotTool(d.name))
    const rawName = shooter ? live.rawToolNames.get(shooter.name) : undefined
    if (!shooter || !rawName) continue
    if (!isToolVisibleToAgent(getDb(), shooter, { agentId, connectorId })) continue

    if (opts.live && rawName === 'browser_take_screenshot') {
      const result = await callIfRunning(connectorId, agentId, rawName, {
        type: 'jpeg',
        filename: LIVE_FRAME_FILE,
      }).catch(() => null)
      if (!result) continue
      const bytes = await readLiveFile(connectorId, agentId).catch(() => null)
      if (!bytes || bytes.length === 0) continue
      return { data: bytes.toString('base64'), mimeType: 'image/jpeg', toolName: shooter.name }
    }
    if (opts.live && rawName !== 'take_screenshot') {
      // A browser this code does not know how to photograph without a file left
      // behind is not filmed: a live view would fill its folder.
      continue
    }
    const args = opts.live ? { format: 'jpeg', quality: 70 } : {}
    const result = await callIfRunning(connectorId, agentId, rawName, args).catch(() => null)
    const first = result?.images?.[0]
    if (!first) continue
    return { data: first.data, mimeType: first.mimeType, toolName: shooter.name }
  }

  // OpenClaw agents browse in OpenClaw's own browser, which Clawboo does not
  // broker. OpenClaw stamps the owning session onto each tab it tracks, and that
  // stamp is the same string Clawboo builds for the agent, so the identity is
  // read, never inferred. Filed under the Clawboo row id.
  const agent = getDb()
    .select({ sourceAgentId: agents.sourceAgentId, runtime: agents.runtime })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (agent?.runtime === 'openclaw' && agent.sourceAgentId) {
    const tab = newestTabForSourceAgent(agent.sourceAgentId)
    if (tab) {
      const shot = await captureOpenClawTab(tab.targetId).catch(() => null)
      if (shot) return { data: shot.data, mimeType: shot.mimeType, toolName: 'openclaw__browser' }
    }
  }
  return null
}
