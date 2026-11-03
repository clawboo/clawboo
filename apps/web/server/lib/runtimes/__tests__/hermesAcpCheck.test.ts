// Whether a Hermes install has its ACP mode, asked of Hermes itself with
// `hermes acp --check`, in a throwaway home that is removed afterwards.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { classifyHermesAcpCheck, runHermesAcpCheck } from '../hermesAcpCheck'

describe('classifyHermesAcpCheck', () => {
  it('a passing check means ACP is there', () => {
    expect(classifyHermesAcpCheck(0, 'Hermes ACP check OK\n')).toBe(true)
  })

  it('missing ACP dependencies mean ACP is not there', () => {
    expect(
      classifyHermesAcpCheck(
        1,
        "ACP dependencies not installed.\nInstall them with:  pip install -e '.[acp]'\n",
      ),
    ).toBe(false)
  })

  it('a Hermes with no acp command at all has no ACP either', () => {
    expect(
      classifyHermesAcpCheck(
        2,
        "hermes: error: argument command: invalid choice: 'acp' (choose from 'chat', 'model')\n",
      ),
    ).toBe(false)
  })

  it('any other failure tells nothing', () => {
    expect(classifyHermesAcpCheck(1, 'Traceback (most recent call last):\n')).toBeNull()
    expect(classifyHermesAcpCheck(null, '')).toBeNull()
  })
})

describe('runHermesAcpCheck', () => {
  let dir: string
  let script: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-acp-check-test-'))
    script = path.join(dir, 'fake-hermes.cjs')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A fake `hermes` that records its argv and HERMES_HOME, seeds that home as
   *  Hermes does, then exits the given way. */
  function fakeHermes(body: string): void {
    writeFileSync(
      script,
      `const fs = require('node:fs')
const path = require('node:path')
const home = process.env.HERMES_HOME
fs.writeFileSync(path.join(home, 'SOUL.md'), 'seeded')
fs.writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ argv: process.argv.slice(2), home }))
${body}
`,
    )
  }
  const seen = (): { argv: string[]; home: string } =>
    JSON.parse(readFileSync(path.join(dir, 'seen.json'), 'utf8')) as {
      argv: string[]
      home: string
    }

  it('runs `acp --check` in a throwaway home it removes, and reads a pass', async () => {
    fakeHermes(`console.log('Hermes ACP check OK'); process.exit(0)`)
    await expect(runHermesAcpCheck({ command: process.execPath, args: [script] })).resolves.toBe(
      true,
    )
    const { argv, home } = seen()
    expect(argv).toEqual(['acp', '--check'])
    expect(home).not.toBe(process.env['HERMES_HOME'])
    expect(home).not.toBe(path.join(os.homedir(), '.hermes'))
    expect(existsSync(home)).toBe(false)
  })

  it('reads a Hermes without the acp extra as having no ACP', async () => {
    fakeHermes(`console.error('ACP dependencies not installed.'); process.exit(1)`)
    await expect(runHermesAcpCheck({ command: process.execPath, args: [script] })).resolves.toBe(
      false,
    )
    expect(existsSync(seen().home)).toBe(false)
  })

  it('a check that hangs is stopped and tells nothing', async () => {
    fakeHermes(`setInterval(() => undefined, 1000)`)
    await expect(
      runHermesAcpCheck({ command: process.execPath, args: [script], timeoutMs: 300 }),
    ).resolves.toBeNull()
  })

  it('a Hermes that cannot be started tells nothing', async () => {
    await expect(
      runHermesAcpCheck({ command: path.join(dir, 'no-such-hermes') }),
    ).resolves.toBeNull()
  })
})
