// Node's compiled-code cache is for this server, not for what it starts.
//
// The launcher sets NODE_COMPILE_CACHE so Node keeps its compiled copy of the
// server between starts (see the CLI's compileCacheEnv). Node reads the variable
// when the process starts, so the cache stays on after it is gone from the
// environment. Left in place, every child the server spawns would inherit it: an
// agent's runtime, a task's test command, npm during an update. Each would write
// code cache for every module it loads, keyed by its absolute path, into the data
// folder, and a new task checkout is a new set of paths, so the folder would only
// grow. So it is taken out of this process's environment on load, which happens
// before anything is spawned, and handed back only to this server's own successor
// on an in-app restart (see selfRestart).

const captured = process.env['NODE_COMPILE_CACHE']
delete process.env['NODE_COMPILE_CACHE']

/** The compile cache this server was started with, for its own successor; {} when none. */
export function compileCacheEnvForSuccessor(): NodeJS.ProcessEnv {
  return captured ? { NODE_COMPILE_CACHE: captured } : {}
}
