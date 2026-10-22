// What the update chip says when `npm install -g clawboo@latest` fails. The
// samples marked "captured" are real npm 10 output; the others follow npm's
// documented error-block format.

import { describe, expect, it } from 'vitest'

import { summarizeNpmFailure } from '../npmFailure'

// Captured: npm launched from a directory that had been deleted (exit 7). This
// is what the in-app update hit after the first update replaced the package
// folder the server was running in.
const DELETED_CWD = `/Users/x/.nvm/versions/node/v22.23.2/lib/node_modules/npm/lib/cli/validate-engines.js:31
    throw err
    ^

Error: ENOENT: no such file or directory, uv_cwd
    at process.wrappedCwd (node:internal/bootstrap/switches/does_own_process_state:142:28)
    at new Config (/Users/x/.nvm/versions/node/v22.23.2/lib/node_modules/npm/node_modules/@npmcli/config/lib/index.js:71:19)
  errno: -2,
  code: 'ENOENT',
  syscall: 'uv_cwd'
}

Node.js v22.23.2
`

// Captured: a version that does not exist.
const NO_SUCH_VERSION = `npm error code ETARGET
npm error notarget No matching version found for clawboo@0.0.0-does-not-exist.
npm error notarget In most cases you or one of your dependencies are requesting
npm error notarget a package version that doesn't exist.
npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-10-22T03_01_34_137Z-debug-0.log
`

const PERMISSION = `npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/clawboo
npm error errno -13
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/clawboo'
npm error
npm error The operation was rejected by your operating system.
`

const NATIVE_BUILD = `npm error code 1
npm error path /Users/x/.nvm/versions/node/v27.0.0/lib/node_modules/clawboo/node_modules/better-sqlite3
npm error command failed
npm error command sh -c prebuild-install || node-gyp rebuild --release
npm error prebuild-install warn install No prebuilt binaries found (target=27.0.0 runtime=node arch=arm64 libc= platform=darwin)
npm error gyp ERR! stack Error: \`gyp\` failed with exit code: 1
`

const OFFLINE = `npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error errno ENOTFOUND
npm error network request to https://registry.npmjs.org/clawboo failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
npm error network This is a problem related to network connectivity.
`

describe('summarizeNpmFailure', () => {
  it('names the deleted working directory from an uncaught npm crash', () => {
    expect(summarizeNpmFailure(DELETED_CWD)).toEqual({
      code: null,
      permission: false,
      detail: 'ENOENT: no such file or directory, uv_cwd.',
    })
  })

  it('drops the repeated heading from a version that does not exist', () => {
    expect(summarizeNpmFailure(NO_SUCH_VERSION)).toEqual({
      code: 'ETARGET',
      permission: false,
      detail: 'No matching version found for clawboo@0.0.0-does-not-exist.',
    })
  })

  it('flags a permission failure and keeps its Error line', () => {
    expect(summarizeNpmFailure(PERMISSION)).toEqual({
      code: 'EACCES',
      permission: true,
      detail: "EACCES: permission denied, mkdir '/usr/local/lib/node_modules/clawboo'.",
    })
  })

  it('names the package whose install script failed', () => {
    expect(summarizeNpmFailure(NATIVE_BUILD)).toEqual({
      code: '1',
      permission: false,
      detail: 'The install script for better-sqlite3 failed.',
    })
  })

  it('reports a network failure', () => {
    const { code, detail } = summarizeNpmFailure(OFFLINE)
    expect(code).toBe('ENOTFOUND')
    expect(detail).toBe(
      'Request to https://registry.npmjs.org/clawboo failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org.',
    )
  })

  it('handles npm 6 output and colour codes', () => {
    const old =
      '\x1b[31mnpm ERR!\x1b[39m code E404\n\x1b[31mnpm ERR!\x1b[39m 404 Not Found - GET https://registry.npmjs.org/nope\n'
    expect(summarizeNpmFailure(old)).toEqual({
      code: 'E404',
      permission: false,
      detail: '404 Not Found - GET https://registry.npmjs.org/nope.',
    })
  })

  it('caps a long reason', () => {
    const long = `npm error code X\nnpm error ${'a'.repeat(400)}\n`
    expect(summarizeNpmFailure(long).detail!.length).toBeLessThanOrEqual(121)
  })

  it('returns no detail when npm said nothing useful', () => {
    expect(summarizeNpmFailure('')).toEqual({ code: null, permission: false, detail: null })
  })
})
