// ─── Connection-open counters ────────────────────────────────────────────────
// Two monotonic, process-lifetime counters. They exist so a test can assert the
// structural invariant this package's biggest performance property rests on: a
// request-serving process opens ONE SQLite connection and bootstraps the schema
// ONCE, however many requests it serves.
//
// Deliberately production code, not test scaffolding — there is no portable
// alternative seam. `/proc/self/fd` does not exist on macOS;
// `process.getActiveResourcesInfo()` never lists a better-sqlite3 handle (a
// synchronous native object, not a libuv handle); and module mocking cannot see
// through the bundled `dist` that apps/web actually resolves. Two `let`s and two
// `+= 1` on a path that already does a filesystem mkdir and a native DB open cost
// nothing measurable, and they are useful on their own: a rising
// `connectionsOpened` on a steady-state server IS the file-descriptor-leak signal.

let connectionsOpened = 0
let schemaBootstraps = 0

/** @internal — called by `openDb`. */
export function noteConnectionOpened(): void {
  connectionsOpened += 1
}

/** @internal — called by `ensureSchema`. */
export function noteSchemaBootstrap(): void {
  schemaBootstraps += 1
}

/**
 * Connections opened and schema bootstraps applied by this module instance since
 * process start. Monotonic — never decremented on close, because the regression
 * being guarded is "a new connection per request", which shows up as a RISING
 * `connectionsOpened` under a read burst, not as a nonzero net count.
 */
export function dbOpenStats(): { connectionsOpened: number; schemaBootstraps: number } {
  return { connectionsOpened, schemaBootstraps }
}
