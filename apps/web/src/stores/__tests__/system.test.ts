import { describe, it, expect, beforeEach } from 'vitest'
import { useSystemStore } from '../system'
import type { SystemInfo } from '../system'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSystemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    node: {
      version: 'v22.12.0',
      major: 22,
      sufficient: true,
      path: '/usr/local/bin/node',
    },
    openclaw: {
      installed: true,
      version: '0.3.2',
      path: '/usr/local/bin/openclaw',
      stateDir: '/Users/test/.openclaw',
      configExists: true,
      envExists: true,
    },
    gateway: {
      running: false,
      port: 18789,
      pid: null,
      managedByClawboo: false,
      uptimeMs: null,
    },
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useSystemStore', () => {
  beforeEach(() => {
    useSystemStore.getState().reset()
  })

  it('starts with null info and idle statuses', () => {
    const state = useSystemStore.getState()
    expect(state.info).toBeNull()
    expect(state.detecting).toBe(false)
    expect(state.installStatus).toBe('idle')
    expect(state.installLog).toEqual([])
    expect(state.gatewayControlStatus).toBe('idle')
    expect(state.gatewayLog).toEqual([])
  })

  // ── setInfo ────────────────────────────────────────────────────────────

  describe('setInfo', () => {
    it('sets system info', () => {
      const info = makeSystemInfo()
      useSystemStore.getState().setInfo(info)
      expect(useSystemStore.getState().info).toEqual(info)
    })

    it('replaces existing info', () => {
      useSystemStore.getState().setInfo(makeSystemInfo())
      const updated = makeSystemInfo({
        gateway: {
          running: true,
          port: 18789,
          pid: 1234,
          managedByClawboo: true,
          uptimeMs: 5000,
        },
      })
      useSystemStore.getState().setInfo(updated)
      expect(useSystemStore.getState().info!.gateway.running).toBe(true)
    })
  })

  // ── setDetecting ───────────────────────────────────────────────────────

  describe('setDetecting', () => {
    it('sets detecting to true', () => {
      useSystemStore.getState().setDetecting(true)
      expect(useSystemStore.getState().detecting).toBe(true)
    })

    it('sets detecting to false', () => {
      useSystemStore.setState({ detecting: true })
      useSystemStore.getState().setDetecting(false)
      expect(useSystemStore.getState().detecting).toBe(false)
    })
  })

  // ── setInstallStatus ───────────────────────────────────────────────────

  describe('setInstallStatus', () => {
    it('transitions through install lifecycle', () => {
      useSystemStore.getState().setInstallStatus('installing')
      expect(useSystemStore.getState().installStatus).toBe('installing')

      useSystemStore.getState().setInstallStatus('success')
      expect(useSystemStore.getState().installStatus).toBe('success')
    })

    it('transitions to error', () => {
      useSystemStore.getState().setInstallStatus('installing')
      useSystemStore.getState().setInstallStatus('error')
      expect(useSystemStore.getState().installStatus).toBe('error')
    })
  })

  // ── appendInstallLog / clearInstallLog ─────────────────────────────────

  describe('appendInstallLog', () => {
    it('appends a line to install log', () => {
      useSystemStore.getState().appendInstallLog('Installing...')
      expect(useSystemStore.getState().installLog).toEqual(['Installing...'])
    })

    it('appends multiple lines in order', () => {
      useSystemStore.getState().appendInstallLog('line 1')
      useSystemStore.getState().appendInstallLog('line 2')
      useSystemStore.getState().appendInstallLog('line 3')
      expect(useSystemStore.getState().installLog).toEqual(['line 1', 'line 2', 'line 3'])
    })
  })

  describe('clearInstallLog', () => {
    it('empties the install log array', () => {
      useSystemStore.setState({ installLog: ['a', 'b', 'c'] })
      useSystemStore.getState().clearInstallLog()
      expect(useSystemStore.getState().installLog).toEqual([])
    })
  })

  // ── setGatewayControlStatus ────────────────────────────────────────────

  describe('setGatewayControlStatus', () => {
    it('sets gateway control status', () => {
      useSystemStore.getState().setGatewayControlStatus('starting')
      expect(useSystemStore.getState().gatewayControlStatus).toBe('starting')
    })

    it('transitions through gateway lifecycle', () => {
      useSystemStore.getState().setGatewayControlStatus('starting')
      useSystemStore.getState().setGatewayControlStatus('running')
      expect(useSystemStore.getState().gatewayControlStatus).toBe('running')
    })
  })

  // ── appendGatewayLog / clearGatewayLog ─────────────────────────────────

  describe('appendGatewayLog', () => {
    it('appends a line to gateway log', () => {
      useSystemStore.getState().appendGatewayLog('Starting...')
      expect(useSystemStore.getState().gatewayLog).toEqual(['Starting...'])
    })

    it('appends multiple lines in order', () => {
      useSystemStore.getState().appendGatewayLog('line 1')
      useSystemStore.getState().appendGatewayLog('line 2')
      expect(useSystemStore.getState().gatewayLog).toEqual(['line 1', 'line 2'])
    })
  })

  describe('clearGatewayLog', () => {
    it('empties the gateway log array', () => {
      useSystemStore.setState({ gatewayLog: ['x', 'y'] })
      useSystemStore.getState().clearGatewayLog()
      expect(useSystemStore.getState().gatewayLog).toEqual([])
    })
  })

  // ── reset ──────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('resets all state to initial values', () => {
      useSystemStore.setState({
        info: makeSystemInfo(),
        detecting: true,
        installStatus: 'success',
        installLog: ['a', 'b'],
        gatewayControlStatus: 'running',
        gatewayLog: ['x'],
      })

      useSystemStore.getState().reset()

      const state = useSystemStore.getState()
      expect(state.info).toBeNull()
      expect(state.detecting).toBe(false)
      expect(state.installStatus).toBe('idle')
      expect(state.installLog).toEqual([])
      expect(state.gatewayControlStatus).toBe('idle')
      expect(state.gatewayLog).toEqual([])
    })
  })
})
