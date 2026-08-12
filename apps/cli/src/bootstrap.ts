// The published `clawboo` bin entry.
//
// This file exists for ONE reason: the Node-version check has to happen before
// any dependency is loaded. `dist/index.js` `require()`s externalized packages
// at module scope, and at least one of them (`ora`) is ESM-only with no CJS
// entry. On Node 22.0-22.11, which predates `require(esm)`, that throws a raw
// `ERR_REQUIRE_ESM` the moment the file is loaded, long before Commander could
// register a `preAction` hook. A guard living inside the CLI can therefore never
// fire on the exact versions it exists to catch.
//
// So the bin points here instead. This module imports NOTHING but the local,
// dependency-free version check (tsup inlines it), runs on any Node that can
// parse it, and only then hands off to the real CLI.

import { nodeVersionError } from './node-version'

const versionError = nodeVersionError(process.version)
if (versionError) {
  // No chalk: it is a dependency, and loading one here would defeat the purpose.
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
