// Teach the control client which URL prefix this page is served under, BEFORE any
// module that might issue a request is evaluated.
//
// The bundle ships prebuilt through npm, so the prefix cannot be baked in at build
// time: the same `dist/ui` has to work at `/` and at `/clawboo/`. The server
// templates the answer into the shell it serves (`window.__CLAWBOO_BASE__`), and
// this module hands it to `setApiBase` so every `apiUrl`/`apiFetch` call resolves
// against it.
//
// Import it FIRST in main.tsx. ES module evaluation is depth-first in import
// order, so a first-position import runs before the rest of the graph, which is
// what guarantees no request is built against the default empty base.
//
// With the global absent (dev, or an older server serving a newer bundle) nothing
// is called and the client keeps its same-origin default, so the root install is
// byte-identical to before this existed.

import { setApiBase } from '@clawboo/control-client'

import { readInjectedBase } from './injectedBase'

const base = readInjectedBase()
if (base) setApiBase(base)
