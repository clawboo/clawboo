// A desktop driver types into the agent's browser, so it runs only where that
// browser runs as the agent's own OS user.

import { describe, expect, it } from 'vitest'

import {
  desktopDriverRefusal,
  desktopDriverToolRefusal,
  refusedDriverToolKind,
} from '../driverPolicy'

describe('desktopDriverRefusal', () => {
  it('refuses without agents on their own OS user, and says why', () => {
    expect(desktopDriverRefusal('Cua Driver', false)).toMatch(
      /Cua Driver needs agents to run as their own OS user \(CLAWBOO_AGENT_USER\)/,
    )
    expect(desktopDriverRefusal('Cua Driver', true)).toBeNull()
  })

  it('reads the setting from the environment by default', () => {
    const prev = process.env['CLAWBOO_AGENT_USER']
    delete process.env['CLAWBOO_AGENT_USER']
    try {
      expect(desktopDriverRefusal('Cua Driver')).not.toBeNull()
    } finally {
      if (prev !== undefined) process.env['CLAWBOO_AGENT_USER'] = prev
    }
  })
})

// Cua Driver 0.38.0's own tool list on Linux (62 base tools and 4 for Linux),
// from `.github/scripts/cua-driver-mcp-compat/expected-tools.json` at the tag
// cua-driver-rs-v0.38.0.
const CUA_DRIVER_0_38_0_LINUX = [
  'bring_to_front',
  'browser_click',
  'browser_dialog',
  'browser_download',
  'browser_navigate',
  'browser_pointer',
  'browser_prepare',
  'browser_select',
  'browser_set_input_files',
  'browser_type',
  'check_for_update',
  'check_permissions',
  'click',
  'clipboard_read',
  'clipboard_write',
  'double_click',
  'drag',
  'end_session',
  'escalate_session',
  'get_accessibility_tree',
  'get_agent_cursor_state',
  'get_browser_state',
  'get_config',
  'get_cursor_position',
  'get_desktop_state',
  'get_guide',
  'get_recording_state',
  'get_screen_size',
  'get_session',
  'get_session_state',
  'get_window_state',
  'health_report',
  'hotkey',
  'install_extension',
  'install_ffmpeg',
  'invoke_menu',
  'kill_app',
  'launch_app',
  'list_apps',
  'list_sessions',
  'list_windows',
  'move_cursor',
  'page',
  'parse_visual_regions',
  'press_key',
  'replay_trajectory',
  'right_click',
  'run_script',
  'run_steps',
  'scroll',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_theme',
  'set_config',
  'set_value',
  'set_window_frame',
  'start_recording',
  'start_session',
  'stop_recording',
  'type_text',
  'verify_state',
  'zoom',
  'mouse_button_down',
  'mouse_button_up',
  'mouse_drag',
  'parallel_mouse_drag',
]

describe('refusedDriverToolKind', () => {
  it("refuses exactly 0.38.0's browser, scripting, install and settings tools", () => {
    expect(CUA_DRIVER_0_38_0_LINUX).toHaveLength(66)
    const refused = Object.fromEntries(
      CUA_DRIVER_0_38_0_LINUX.map((t) => [t, refusedDriverToolKind(t)] as const).filter(
        ([, kind]) => kind !== null,
      ),
    )
    expect(refused).toEqual({
      browser_click: 'browser',
      browser_dialog: 'browser',
      browser_download: 'browser',
      browser_navigate: 'browser',
      browser_pointer: 'browser',
      browser_prepare: 'browser',
      browser_select: 'browser',
      browser_set_input_files: 'browser',
      browser_type: 'browser',
      get_browser_state: 'browser',
      page: 'browser',
      run_script: 'scripting',
      run_steps: 'scripting',
      replay_trajectory: 'scripting',
      install_extension: 'install',
      install_ffmpeg: 'install',
      check_for_update: 'install',
      get_config: 'config',
      set_config: 'config',
    })
  })

  it('refuses a new tool of those families in another release, by the words in its name', () => {
    for (const [name, kind] of [
      ['browser_evaluate', 'browser'],
      ['open_tab', 'browser'],
      ['Run_JavaScript', 'scripting'],
      ['execute_shell_command', 'scripting'],
      ['install_plugin', 'install'],
      ['self_update', 'install'],
      ['reset_settings', 'config'],
      // camelCase and joined words, as another release might spell them.
      ['browserNavigate', 'browser'],
      ['runScript', 'scripting'],
      ['executeJavascript', 'scripting'],
      ['pageEval', 'browser'],
      ['webbrowser_open', 'browser'],
      ['run_applescript', 'scripting'],
      ['evaluate', 'scripting'],
      ['open_url', 'browser'],
      ['setConfig', 'config'],
      ['CDPConnect', 'browser'],
    ] as const) {
      expect(refusedDriverToolKind(name)).toBe(kind)
    }
    expect(refusedDriverToolKind('click')).toBeNull()
    expect(refusedDriverToolKind('get_window_state')).toBeNull()
    // A word that only contains a refused one is not refused for it.
    expect(refusedDriverToolKind('get_description')).toBeNull()
    expect(refusedDriverToolKind('typeText')).toBeNull()
  })

  it('says why, naming the driver and the tool', () => {
    expect(desktopDriverToolRefusal('Cua Driver', 'run_script')).toMatch(
      /Clawboo refuses Cua Driver's run_script: it never runs its scripting tools/,
    )
    expect(desktopDriverToolRefusal('Cua Driver', 'type_text')).toBeNull()
  })
})
