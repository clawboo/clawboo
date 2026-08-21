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

/** The prefix the server templated into the shell, or '' when served at the root. */
export function readInjectedBase(): string {
  const raw = (globalThis as { __CLAWBOO_BASE__?: unknown }).__CLAWBOO_BASE__
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '/') return ''
  // Defensive: the server normalizes before injecting, so this only guards a
  // hand-edited shell. Same shape the contract guarantees (leading slash, no
  // trailing slash) so `${base}/api/...` keeps exactly one slash.
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '')
}

const base = readInjectedBase()
if (base) setApiBase(base)
