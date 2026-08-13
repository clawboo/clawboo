// The published `clawboo` bin entry.
//
// The Node-version check must run before any dependency loads. `dist/index.js`
// requires externalized packages at module scope, and one of them (`ora`) is
// ESM-only with no CJS entry, so on Node 22.0-22.11 — which predates
// `require(esm)` — loading it throws `ERR_REQUIRE_ESM` before Commander can
// register a `preAction` hook. A check inside the CLI cannot run on the versions
// it needs to catch.
//
// This module therefore imports nothing but the local, dependency-free version
// check (tsup inlines it) and hands off to the real CLI once the runtime is
// supported.

import { nodeVersionError } from './node-version'

const versionError = nodeVersionError(process.version)
if (versionError) {
  // Written with a raw escape rather than chalk: this path must load no dependency.
  process.stderr.write(`[31m✖ [39m${versionError}\n`)
  process.exit(1)
}

// Hand off to the real CLI.
//
// The specifier is assembled at runtime so the bundler cannot resolve it
// statically. A literal `require('./index')` is inlined by tsup, which would
// pull every dependency back into this file and reinstate the exact failure
// this bootstrap prevents. `dist/index.js` is emitted as its own entry and sits
// next to this file.
const cliEntry = ['.', 'index.js'].join('/')
module.require(cliEntry)
