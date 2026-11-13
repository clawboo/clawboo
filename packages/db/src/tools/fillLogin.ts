// ─── fill_login: sign in with a saved login the agent never sees ────────────
// The descriptor lives here with the other tool definitions; what it does lives
// in the server, which owns the vault and the agent's browser, and passes it in.
// The executor gets only the site and returns only the server's outcome text.

import { z } from 'zod'

import type { ToolDescriptor } from './types'

export const FILL_LOGIN_TOOL_NAME = 'fill_login'

export function createFillLoginTool(fill: (site: string) => Promise<string>): ToolDescriptor {
  return {
    name: FILL_LOGIN_TOOL_NAME,
    description:
      'Sign in to a website in your own browser with a login a person saved for you. ' +
      "First open the site's sign-in page in your browser, then call this with the site, " +
      'for example example.com. Clawboo fills the username, password and any one-time code ' +
      'straight into the page. They are not in this answer; do not read them back from the page. ' +
      'It answers filled, no saved login, needs you (a CAPTCHA, passkey or card check only a ' +
      'person can do), or refused with what to do instead. After filled, submit the form.',
    inputSchema: z.object({ site: z.string().min(1).max(2_048) }),
    owner: 'core',
    risk: 'safe',
    readOnly: false,
    executor: async (args) => fill(String(args['site'] ?? '')),
  }
}
